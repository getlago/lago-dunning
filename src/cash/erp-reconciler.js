import { createHash } from 'node:crypto';

const stableId = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);

export function detectErpIncidents({ provider, payments, invoices, lagoPayments }) {
  const incidents = [];
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const invoiceByNumber = new Map(invoices.map((invoice) => [invoice.number, invoice]));

  for (const payment of payments) {
    if (payment.originSystem === 'lago') continue;
    const allocated = payment.allocations.reduce((sum, item) => sum + Number(item.amountCents ?? 0), 0);
    if (allocated + payment.unappliedAmountCents > payment.amountCents) {
      incidents.push(incident(provider, payment, 'erp_allocation_exceeds_payment', 'critical',
        `${provider} payment ${payment.providerPaymentId} allocates more than its total`, { allocated }));
    }
    if (!payment.allocations.length && payment.unappliedAmountCents > 0) {
      incidents.push(incident(provider, payment, 'erp_unapplied_payment', 'warning',
        `${provider} has an unapplied customer payment`, { unappliedAmountCents: payment.unappliedAmountCents }));
    }
    for (const allocation of payment.allocations) {
      const invoice = invoiceById.get(allocation.externalInvoiceId) ?? invoiceByNumber.get(allocation.invoiceNumber);
      if (!invoice) {
        incidents.push(incident(provider, payment, 'erp_invoice_not_mapped', 'warning',
          `${provider} payment references an invoice that cannot be mapped to Lago`, { allocation }));
        continue;
      }
      const settledInLago = invoice.paymentStatus === 'succeeded' || lagoPayments.some((candidate) =>
        candidate.invoiceId === invoice.id && candidate.status === 'succeeded');
      if (payment.status === 'voided' && settledInLago) {
        incidents.push(incident(provider, payment, 'erp_payment_voided_but_lago_paid', 'critical',
          `${provider} payment is voided while the Lago invoice is still paid`, { allocation, invoiceId: invoice.id }));
      } else if (payment.status !== 'voided' && !settledInLago) {
        incidents.push(incident(provider, payment, 'erp_payment_missing_in_lago', 'warning',
          `${provider} records payment but Lago does not`, { allocation, invoiceId: invoice.id }));
      }
    }
  }
  return incidents;
}
function incident(provider, payment, kind, severity, summary, evidence) {
  return {
    id: stableId(provider, payment.providerPaymentId, kind, JSON.stringify(evidence)),
    kind,
    severity,
    scope: `erp:${provider}`,
    summary,
    evidence: { providerPaymentId: payment.providerPaymentId, originSystem: payment.originSystem, ...evidence }
  };
}
