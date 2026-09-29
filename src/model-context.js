// Deliberate allowlist: no raw bank payloads, account numbers, references,
// credentials, customer email addresses, or reminder bodies enter model tools.
export const MODEL_CONTEXT_VERSION = 'customer-memory-v5';
export function moneyForModel(minorUnits, currency) {
  if(!Number.isSafeInteger(minorUnits)||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))return null;
  const format = new Intl.NumberFormat('en-GB', {style:'currency',currency});
  const decimals = format.resolvedOptions().maximumFractionDigits;
  const majorUnits = minorUnits / 10 ** decimals;
  return {currency, amount:majorUnits.toFixed(decimals), formatted:format.format(majorUnits)};
}
function totalsForModel(rows, amountOf) {
  const totals = new Map();
  for (const row of rows) {const amount=amountOf(row);if(moneyForModel(amount,row.currency))totals.set(row.currency,(totals.get(row.currency)??0)+amount);}
  return [...totals].map(([currency,amount])=>moneyForModel(amount,currency));
}
export function collectionForModel(collection) {
  if (!collection) return null;
  return {
    scope:'Overdue remaining balances only; excludes fully paid and not-yet-due invoices.',
    ready:collection.ready, held:collection.held, review:collection.review,
    materialityThreshold:collection.materialityThreshold?moneyForModel(collection.materialityThreshold.amountMinor,collection.materialityThreshold.currency):null,
    overdueTotals:totalsForModel(collection.rows,r=>r.amountCents),
    totalsByStatus:Object.fromEntries(['ready','held','review'].map(status=>[status,totalsForModel(collection.rows.filter(r=>r.status===status),r=>r.amountCents)])),
    rows:collection.rows.map(r=>({customerId:r.customerId,customerName:r.customerName,
      invoiceIds:r.invoiceIds,invoiceNumbers:r.invoices?.map(i=>i.number),
      balance:moneyForModel(r.amountCents,r.currency),status:r.status,action:r.action,score:r.score,tone:r.tone,
      contactHistory:r.contacts?{emailsSent:r.contacts.emailsSent??0,simulatedContacts:r.contacts.simulatedContacts??0,legacyContacts:r.contacts.legacyContacts,lastEmailAt:r.contacts.lastEmailAt,nextEligibleAt:r.contacts.nextEligibleAt,weeklyContacts:r.contacts.weeklyContacts,weeklyLimit:r.contacts.weeklyLimit,invoiceContacts:r.contacts.invoiceContacts}:undefined,
      hasPaymentEvidence:Boolean(r.evidence),paused:Boolean(r.paused)}))
  };
}
export function runForModel(run) {
  return {id:run.id,kind:run.kind,executionMode:run.mode,status:run.status,startedAt:run.started_at,
    collection:collectionForModel(run.result?.collection),
    alerts:run.result?.alerts,
    reconciliationCases:run.result?.reconciliation?.cases};
}
export function contextForModel(snapshot) {
  return {contextVersion:MODEL_CONTEXT_VERSION,workspaceMode:snapshot.mode,
    dataSource:snapshot.mode==='connected'?'Connected Lago invoices and configured payment accounts':'Illustrative app fixtures',
    moneyConvention:'Every amount is a decimal string in major currency units, not cents. Quote formatted amounts exactly. Totals are separated by currency and status.',
    outstandingTotals:totalsForModel(snapshot.openInvoices??[],i=>i.remainingAmountCents),
    contactCountConvention:'Emails sent counts actual provider-accepted submissions, including emails routed to the configured recipient. This is real sending, regardless of the recipient address. Simulated contacts are fixture history, never emails actually sent.',
    alerting:snapshot.alerts?{enabled:snapshot.alerts.enabled,channel:snapshot.alerts.channel}:null,
    outstandingScope:'All remaining open invoice balances, including invoices not yet due.',
    collection:collectionForModel(snapshot.collection),
    customerMemory:(snapshot.customers??[]).map(c=>({customerId:c.customerId,customerName:c.customerName,status:c.status,paused:c.paused,emailsSent:c.contacts.emailsSent??0,simulatedContacts:c.contacts.simulatedContacts??0,lastEmailAt:c.contacts.lastEmailAt,nextEligibleAt:c.contacts.nextEligibleAt})),
    receipts:(snapshot.receipts??[]).map(r=>({id:r.id,received:moneyForModel(r.grossAmountCents,r.currency),
      status:r.status,unapplied:moneyForModel(r.unappliedAmountCents,r.currency)})),
    receiptTotals:totalsForModel(snapshot.receipts??[],r=>r.grossAmountCents),
    receiptScope:'Incoming bank receipts, not amounts owed. Unmatched receipts do not automatically settle invoices or block unrelated customers.',
    openCaseCount:snapshot.cases.length,
    sourceHealth:snapshot.sourceHealth.map(s=>({source:s.source,status:s.status,checkedAt:s.checked_at})),
    recentRuns:snapshot.runs.slice(0,5).map(runForModel)};
}
