import { loadConfig } from './config.js';
import { ReconciliationStore } from './db.js';
import { proposeMatches } from './matcher.js';
import demo from '../fixtures/demo.json' with { type: 'json' };

const config = loadConfig();
const store = new ReconciliationStore(config.databasePath);

for (const invoice of demo.invoices) store.upsertInvoice(invoice);
for (const identity of demo.confirmedIdentities) {
  store.confirmIdentity({ ...identity, actor: 'demo-seed', transferId: null });
}
for (const transfer of demo.transfers) {
  const id = store.upsertTransfer(transfer);
  store.replaceProposals(id, proposeMatches(transfer, demo.invoices, demo.confirmedIdentities));
}

console.log(`Seeded ${demo.invoices.length} invoices and ${demo.transfers.length} transfers into ${config.databasePath}`);
store.close();
