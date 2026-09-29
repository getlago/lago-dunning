function invoiceForIntent(intent, invoices) {
  return invoices.find((invoice) => invoice.id === intent.invoiceId)
    ?? invoices.find((invoice) => invoice.number === intent.invoiceNumber)
    ?? null;
}

function refContains(reference, number) {
  if (!reference || !number) return false;
  const normalized = (value) => String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized(reference).includes(normalized(number));
}

export function detectStripeIncidents({ customerId, lagoCustomerId, invoices, payments, cashTransactions, paymentIntents }) {
  const incidents = [];
  const customerInvoices = invoices.filter((invoice) => invoice.customerId === lagoCustomerId);
  const intentsByInvoice = new Map();
  for (const intent of paymentIntents) {
    const linkedPayment = payments.find((payment) => payment.providerPaymentId === intent.id);
    const invoice = invoiceForIntent(intent, customerInvoices)
      ?? customerInvoices.find((candidate) => candidate.id === linkedPayment?.invoiceId)
      ?? null;
    if (!invoice) continue;
    const rows = intentsByInvoice.get(invoice.id) ?? [];
    rows.push(intent);
    intentsByInvoice.set(invoice.id, rows);
    if (intent.invoiceNumber && intent.invoiceNumber !== invoice.number) {
      incidents.push(incident('stripe_stale_invoice_reference', 'warning', customerId, intent.id,
        `Stripe ${intent.id} names ${intent.invoiceNumber}, but Lago now names the invoice ${invoice.number}.`,
        { invoiceId: invoice.id, currentInvoiceNumber: invoice.number, stripeInvoiceNumber: intent.invoiceNumber }));
    }
  }

  for (const invoice of customerInvoices) {
    const invoicePayments = payments.filter((payment) => payment.invoiceId === invoice.id && payment.status === 'succeeded');
    const intents = intentsByInvoice.get(invoice.id) ?? [];
    const succeeded = intents.filter((intent) => intent.status === 'succeeded' || intent.amountReceivedCents >= intent.amountCents);
    const manual = invoicePayments.filter((payment) => !payment.providerPaymentId);
    const failed = intents.filter((intent) => ['canceled', 'requires_payment_method'].includes(intent.status));

    if (invoice.paymentStatus === 'succeeded' && manual.length && !succeeded.length) {
      incidents.push(incident('lago_manual_payment_without_stripe_settlement', failed.length ? 'critical' : 'warning', customerId, invoice.id,
        `${invoice.number} is paid in Lago by a manual payment, but no settled Stripe intent proves that Stripe cash was allocated.`,
        { invoiceId: invoice.id, invoiceNumber: invoice.number, manualPaymentIds: manual.map((p) => p.id), stripeIntentStatuses: intents.map((p) => ({ id: p.id, status: p.status })) }));
    }
    if (invoice.paymentStatus !== 'succeeded' && succeeded.length) {
      incidents.push(incident('stripe_settled_lago_unpaid', 'critical', customerId, invoice.id,
        `${invoice.number} settled in Stripe but is still ${invoice.paymentStatus} in Lago.`,
        { invoiceId: invoice.id, invoiceNumber: invoice.number, paymentIntentIds: succeeded.map((p) => p.id) }));
      const latestSuccessAt = succeeded.map((intent) => intent.settledAt ?? intent.createdAt).filter(Boolean).sort().at(-1);
      const lateFailures = failed.filter((intent) => {
        const failedAt = intent.canceledAt ?? intent.failedAt ?? intent.createdAt;
        return latestSuccessAt && failedAt > latestSuccessAt;
      });
      if (lateFailures.length) {
        incidents.push(incident('late_stripe_failure_after_settlement', 'critical', customerId, invoice.id,
          `${invoice.number} has settled Stripe evidence, but a later failed or canceled attempt left Lago ${invoice.paymentStatus}.`,
          { invoiceId: invoice.id, invoiceNumber: invoice.number, latestSuccessAt,
            successfulPaymentIntentIds: succeeded.map((p) => p.id),
            lateFailurePaymentIntents: lateFailures.map((p) => ({ id: p.id, status: p.status,
              failedAt: p.canceledAt ?? p.failedAt ?? p.createdAt })) }));
      }
    }
    if (invoice.paymentStatus !== 'succeeded' && invoice.remainingAmountCents > 0 && !intents.length) {
      incidents.push(incident('lago_invoice_missing_stripe_intent', 'warning', customerId, invoice.id,
        `${invoice.number} is open in Lago with no Stripe PaymentIntent available for cash-balance allocation.`,
        { invoiceId: invoice.id, invoiceNumber: invoice.number, remainingAmountCents: invoice.remainingAmountCents }));
    }
    if (succeeded.length > 1) {
      incidents.push(incident('duplicate_stripe_settlements', 'critical', customerId, invoice.id,
        `${invoice.number} has ${succeeded.length} successful Stripe intents.`,
        { invoiceId: invoice.id, invoiceNumber: invoice.number, paymentIntentIds: succeeded.map((p) => p.id) }));
    }
  }

  const intents = new Map(paymentIntents.map((intent) => [intent.id, intent]));
  const buckets = [];
  for (const transaction of [...cashTransactions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (transaction.type === 'funded' && transaction.amountCents > 0) {
      buckets.push({ transaction, remaining: transaction.amountCents });
      continue;
    }
    if (transaction.type !== 'applied_to_payment' || transaction.amountCents >= 0) continue;
    let amount = Math.abs(transaction.amountCents);
    const sources = [];
    for (const bucket of buckets) {
      if (!amount || bucket.remaining <= 0) continue;
      const used = Math.min(amount, bucket.remaining);
      bucket.remaining -= used;
      amount -= used;
      sources.push({ transaction: bucket.transaction, amountCents: used });
    }
    const intent = intents.get(transaction.paymentIntentId);
    const targetInvoice = intent ? invoiceForIntent(intent, customerInvoices) : null;
    const contradictory = sources.filter(({ transaction: source }) => {
      const referenced = customerInvoices.find((invoice) => refContains(source.reference, invoice.number));
      return referenced && targetInvoice && referenced.id !== targetInvoice.id;
    });
    if (contradictory.length) {
      incidents.push(incident('stripe_allocation_reference_mismatch', 'critical', customerId, transaction.id,
        `Stripe applied cash to ${targetInvoice.number}, but the incoming wire reference points to another Lago invoice.`,
        { cashTransactionId: transaction.id, paymentIntentId: intent?.id, targetInvoiceId: targetInvoice.id,
          sources: contradictory.map(({ transaction: source, amountCents }) => ({ id: source.id, reference: source.reference, amountCents })) }));
    }
    const oldSources = sources.filter(({ transaction: source }) => intent && source.createdAt < intent.createdAt);
    if (oldSources.length) {
      incidents.push(incident('stripe_old_cash_auto_applied', 'warning', customerId, transaction.id,
        `Stripe used cash received before ${targetInvoice?.number ?? intent?.id ?? 'this payment intent'} existed. Review the intended invoice before trusting the paid status.`,
        { cashTransactionId: transaction.id, paymentIntentId: intent?.id, targetInvoiceId: targetInvoice?.id,
          sourceTransactionIds: oldSources.map(({ transaction: source }) => source.id) }));
    }
  }

  const cashBalanceCents = cashTransactions.reduce((sum, transaction) => sum + transaction.amountCents, 0);
  if (cashBalanceCents > 0) {
    incidents.push(incident('stripe_unallocated_cash_balance', 'warning', customerId, customerId,
      `Stripe still holds unallocated customer cash.`, { cashBalanceCents, customerId }));
  }
  return incidents;
}

function incident(kind, severity, scope, externalId, summary, evidence) {
  return { id: `${kind}:${scope}:${externalId}`, kind, severity, scope, summary, evidence };
}
