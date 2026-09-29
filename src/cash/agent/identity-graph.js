import crypto from 'node:crypto';

const edgeId = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);

export function buildIdentityGraph({ contexts, identities, externalPayments, invoices = [] }) {
  const edges = [];
  const add = (edge) => edges.push({
    ...edge,
    id: `edge:${edgeId(edge.source, edge.sourceRecordId, edge.edgeType, edge.fromId, edge.toId)}`
  });

  for (const context of contexts) {
    const linkedCustomerId = context.lagoCustomerId ?? invoices.find((invoice) =>
      invoice.customerExternalSalesforceId === context.crmAccountId)?.customerId;
    if (linkedCustomerId) add({
      source: context.source, sourceRecordId: context.crmAccountId, edgeType: 'crm_to_lago_customer',
      fromType: 'crm_account', fromId: context.crmAccountId, toType: 'lago_customer', toId: linkedCustomerId,
      label: context.accountName, confidence: 100, verified: true,
      evidence: { accountName: context.accountName, ownerName: context.ownerName, linkedBy: context.lagoCustomerId ? 'salesforce_lago_customer_field' : 'lago_customer.external_salesforce_id' }
    });
    if (context.erpCustomerId) add({
      source: context.source, sourceRecordId: context.crmAccountId, edgeType: 'crm_to_erp_customer',
      fromType: 'crm_account', fromId: context.crmAccountId, toType: 'erp_customer', toId: context.erpCustomerId,
      label: context.accountName, confidence: 100, verified: true,
      evidence: { accountName: context.accountName }
    });
    if (context.parentCrmAccountId) add({
      source: context.source, sourceRecordId: context.crmAccountId, edgeType: 'subsidiary_to_parent',
      fromType: 'crm_account', fromId: context.crmAccountId, toType: 'crm_account', toId: context.parentCrmAccountId,
      label: context.parentName, confidence: 100, verified: true,
      evidence: { childName: context.accountName, parentName: context.parentName }
    });
    for (const alias of context.aliases ?? []) add({
      source: context.source, sourceRecordId: context.crmAccountId, edgeType: 'payer_alias',
      fromType: 'payer_name', fromId: alias.toLowerCase(), toType: 'crm_account', toId: context.crmAccountId,
      label: alias, confidence: 90, verified: false, evidence: { configuredAlias: alias }
    });
  }

  for (const identity of identities) add({
    source: 'human_confirmation', sourceRecordId: identity.fingerprint, edgeType: 'bank_account_to_lago_customer',
    fromType: 'bank_fingerprint', fromId: identity.fingerprint, toType: 'lago_customer', toId: identity.customerId,
    label: identity.label, confidence: 100, verified: true, evidence: { confirmedByReviewer: true }
  });

  for (const payment of externalPayments.filter((item) => item.originSystem !== 'lago' && item.customerId)) add({
    source: payment.provider, sourceRecordId: payment.providerPaymentId, edgeType: 'erp_payment_to_customer',
    fromType: 'erp_payment', fromId: payment.id, toType: 'erp_customer', toId: payment.customerId,
    label: payment.customerName, confidence: 100, verified: true,
    evidence: { reference: payment.reference, amountCents: payment.amountCents, currency: payment.currency }
  });

  return edges;
}

export function graphSummary(edges) {
  return {
    edges: edges.length,
    verified: edges.filter((edge) => edge.verified).length,
    crmToLago: edges.filter((edge) => edge.edgeType === 'crm_to_lago_customer').length,
    crmToErp: edges.filter((edge) => edge.edgeType === 'crm_to_erp_customer').length,
    confirmedBankAccounts: edges.filter((edge) => edge.edgeType === 'bank_account_to_lago_customer').length
  };
}
