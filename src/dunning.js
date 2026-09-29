import { contactSummary,deliveryMode,event } from './customer-memory.js';
import { dunningSettings } from './dunning-settings.js';
const DAY=86400000;
export function invoiceFileLink(value,config) {
  if(typeof value!=='string'||/[\s\u0000-\u001f]/.test(value))return null;
  try {
    const url=new URL(value),local=host=>['localhost','127.0.0.1','[::1]'].includes(host)||host.endsWith('.lago.dev');
    if(url.username||url.password)return null;
    if(url.protocol==='https:'||(url.protocol==='http:'&&local(url.hostname)&&local(new URL(config.lago.baseUrl).hostname)))return url.href;
  }catch{}
  return null;
}
const invoiceLines=row=>(row.invoices??[]).map(i=>`${i.number} · ${money(i.amountCents,row.currency)} · due ${i.dueDate}${i.fileUrl?`\nView invoice: ${i.fileUrl}`:''}`).join('\n\n');
export const money=(amount,currency)=>new Intl.NumberFormat('en',{style:'currency',currency}).format(amount/10**new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits);
const idsOf=p=>p.invoice_ids??(p.lago_payable_id?[p.lago_payable_id]:p.invoiceId?[p.invoiceId]:[]);
const successful=p=>['succeeded','completed'].includes(String(p.payment_status??p.status).toLowerCase());

export function paymentBehaviour(invoices) {
  const seen=new Set(), lags=[];
  for(const i of invoices) {
    if(i.paymentStatus!=='succeeded' || !i.raw?.payment_due_date || seen.has(i.id)) continue;
    const payments=(i.payments??i.raw?.payments??[]).filter(successful);
    // A fully paid invoice contributes one observation, on its final settlement date.
    const dates=payments.map(p=>p.paid_at??p.paidAt??p.created_at).filter(Boolean).sort();
    if(!dates.length) continue;
    seen.add(i.id);
    const lag=Math.floor((Date.parse(dates.at(-1).slice(0,10))-Date.parse(i.raw.payment_due_date))/DAY);
    if(Number.isFinite(lag)) lags.push(lag);
  }
  lags.sort((a,b)=>a-b);
  const rate=lags.length?lags.filter(x=>x>0).length/lags.length:0;
  const median=lags[Math.floor(lags.length/2)]??0;
  return {score:lags.length<3?'occasionally-late':rate<.25?'good-payer':rate>.5?'repeat-late':'occasionally-late',paidInvoices:lags.length,lateInvoices:lags.filter(x=>x>0).length,lateRate:rate,
    median,reliable:lags.length>=3&&lags.filter(x=>Math.abs(x-median)<=3).length>=Math.max(3,lags.length-1)};
}

export function reconciliationHold(store, invoiceIds, customerId) {
  const wanted=new Set(invoiceIds);
  for(const id of wanted) {
    const exposure=store.getInvoiceAllocationExposure(id);
    if(exposure.reversalRequired) return {reason:'A received payment was reversed. Review the reversal before collecting.',invoiceId:id};
    if(exposure.reservedAmountCents>0) return {reason:'A payment allocation is approved or awaiting confirmation in Lago.',invoiceId:id};
  }
  for(const transfer of store.listTransfers()) {
    if(!['unreviewed','held','exception'].includes(transfer.reviewStatus)) continue;
    for(const proposal of transfer.proposals??[]) {
      // Amount alone is not sufficient to indefinitely hold unrelated customers.
      const identityEvidence=(proposal.signals??[]).some(s=>s.points>0&&(['sender_strong','identity_confirmed','crm_payer_identity','split_exact_total','remittance_verified'].includes(s.code)||s.code.startsWith('reference_')));
      if(proposal.score>=55 && identityEvidence && (proposal.allocations??[]).some(a=>wanted.has(a.invoiceId))) {
        return {reason:'Received money may cover this invoice. Review the bank match first.',receiptId:transfer.id};
      }
    }
  }
  for(const incident of store.listIncidents('open')) {
    const evidence=incident.evidence??{};
    const linked=[evidence.invoiceId,evidence.targetInvoiceId,...(evidence.invoiceIds??[]),...(evidence.lagoInvoiceIds??[])].filter(Boolean);
    const stripeId=Object.entries(store.meta('stripeCustomerMap')??{}).find(([,id])=>id===customerId)?.[0];
    if(linked.some(id=>wanted.has(id)) || evidence.lagoCustomerId===customerId || evidence.customerId===customerId || (stripeId && incident.scope===stripeId))
      return {reason:incident.summary??'Payment sources disagree. Review the reconciliation incident.',incidentId:incident.id};
  }
  return null;
}

export function sourceHold(store,config,now=new Date()) {
  if(config.mode==='demo') return null;
  const health=store.sourceHealth();
  const gaps=config.requiredSources.filter(source=>{
    const row=health.find(x=>x.source===source);
    return !row || row.status!=='succeeded' || !Number.isFinite(Date.parse(row.last_success_at)) || now-Date.parse(row.last_success_at)>config.maxSourceAgeMs;
  });
  return gaps.length ? `Payment evidence is incomplete or stale: ${gaps.join(', ')}. Refresh sources before collecting.` : null;
}

