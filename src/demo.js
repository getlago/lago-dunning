export function seedDemo(store,service) {
  if(store.meta('demoSeeded')) return;
  const date=(days)=>new Date(Date.now()-days*86400000).toISOString().slice(0,10);
  const invoice=(id,number,name,amount,overdue,extra={})=>({id,number,customerId:`cus_${id}`,customerName:name,currency:'EUR',
    totalAmountCents:amount,remainingAmountCents:amount,paymentStatus:'pending',issuedAt:date(overdue+30),
    raw:{status:'finalized',payment_due_date:date(overdue),customer:{lago_id:`cus_${id}`,external_id:id,name,email:`billing@${id}.example`}},...extra});
  const invoices=[
    invoice('northstar','INV-1042','Northstar',480000,12),
    invoice('orbit','INV-1043','Orbit',320000,8),
    invoice('linear','INV-1044','Linear Labs',185000,6),
    invoice('acme','INV-1045','Acme',625000,18),
    invoice('helios','INV-1046','Helios',240000,10),
    invoice('vector','INV-1047','Vector',95000,4),
    invoice('forma','INV-1048','Forma',1200000,26)
  ];
  invoices.forEach(i=>store.upsertInvoice(i));
  const transfer=(id,name,amount,reference,provider='qonto')=>({provider,accountId:'demo-operating',providerTransactionId:id,status:'posted',direction:'credit',
    amountCents:amount,currency:'EUR',bookedAt:new Date(Date.now()-86400000).toISOString(),senderName:name,reference,description:'Incoming bank transfer'});
  [transfer('wire_northstar','NORTHSTAR',480000,'INV-1042'),transfer('wire_orbit','Orbit',320000,'INV-1043'),
    transfer('wire_helios','HELIOS',120000,'INV-1046'),transfer('wire_unknown','WESTBRIDGE HOLDINGS',275000,'September services')].forEach(t=>service.ingestTransfer(t));
  store.meta('demoSeeded',true);
  store.health('lago','succeeded','Illustrative demo data');store.health('qonto','succeeded','Illustrative demo data');
}
