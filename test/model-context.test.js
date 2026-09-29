import test from 'node:test';
import assert from 'node:assert/strict';
import {contextForModel,moneyForModel,runForModel} from '../src/model-context.js';
test('money uses each currency scale and explicit major units',()=>{
  assert.deepEqual(moneyForModel(3525000,'EUR'),{currency:'EUR',amount:'35250.00',formatted:'€35,250.00'});
  assert.equal(moneyForModel(1250,'JPY').amount,'1250');
  assert.equal(moneyForModel(1250,'KWD').amount,'1.250');
  assert.equal(moneyForModel(undefined,'EUR'),null);
  assert.equal(moneyForModel(1250,undefined),null);
});
test('AI totals distinguish overdue status groups, future invoices and bank receipts',()=>{
  const rows=[['ready',1825000],['held',500000],['review',1200000]].map(([status,amountCents])=>({status,amountCents,currency:'EUR',invoices:[],invoiceIds:[]}));
  const snapshot={mode:'connected',collection:{ready:1,held:1,review:1,rows},openInvoices:[...rows.map(r=>({currency:r.currency,remainingAmountCents:r.amountCents})),{currency:'EUR',remainingAmountCents:210000},{currency:'JPY',remainingAmountCents:700}],receipts:[{id:'bank1',grossAmountCents:1000000000,unappliedAmountCents:1000000000,currency:'EUR'}],cases:[],sourceHealth:[],runs:[]};
  const context=contextForModel(snapshot);
  assert.equal(context.workspaceMode,'connected');
  assert.equal(context.collection.overdueTotals[0].formatted,'€35,250.00');
  assert.equal(context.outstandingTotals[0].formatted,'€37,350.00');
  assert.equal(context.outstandingTotals[1].amount,'700');
  assert.equal(context.collection.totalsByStatus.ready[0].formatted,'€18,250.00');
  assert.equal(context.collection.totalsByStatus.held[0].formatted,'€5,000.00');
  assert.equal(context.collection.totalsByStatus.review[0].formatted,'€12,000.00');
  assert.equal(context.receiptTotals[0].formatted,'€10,000,000.00');
  assert(!JSON.stringify(context).includes('amountCents'));
  assert.equal(runForModel({mode:'preview'}).executionMode,'preview');
  assert.equal(runForModel({mode:'preview'}).mode,undefined);
});