export function planDunning(store,config,now=new Date(),{ignoreActionId=null}={}) {
  const threshold=dunningSettings(store,config);
  const all=store.listInvoices(),groups=new Map();
  const today=now.toISOString().slice(0,10);
  for(const invoice of all) {
    const raw=invoice.raw??{};
    if(raw.status!=='finalized'||!raw.payment_due_date||raw.payment_due_date>=today||invoice.remainingAmountCents<=0||invoice.paymentStatus==='succeeded') continue;
    const key=`${invoice.customerId}:${invoice.currency}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(invoice);
  }
  const rows=[];
  for(const invs of groups.values()) {
    const first=invs[0],customer=first.raw?.customer??{},customerId=first.customerId;
    const invoiceIds=invs.map(i=>i.id),amountCents=invs.reduce((sum,i)=>sum+i.remainingAmountCents,0);
    const history=all.filter(i=>i.customerId===customerId && (i.issuedAt??'')>=new Date(now-DAY*365).toISOString().slice(0,10));
    const behaviour=paymentBehaviour(history);
    const row={customerId,customerExternalId:customer.external_id??null,customerName:first.customerName,currency:first.currency,
      amountCents,invoiceIds,invoices:invs.map(i=>({id:i.id,number:i.number,amountCents:i.remainingAmountCents,dueDate:i.raw.payment_due_date,fileUrl:invoiceFileLink(i.raw.file_url,config)})),
      daysOverdue:Math.max(...invs.map(i=>Math.floor((Date.parse(today)-Date.parse(i.raw.payment_due_date))/DAY))),
      score:behaviour.score,status:'ready',action:'reminder',reason:'Overdue balance with no conflicting payment evidence.',recipient:customer.email||null};
    row.tone=({'good-payer':'gentle','occasionally-late':'neutral','repeat-late':'firm'})[behaviour.score];
    row.toneReason=behaviour.paidInvoices<3?'Fewer than three settled invoices in the last 12 months; use a neutral reminder.':`${behaviour.lateInvoices} of ${behaviour.paidInvoices} settled invoices were paid late in the last 12 months.`;
    const memory=store.memory(customerId),actions=store.actions(customerId).filter(a=>a.id!==ignoreActionId);
    row.contacts=contactSummary(store,customerId,config,invoiceIds,now);
    row.paused=Boolean(memory.paused);
    const activeActions=actions.filter(a=>['sent','test_sent','legacy_sent','retried','executing','sending','unknown'].includes(a.status));
    const relevant=activeActions.filter(a=>JSON.parse(a.invoice_ids).some(id=>invoiceIds.includes(id)));
    const hold=(reason,details={})=>Object.assign(row,{status:'held',action:null,reason,...details});
    const recon=reconciliationHold(store,invoiceIds,customerId);
    const missing=sourceHold(store,config,now);
    if(memory.paused) hold(memory.pause_reason||'A person has paused collection for this customer.');
    else if(invs.some(i=>i.raw.payment_dispute_lost_at||i.raw.disputed)) hold('An invoice is disputed. A person must resolve it first.');
    else if(missing) hold(missing);
    else if(recon) hold(recon.reason,{evidence:recon});
    else if(actions.some(a=>a.status==='drafted'&&JSON.parse(a.invoice_ids).some(id=>invoiceIds.includes(id)))) hold('A saved draft already exists for these invoices. Review it in Drafts; it has not been sent.');
    else if(activeActions.some(a=>['unknown','executing','sending'].includes(a.status))) hold('A prior action has an uncertain outcome. Verify the earlier draft, delivery or charge status before retrying.');
    else if(row.currency!==threshold.currency) {hold(`The materiality threshold is in ${threshold.currency}. Review this ${row.currency} balance; no currency conversion is applied.`);row.status='review';}
    else if(amountCents>=threshold.amountMinor) {hold(`This balance meets or exceeds the automatic collection threshold (${money(threshold.amountMinor,threshold.currency)}).`);row.status='review';}
    else if(row.contacts.invoiceContacts>=config.policy.terminalTouches) {hold('Repeated collection attempts need a person to take over.');row.status='review';}
    else if(row.contacts.weeklyContacts>=config.policy.weeklyCap) hold('Weekly contact limit reached.');
    else if(row.contacts.nextEligibleAt) hold('Waiting for the contact cooldown to finish.');
    else {
      const provider=customer.billing_configuration?.payment_provider;
      if(provider) {
        const failed=invs.filter(i=>{
          const latest=[...(i.payments??i.raw.payments??[])].sort((a,b)=>(b.created_at??b.paid_at??'').localeCompare(a.created_at??a.paid_at??''))[0];
          return latest?.payment_status==='failed';
        });
        if(!failed.length) hold('The payment provider is collecting; no failed attempt is recorded.');
        else {row.action='card_fix';row.reason='The payment method needs attention. A customer billing portal link will be added when the draft is saved.';}
      } else if(behaviour.reliable&&row.daysOverdue<=behaviour.median+2) hold(`Waiting within the customer's usual payment pattern (${behaviour.median} days).`);
      if(row.action && row.action!=='retry'&&!row.recipient) hold('No billing email is available for this customer.');
    }
    if(row.action==='card_fix'){row.tone='helpful';row.toneReason='A failed payment needs a payment-method update, rather than a firmer collection reminder.';}
    row.draft=draft(row);
    rows.push(row);
  }
  const totals=rows.reduce((out,row)=>{out[row.currency]=(out[row.currency]??0)+row.amountCents;return out;},{});
  return {rows,totals,ready:rows.filter(x=>x.status==='ready').length,held:rows.filter(x=>x.status==='held').length,
    review:rows.filter(x=>x.status==='review').length,generatedAt:now.toISOString(),policyVersion:'receivables-memory-v3',materialityThreshold:threshold};
}

export function paymentMethodDraft(row, portalUrl = null) {
  return {subject:'Please update your payment method',body:`Hi ${row.customerName},\n\nWe could not collect ${money(row.amountCents,row.currency)}. ${portalUrl ? `Please update your payment method here:\n${portalUrl}` : 'Please update your payment method in your billing portal or contact our billing team.'}${row.invoices?.length?`\n\nInvoices:\n${invoiceLines(row)}`:''}\n\nThanks,\nAccounts Receivable`};
}

function draft(row) {
  if(!row.action||row.action==='retry') return null;
  if(row.action==='card_fix') return paymentMethodDraft(row);
  const tone=row.tone??'neutral',amount=money(row.amountCents,row.currency);
  const subject={gentle:`Quick reminder: ${amount} outstanding`,neutral:`Following up: ${amount} past due`,firm:`Past due notice: ${amount}`}[tone];
  const lead={gentle:"Hope you’re well. Just a friendly reminder about the following overdue invoices:",neutral:'Our records show the following invoices are past due:',firm:'The following invoices remain unpaid. Please arrange payment promptly:'}[tone];
  const close={gentle:'If payment is already on its way, thank you. Please share the payment reference so we can match it.',neutral:'Please include the invoice number when paying. If you have already paid, please share the payment reference.',firm:'Please confirm when payment will be made and include the invoice number when paying. If you have already paid, please send the payment reference so we can reconcile it.'}[tone];
  return {subject,body:`Hi ${row.customerName},\n\n${lead}\n\n${invoiceLines(row)}\n\nTotal remaining: ${amount}.\n\n${close}\n\nThanks,\nAccounts Receivable`};
}

export async function executeDunning({store,config,runId,preview,refresh,createDraft,getPortalLink}) {
  const outcomes=[];
  for(const proposed of preview.rows.filter(x=>x.status==='ready')) {
    await refresh();
    const current=planDunning(store,config).rows.find(x=>x.customerId===proposed.customerId&&x.currency===proposed.currency);
    if(!current||current.status!=='ready'||current.action!==proposed.action||current.amountCents!==proposed.amountCents||
      current.invoiceIds.join(',')!==proposed.invoiceIds.join(',')||current.recipient!==proposed.recipient||
      JSON.stringify(current.draft)!==JSON.stringify(proposed.draft)||!current.draft) {
      outcomes.push({...proposed,outcome:'skipped',detail:current?.reason??'Balance or invoice eligibility changed since preview.'});continue;
    }
    const actionId=store.beginAction(runId,{...current,deliveryMode:deliveryMode(config)});
    try {
      let portal = null;
      if(current.action==='card_fix') {
        try {
          if(!current.customerExternalId || !getPortalLink) throw new Error('Missing portal connection');
          portal = await getPortalLink(current.customerExternalId);
          if(!portal?.url || !(Date.parse(portal.expiresAt)>Date.now())) throw new Error('Missing or expired link');
          current.draft = paymentMethodDraft(current, portal.url);
        } catch {
          throw Object.assign(new Error('Could not obtain this customer’s billing portal link from Lago. Check the Lago connection and customer external ID, then run dunning again. No draft was saved.'), { attempted:false });
        }
      }
      const draft=await createDraft(current.recipient,current.draft.subject,current.draft.body,portal ? {customerExternalId:current.customerExternalId,...portal} : null,{actionId});
      if(!draft?.id) throw new Error('Missing saved draft confirmation.');
      store.finishAction(actionId,'drafted',JSON.stringify({draftId:draft.id}));
      outcomes.push({...current,outcome:'drafted',draftId:draft.id,detail:'Draft saved in this workspace. No email was sent.'});
    } catch(error) {
      // A draft may exist even if the response was lost. Never replay an ambiguous creation.
      const outcome=error.attempted===false?'failed':'unknown';
      const detail=error.attempted===false?error.message:'Draft creation could not be confirmed. Check saved drafts before retrying.';
      store.finishAction(actionId,outcome,detail);
      outcomes.push({...current,outcome,detail});
    }
  }
  return {...preview,outcomes};
}
