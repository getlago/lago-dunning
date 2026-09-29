import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { POLICY_VERSION } from './matcher.js';
import { redactSensitive } from './redaction.js';

// A review rejects this invoice combination for this receipt. New scores,
// amounts, ranks, or proposal IDs must not silently undo that decision.
const matchIdentity = (allocations) => JSON.stringify([...new Set(allocations.map(a => a.invoiceId))].sort());

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  booked_at TEXT NOT NULL,
  sender_name TEXT,
  sender_account_fingerprint TEXT,
  reference TEXT,
  description TEXT,
  note TEXT,
  raw_json TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, account_id, provider_transaction_id)
);

-- Provider-neutral money movement. The transfers table remains the bank-matching
-- projection used by the MVP UI; every settled source is also represented
-- here so allocation and settlement do not depend on a bank-specific table.
CREATE TABLE IF NOT EXISTS cash_receipts (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  status TEXT NOT NULL,
  gross_amount_cents INTEGER NOT NULL CHECK(gross_amount_cents > 0),
  currency TEXT NOT NULL,
  received_at TEXT NOT NULL,
  counterparty_name TEXT,
  counterparty_account_fingerprint TEXT,
  reference TEXT,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_system, source_account_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_legal_name TEXT,
  customer_external_salesforce_id TEXT,
  currency TEXT NOT NULL,
  total_amount_cents INTEGER NOT NULL,
  remaining_amount_cents INTEGER NOT NULL,
  payment_status TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  kind TEXT NOT NULL,
  score INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  margin INTEGER NOT NULL DEFAULT 0,
  allocations_json TEXT NOT NULL,
  adjustments_json TEXT NOT NULL DEFAULT '[]',
  signals_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  auto_eligible INTEGER NOT NULL DEFAULT 0,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(transfer_id, rank)
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL REFERENCES transfers(id),
  proposal_id INTEGER REFERENCES proposals(id),
  action TEXT NOT NULL,
  allocations_json TEXT NOT NULL,
  adjustments_json TEXT NOT NULL DEFAULT '[]',
  actor TEXT NOT NULL,
  note TEXT,
  execution_status TEXT NOT NULL DEFAULT 'not_requested',
  execution_result_json TEXT,
  execution_claimed_at TEXT,
  execution_claimed_by TEXT,
  execution_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cash_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL REFERENCES cash_receipts(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  lago_payment_id TEXT,
  actor TEXT NOT NULL,
  note TEXT,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(decision_id, invoice_id)
);

-- Non-cash settlement components are explicit and never consume receipt value.
-- They remain separate from cash allocations because a bank fee or withholding
-- amount did not arrive in the destination account.
CREATE TABLE IF NOT EXISTS cash_application_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL REFERENCES cash_receipts(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  type TEXT NOT NULL CHECK(type IN ('bank_fee_writeoff', 'withholding_tax', 'short_pay')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  policy_version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(decision_id, invoice_id, type)
);

CREATE TABLE IF NOT EXISTS cash_application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  receipt_id TEXT NOT NULL REFERENCES cash_receipts(id),
  allocation_id INTEGER REFERENCES cash_allocations(id),
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS receipt_evidence_links (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES cash_receipts(id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'unknown',
  authority TEXT NOT NULL,
  amount_cents INTEGER,
  currency TEXT,
  occurred_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(receipt_id, source_system, source_record_id, relation)
);

CREATE TABLE IF NOT EXISTS remittance_documents (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES cash_receipts(id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  extractor TEXT NOT NULL,
  extractor_version TEXT,
  status TEXT NOT NULL DEFAULT 'extracted',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(receipt_id, source_system, source_record_id)
);

CREATE TABLE IF NOT EXISTS remittance_claims (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES remittance_documents(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL,
  citation_locator TEXT NOT NULL,
  citation_excerpt TEXT NOT NULL,
  citation_text_hash TEXT NOT NULL,
  extraction_confidence INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cash_application_policies (
  customer_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  max_bank_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK(max_bank_fee_cents >= 0),
  withholding_bps INTEGER NOT NULL DEFAULT 0 CHECK(withholding_bps BETWEEN 0 AND 10000),
  max_short_pay_cents INTEGER NOT NULL DEFAULT 0 CHECK(max_short_pay_cents >= 0),
  max_short_pay_bps INTEGER NOT NULL DEFAULT 0 CHECK(max_short_pay_bps BETWEEN 0 AND 10000),
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS confirmed_identities (
  fingerprint TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  label TEXT,
  confirmed_by TEXT NOT NULL,
  source_transfer_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(fingerprint, customer_id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider, event_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  cursor TEXT,
  last_synced_at TEXT,
  PRIMARY KEY(provider, account_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lago_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  provider_payment_id TEXT,
  provider_code TEXT,
  reference TEXT,
  paid_at TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stripe_cash_transactions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at_provider TEXT NOT NULL,
  payment_intent_id TEXT,
  reference TEXT,
  sender_name TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stripe_payment_intents (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  amount_received_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  created_at_provider TEXT NOT NULL,
  invoice_id TEXT,
  invoice_number TEXT,
  payment_id TEXT,
  description TEXT,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS external_payment_records (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  unapplied_amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  paid_at TEXT,
  customer_id TEXT,
  customer_name TEXT,
  reference TEXT,
  origin_system TEXT,
  allocations_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, organization_id, provider_payment_id)
);

CREATE TABLE IF NOT EXISTS customer_contexts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  crm_account_id TEXT NOT NULL,
  lago_customer_id TEXT,
  erp_customer_id TEXT,
  account_name TEXT NOT NULL,
  parent_crm_account_id TEXT,
  parent_name TEXT,
  owner_id TEXT,
  owner_name TEXT,
  billing_country TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  payment_terms_days INTEGER,
  expected_payment_method TEXT,
  billing_contact_email TEXT,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, crm_account_id)
);

-- Durable agent runtime preserves tool traces and stable case lifecycle
-- across repeated autonomous runs.
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  source_plan_json TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error_json TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE(run_id, sequence)
);

CREATE TABLE IF NOT EXISTS agent_cases (
  id TEXT PRIMARY KEY,
  case_key TEXT NOT NULL UNIQUE,
  current_run_id INTEGER NOT NULL REFERENCES agent_runs(id),
  kind TEXT NOT NULL,
  priority TEXT NOT NULL,
  state TEXT NOT NULL,
  disposition TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  owner_name TEXT NOT NULL,
  queue TEXT NOT NULL DEFAULT 'cash_application',
  assignee_id TEXT,
  assignee_name TEXT,
  required_permission TEXT NOT NULL DEFAULT 'payments:view',
  commercial_owner_id TEXT,
  commercial_owner_name TEXT,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_payload_json TEXT NOT NULL,
  amount_cents INTEGER,
  currency TEXT,
  evidence_json TEXT NOT NULL,
  trace_json TEXT NOT NULL,
  source_coverage_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolution_json TEXT
);

CREATE TABLE IF NOT EXISTS agent_case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES agent_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_case_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES agent_cases(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'unknown',
  verdict TEXT NOT NULL CHECK(verdict IN ('correct', 'incorrect', 'not_applicable')),
  expected_allocations_json TEXT NOT NULL DEFAULT '[]',
  review_seconds INTEGER,
  baseline_seconds INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS identity_edges (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  label TEXT,
  confidence INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, source_record_id, edge_type, from_id, to_id)
);

CREATE TABLE IF NOT EXISTS agent_playbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  conditions_json TEXT NOT NULL,
  effects_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reconciliation_incidents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS cash_allocation_requires_settled_receipt
BEFORE INSERT ON cash_allocations
WHEN (SELECT status FROM cash_receipts WHERE id=NEW.receipt_id) != 'posted'
BEGIN
  SELECT RAISE(ABORT, 'cash allocation requires a settled receipt');
END;

CREATE TRIGGER IF NOT EXISTS cash_allocation_conserves_receipt_value
BEFORE INSERT ON cash_allocations
WHEN NEW.amount_cents + COALESCE((SELECT SUM(amount_cents) FROM cash_allocations
  WHERE receipt_id=NEW.receipt_id AND status IN ('approved', 'executed', 'confirmed', 'reversal_required')), 0)
  > (SELECT gross_amount_cents FROM cash_receipts WHERE id=NEW.receipt_id)
BEGIN
  SELECT RAISE(ABORT, 'cash allocation exceeds receipt value');
END;

CREATE TRIGGER IF NOT EXISTS cash_allocation_requires_matching_currency
BEFORE INSERT ON cash_allocations
WHEN NEW.currency != (SELECT currency FROM cash_receipts WHERE id=NEW.receipt_id)
  OR NEW.currency != (SELECT currency FROM invoices WHERE id=NEW.invoice_id)
BEGIN
  SELECT RAISE(ABORT, 'cash allocation currency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS cash_allocation_requires_one_customer
BEFORE INSERT ON cash_allocations
WHEN EXISTS (SELECT 1 FROM cash_allocations a JOIN invoices i ON i.id=a.invoice_id
  WHERE a.receipt_id=NEW.receipt_id
    AND a.status IN ('approved', 'executed', 'confirmed', 'reversal_required')
    AND i.customer_id != (SELECT customer_id FROM invoices WHERE id=NEW.invoice_id))
BEGIN
  SELECT RAISE(ABORT, 'cash allocation crosses Lago customers');
END;

CREATE TRIGGER IF NOT EXISTS cash_adjustment_requires_settled_receipt
BEFORE INSERT ON cash_application_adjustments
WHEN (SELECT status FROM cash_receipts WHERE id=NEW.receipt_id) != 'posted'
BEGIN
  SELECT RAISE(ABORT, 'cash adjustment requires a settled receipt');
END;

CREATE TRIGGER IF NOT EXISTS cash_adjustment_requires_matching_currency
BEFORE INSERT ON cash_application_adjustments
WHEN NEW.currency != (SELECT currency FROM cash_receipts WHERE id=NEW.receipt_id)
  OR NEW.currency != (SELECT currency FROM invoices WHERE id=NEW.invoice_id)
BEGIN
  SELECT RAISE(ABORT, 'cash adjustment currency mismatch');
END;

CREATE TRIGGER IF NOT EXISTS cash_adjustment_requires_cash_allocation
BEFORE INSERT ON cash_application_adjustments
WHEN NOT EXISTS (SELECT 1 FROM cash_allocations
  WHERE decision_id=NEW.decision_id AND receipt_id=NEW.receipt_id AND invoice_id=NEW.invoice_id)
BEGIN
  SELECT RAISE(ABORT, 'cash adjustment requires an accompanying allocation');
END;

CREATE TRIGGER IF NOT EXISTS cash_application_events_no_update
BEFORE UPDATE ON cash_application_events
BEGIN
  SELECT RAISE(ABORT, 'cash application events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS cash_application_events_no_delete
BEFORE DELETE ON cash_application_events
BEGIN
  SELECT RAISE(ABORT, 'cash application events are immutable');
END;

CREATE INDEX IF NOT EXISTS idx_transfers_review ON transfers(review_status, booked_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_source ON cash_receipts(source_system, source_account_id, source_record_id);
CREATE INDEX IF NOT EXISTS idx_allocations_receipt ON cash_allocations(receipt_id, status);
CREATE INDEX IF NOT EXISTS idx_allocations_invoice ON cash_allocations(invoice_id, status);
CREATE INDEX IF NOT EXISTS idx_adjustments_receipt ON cash_application_adjustments(receipt_id, status);
CREATE INDEX IF NOT EXISTS idx_adjustments_invoice ON cash_application_adjustments(invoice_id, status);
CREATE INDEX IF NOT EXISTS idx_receipt_evidence_receipt ON receipt_evidence_links(receipt_id, authority);
CREATE INDEX IF NOT EXISTS idx_remittance_receipt ON remittance_documents(receipt_id, created_at);
CREATE INDEX IF NOT EXISTS idx_remittance_claim_document ON remittance_claims(document_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_case_labels_case ON agent_case_labels(case_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_external_payments_provider ON external_payment_records(provider, organization_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_customer_context_lago ON customer_contexts(lago_customer_id);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_cases_state ON agent_cases(state, priority, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_identity_edges_from ON identity_edges(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_identity_edges_to ON identity_edges(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_invoices_open ON invoices(payment_status, currency, remaining_amount_cents);
CREATE INDEX IF NOT EXISTS idx_proposals_transfer ON proposals(transfer_id, rank);
`;

export class ReconciliationStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(schema);
    this.migrateSchema();
  }

  migrateSchema() {
    this.ensureColumn('invoices', 'customer_external_salesforce_id', 'TEXT');
    this.ensureColumn('agent_cases', 'queue', "TEXT NOT NULL DEFAULT 'cash_application'");
    this.ensureColumn('agent_cases', 'assignee_id', 'TEXT');
    this.ensureColumn('agent_cases', 'assignee_name', 'TEXT');
    this.ensureColumn('agent_cases', 'required_permission', "TEXT NOT NULL DEFAULT 'payments:view'");
    this.ensureColumn('agent_cases', 'commercial_owner_id', 'TEXT');
    this.ensureColumn('agent_cases', 'commercial_owner_name', 'TEXT');
    this.ensureColumn('agent_case_labels', 'policy_version', "TEXT NOT NULL DEFAULT 'unknown'");
    this.ensureColumn('proposals', 'adjustments_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('decisions', 'adjustments_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('decisions', 'execution_claimed_at', 'TEXT');
    this.ensureColumn('decisions', 'execution_claimed_by', 'TEXT');
    this.ensureColumn('decisions', 'execution_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('cash_allocations', 'voided_at', 'TEXT');
    this.ensureColumn('cash_allocations', 'voided_by', 'TEXT');
    this.ensureColumn('cash_allocations', 'void_reason', 'TEXT');
    // The former hard three-invoice ceiling contradicted real statement-payment
    // evidence. Split limits are now bounded matcher policy, not ledger schema.
    this.db.exec('DROP TRIGGER IF EXISTS cash_allocation_limits_invoice_count');
    this.db.exec(`DROP TRIGGER IF EXISTS cash_allocation_requires_settled_receipt;
      CREATE TRIGGER cash_allocation_requires_settled_receipt
      BEFORE INSERT ON cash_allocations
      WHEN (SELECT status FROM cash_receipts WHERE id=NEW.receipt_id) != 'posted'
      BEGIN
        SELECT RAISE(ABORT, 'cash allocation requires a settled receipt');
      END;`);
    this.db.exec(`DROP TRIGGER IF EXISTS cash_allocation_conserves_receipt_value;
      CREATE TRIGGER cash_allocation_conserves_receipt_value
      BEFORE INSERT ON cash_allocations
      WHEN NEW.amount_cents + COALESCE((SELECT SUM(amount_cents) FROM cash_allocations
        WHERE receipt_id=NEW.receipt_id AND status IN ('approved', 'executed', 'confirmed', 'reversal_required')), 0)
        > (SELECT gross_amount_cents FROM cash_receipts WHERE id=NEW.receipt_id)
      BEGIN
        SELECT RAISE(ABORT, 'cash allocation exceeds receipt value');
      END;
      DROP TRIGGER IF EXISTS cash_allocation_requires_one_customer;
      CREATE TRIGGER cash_allocation_requires_one_customer
      BEFORE INSERT ON cash_allocations
      WHEN EXISTS (SELECT 1 FROM cash_allocations a JOIN invoices i ON i.id=a.invoice_id
        WHERE a.receipt_id=NEW.receipt_id
          AND a.status IN ('approved', 'executed', 'confirmed', 'reversal_required')
          AND i.customer_id != (SELECT customer_id FROM invoices WHERE id=NEW.invoice_id))
      BEGIN
        SELECT RAISE(ABORT, 'cash allocation crosses Lago customers');
      END;`);
  }

  ensureColumn(table, column, definition) {
    const existing = this.db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
    if (!existing) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close() { this.db.close(); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  upsertTransfer(transfer) {
    const id = transfer.id ?? `${transfer.provider}:${transfer.accountId}:${transfer.providerTransactionId}`;
    this.transaction(() => {
      const existing = this.db.prepare(`SELECT r.*,
        COALESCE(SUM(CASE WHEN a.status IN ('approved', 'executed', 'confirmed', 'reversal_required') THEN a.amount_cents ELSE 0 END), 0) allocated_amount_cents
        FROM cash_receipts r LEFT JOIN cash_allocations a ON a.receipt_id = r.id
        WHERE r.source_system=? AND r.source_account_id=? AND r.source_record_id=? GROUP BY r.id`)
        .get(transfer.provider, transfer.accountId, transfer.providerTransactionId);
      if (existing?.allocated_amount_cents > 0 && existing.currency !== transfer.currency) {
        throw new Error('A receipt currency cannot change after allocation');
      }
      if (existing?.allocated_amount_cents > Number(transfer.amountCents)) {
        throw new Error(`Receipt correction is below its allocated balance: ${existing.allocated_amount_cents} allocated`);
      }
      this.db.prepare(`INSERT INTO cash_receipts (
        id, source_system, source_account_id, source_record_id, status, gross_amount_cents, currency,
        received_at, counterparty_name, counterparty_account_fingerprint, reference, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_system, source_account_id, source_record_id) DO UPDATE SET
        status=excluded.status, gross_amount_cents=excluded.gross_amount_cents, currency=excluded.currency,
        received_at=excluded.received_at, counterparty_name=excluded.counterparty_name,
        counterparty_account_fingerprint=excluded.counterparty_account_fingerprint,
        reference=excluded.reference, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`).run(
        id, transfer.provider, transfer.accountId, transfer.providerTransactionId, transfer.status,
        transfer.amountCents, transfer.currency, transfer.bookedAt, transfer.senderName ?? null,
        transfer.senderAccountFingerprint ?? null, transfer.reference ?? null, safeJson(transfer.raw ?? transfer)
      );
      this.db.prepare(`INSERT INTO transfers (
        id, provider, account_id, provider_transaction_id, status, amount_cents, currency, booked_at,
        sender_name, sender_account_fingerprint, reference, description, note, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account_id, provider_transaction_id) DO UPDATE SET
        status=excluded.status, amount_cents=excluded.amount_cents, currency=excluded.currency,
        booked_at=excluded.booked_at, sender_name=excluded.sender_name,
        sender_account_fingerprint=excluded.sender_account_fingerprint, reference=excluded.reference,
        description=excluded.description, note=excluded.note, raw_json=excluded.raw_json,
        updated_at=CURRENT_TIMESTAMP`).run(
        id, transfer.provider, transfer.accountId, transfer.providerTransactionId, transfer.status,
        transfer.amountCents, transfer.currency, transfer.bookedAt, transfer.senderName ?? null,
        transfer.senderAccountFingerprint ?? null, transfer.reference ?? null, transfer.description ?? null,
        transfer.note ?? null, safeJson(transfer.raw ?? transfer)
      );
    });
    return id;
  }

  upsertInvoice(invoice) {
    this.db.prepare(`INSERT INTO invoices (
      id, number, customer_id, customer_name, customer_legal_name, customer_external_salesforce_id, currency, total_amount_cents,
      remaining_amount_cents, payment_status, issued_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET number=excluded.number, customer_id=excluded.customer_id,
      customer_name=excluded.customer_name, customer_legal_name=excluded.customer_legal_name,
      customer_external_salesforce_id=excluded.customer_external_salesforce_id,
      currency=excluded.currency, total_amount_cents=excluded.total_amount_cents,
      remaining_amount_cents=excluded.remaining_amount_cents, payment_status=excluded.payment_status,
      issued_at=excluded.issued_at, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`).run(
      invoice.id, invoice.number, invoice.customerId, invoice.customerName, invoice.customerLegalName ?? null,
      invoice.customerExternalSalesforceId ?? null,
      invoice.currency, invoice.totalAmountCents, invoice.remainingAmountCents, invoice.paymentStatus,
      invoice.issuedAt, safeJson(invoice.raw ?? invoice)
    );
  }

  getOpenInvoices() {
    return this.db.prepare(`SELECT * FROM invoices WHERE json_extract(raw_json, '$.status') = 'finalized' AND payment_status != 'succeeded' AND remaining_amount_cents > 0`).all().map(mapInvoice);
  }

  listInvoices() { return this.db.prepare('SELECT * FROM invoices ORDER BY issued_at DESC').all().map(mapInvoice); }

  upsertLagoPayment(payment) {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO lago_payments
        (id, invoice_id, status, amount_cents, provider_payment_id, provider_code, reference, paid_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, amount_cents=excluded.amount_cents,
        provider_payment_id=excluded.provider_payment_id, provider_code=excluded.provider_code,
        reference=excluded.reference, paid_at=excluded.paid_at, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`).run(
        payment.id, payment.invoiceId, payment.status, payment.amountCents, payment.providerPaymentId,
        payment.providerCode, payment.reference, payment.paidAt, safeJson(payment.raw ?? payment));
      if (payment.status === 'succeeded') {
        const confirmed = this.db.prepare(`SELECT id, receipt_id FROM cash_allocations
          WHERE invoice_id=? AND status='executed' AND lago_payment_id=?`).all(payment.invoiceId, payment.id);
        for (const allocation of confirmed) {
          this.db.prepare(`UPDATE cash_allocations SET status='confirmed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(allocation.id);
          this.db.prepare(`INSERT INTO cash_application_events
            (event_type, receipt_id, allocation_id, actor, detail_json)
            VALUES ('allocation_confirmed', ?, ?, 'system', ?)`).run(
            allocation.receipt_id, allocation.id, JSON.stringify({ lagoPaymentId: payment.id }));
        }
      }
    });
  }

  listLagoPayments() {
    return this.db.prepare('SELECT * FROM lago_payments').all().map((row) => ({
      id: row.id, invoiceId: row.invoice_id, status: row.status, amountCents: row.amount_cents,
      providerPaymentId: row.provider_payment_id, providerCode: row.provider_code,
      reference: row.reference, paidAt: row.paid_at
    }));
  }

  upsertExternalPayment(payment) {
    const id = `${payment.provider}:${payment.organizationId}:${payment.providerPaymentId}`;
    this.db.prepare(`INSERT INTO external_payment_records (
      id, provider, organization_id, provider_payment_id, status, amount_cents, unapplied_amount_cents,
      currency, paid_at, customer_id, customer_name, reference, origin_system, allocations_json, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, organization_id, provider_payment_id) DO UPDATE SET
      status=excluded.status, amount_cents=excluded.amount_cents,
      unapplied_amount_cents=excluded.unapplied_amount_cents, currency=excluded.currency,
      paid_at=excluded.paid_at, customer_id=excluded.customer_id, customer_name=excluded.customer_name,
      reference=excluded.reference, origin_system=excluded.origin_system,
      allocations_json=excluded.allocations_json, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`).run(
      id, payment.provider, payment.organizationId, payment.providerPaymentId, payment.status,
      payment.amountCents, payment.unappliedAmountCents ?? 0, payment.currency || null, payment.paidAt ?? null,
      payment.customerId ?? null, payment.customerName ?? null, payment.reference ?? null,
      payment.originSystem ?? null, JSON.stringify(payment.allocations ?? []), safeJson(payment.raw ?? payment)
    );
    return id;
  }

  listExternalPayments(provider = null) {
    const rows = provider
      ? this.db.prepare('SELECT * FROM external_payment_records WHERE provider = ? ORDER BY paid_at DESC').all(provider)
      : this.db.prepare('SELECT * FROM external_payment_records ORDER BY paid_at DESC').all();
    return rows.map((row) => ({
      id: row.id, provider: row.provider, organizationId: row.organization_id,
      providerPaymentId: row.provider_payment_id, status: row.status, amountCents: row.amount_cents,
      unappliedAmountCents: row.unapplied_amount_cents, currency: row.currency, paidAt: row.paid_at,
      customerId: row.customer_id, customerName: row.customer_name, reference: row.reference,
      originSystem: row.origin_system, allocations: parseJson(row.allocations_json, [])
    }));
  }

  upsertCustomerContext(context) {
    const id = `${context.source}:${context.crmAccountId}`;
    this.db.prepare(`INSERT INTO customer_contexts (
      id, source, crm_account_id, lago_customer_id, erp_customer_id, account_name,
      parent_crm_account_id, parent_name, owner_id, owner_name, billing_country, aliases_json,
      payment_terms_days, expected_payment_method, billing_contact_email, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, crm_account_id) DO UPDATE SET
      lago_customer_id=excluded.lago_customer_id, erp_customer_id=excluded.erp_customer_id,
      account_name=excluded.account_name, parent_crm_account_id=excluded.parent_crm_account_id,
      parent_name=excluded.parent_name, owner_id=excluded.owner_id, owner_name=excluded.owner_name,
      billing_country=excluded.billing_country, aliases_json=excluded.aliases_json,
      payment_terms_days=excluded.payment_terms_days, expected_payment_method=excluded.expected_payment_method,
      billing_contact_email=excluded.billing_contact_email, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`).run(
      id, context.source, context.crmAccountId, context.lagoCustomerId ?? null, context.erpCustomerId ?? null,
      context.accountName, context.parentCrmAccountId ?? null, context.parentName ?? null,
      context.ownerId ?? null, context.ownerName ?? null, context.billingCountry ?? null,
      JSON.stringify(context.aliases ?? []), context.paymentTermsDays ?? null,
      context.expectedPaymentMethod ?? null, context.billingContactEmail ?? null, safeJson(context.raw ?? context)
    );
    return id;
  }

  listCustomerContexts() {
    return this.db.prepare('SELECT * FROM customer_contexts ORDER BY account_name').all().map((row) => ({
      id: row.id, source: row.source, crmAccountId: row.crm_account_id,
      lagoCustomerId: row.lago_customer_id, erpCustomerId: row.erp_customer_id,
      accountName: row.account_name, parentCrmAccountId: row.parent_crm_account_id,
      parentName: row.parent_name, ownerId: row.owner_id, ownerName: row.owner_name,
      billingCountry: row.billing_country, aliases: parseJson(row.aliases_json, []),
      paymentTermsDays: row.payment_terms_days, expectedPaymentMethod: row.expected_payment_method,
      billingContactEmail: row.billing_contact_email
    }));
  }

  startAgentRun({ trigger, policyVersion, sourcePlan }) {
    const result = this.db.prepare(`INSERT INTO agent_runs
      (trigger, status, policy_version, source_plan_json) VALUES (?, 'running', ?, ?)`)
      .run(trigger, policyVersion, JSON.stringify(sourcePlan));
    return Number(result.lastInsertRowid);
  }

  recordAgentStep({ runId, sequence, toolName, category, status, input = {}, output = null, error = null }) {
    this.db.prepare(`INSERT INTO agent_steps
      (run_id, sequence, tool_name, category, status, input_json, output_json, error_json, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('succeeded', 'failed', 'skipped') THEN CURRENT_TIMESTAMP ELSE NULL END)`)
      .run(runId, sequence, toolName, category, status, JSON.stringify(input), output == null ? null : JSON.stringify(output),
        error == null ? null : JSON.stringify(error), status);
  }

  finishAgentRun(runId, status, summary = {}, error = null) {
    this.db.prepare(`UPDATE agent_runs SET status=?, summary_json=?, error_json=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(status, JSON.stringify(summary), error == null ? null : JSON.stringify(error), runId);
  }

  reconcileAgentCases(runId, cases) {
    return this.transaction(() => {
      const seen = new Set();
      const upsert = this.db.prepare(`INSERT INTO agent_cases (
        id, case_key, current_run_id, kind, priority, state, disposition, confidence, owner_name,
        queue, assignee_id, assignee_name, required_permission, commercial_owner_id, commercial_owner_name,
        title, rationale, action_type, action_payload_json, amount_cents, currency,
        evidence_json, trace_json, source_coverage_json
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_key) DO UPDATE SET
        current_run_id=excluded.current_run_id, kind=excluded.kind, priority=excluded.priority,
        state=CASE WHEN agent_cases.state IN ('dismissed', 'resolved', 'snoozed') THEN agent_cases.state ELSE 'open' END,
        disposition=excluded.disposition, confidence=excluded.confidence, owner_name=excluded.owner_name,
        queue=excluded.queue,
        assignee_id=COALESCE(agent_cases.assignee_id, excluded.assignee_id),
        assignee_name=COALESCE(agent_cases.assignee_name, excluded.assignee_name),
        required_permission=excluded.required_permission,
        commercial_owner_id=excluded.commercial_owner_id, commercial_owner_name=excluded.commercial_owner_name,
        title=excluded.title, rationale=excluded.rationale, action_type=excluded.action_type,
        action_payload_json=excluded.action_payload_json, amount_cents=excluded.amount_cents,
        currency=excluded.currency, evidence_json=excluded.evidence_json, trace_json=excluded.trace_json,
        source_coverage_json=excluded.source_coverage_json, last_seen_at=CURRENT_TIMESTAMP`);
      for (const item of cases) {
        seen.add(item.caseKey);
        const id = `case:${item.caseKey}`;
        const assignment = item.assignment ?? {};
        upsert.run(id, item.caseKey, runId, item.kind, item.priority, item.disposition,
          item.confidence, item.ownerName, assignment.queue ?? 'cash_application', assignment.assigneeId ?? null,
          assignment.assigneeName ?? null, assignment.requiredPermission ?? 'payments:view',
          assignment.commercialOwnerId ?? null, assignment.commercialOwnerName ?? null,
          item.title, item.rationale, item.action.type,
          JSON.stringify(item.action.payload ?? {}), item.amountCents ?? null, item.currency ?? null,
          JSON.stringify(item.evidence ?? []), JSON.stringify(item.trace ?? []), JSON.stringify(item.sourceCoverage ?? {}));
      }
      const open = this.db.prepare(`SELECT id, case_key FROM agent_cases WHERE state IN ('open', 'snoozed')`).all();
      for (const row of open) if (!seen.has(row.case_key)) {
        this.db.prepare(`UPDATE agent_cases SET state='resolved', resolved_at=CURRENT_TIMESTAMP,
          resolution_json=? WHERE id=?`).run(JSON.stringify({ reason: 'condition_cleared', runId }), row.id);
        this.db.prepare(`INSERT INTO agent_case_events (case_id, event_type, actor, detail_json)
          VALUES (?, 'auto_resolved', 'agent', ?)`).run(row.id, JSON.stringify({ runId }));
      }
    });
  }

  listAgentCases(state = null) {
    const rows = state
      ? this.db.prepare(`SELECT * FROM agent_cases WHERE state=? ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, last_seen_at DESC`).all(state)
      : this.db.prepare(`SELECT * FROM agent_cases ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, last_seen_at DESC`).all();
    return rows.map(mapAgentCase);
  }

  getAgentCase(id) {
    const row = this.db.prepare('SELECT * FROM agent_cases WHERE id=?').get(id);
    if (!row) return null;
    const events = this.db.prepare('SELECT * FROM agent_case_events WHERE case_id=? ORDER BY id').all(id).map((event) => ({
      id: event.id, eventType: event.event_type, actor: event.actor,
      detail: parseJson(event.detail_json, {}), createdAt: event.created_at
    }));
    return { ...mapAgentCase(row), events };
  }

  updateAgentCase(id, { state, ownerName, assigneeId, assigneeName, actor, eventType, detail = {} }) {
    const current = this.getAgentCase(id);
    if (!current) return null;
    this.transaction(() => {
      this.db.prepare(`UPDATE agent_cases SET state=COALESCE(?, state), owner_name=COALESCE(?, owner_name),
        assignee_id=COALESCE(?, assignee_id), assignee_name=COALESCE(?, assignee_name),
        resolved_at=CASE WHEN ? IN ('resolved', 'dismissed') THEN CURRENT_TIMESTAMP ELSE resolved_at END,
        resolution_json=CASE WHEN ? IN ('resolved', 'dismissed') THEN ? ELSE resolution_json END WHERE id=?`)
        .run(state ?? null, ownerName ?? null, assigneeId ?? null, assigneeName ?? null,
          state ?? null, state ?? null, JSON.stringify(detail), id);
      this.db.prepare(`INSERT INTO agent_case_events (case_id, event_type, actor, detail_json) VALUES (?, ?, ?, ?)`)
        .run(id, eventType, actor, JSON.stringify(detail));
    });
    return this.getAgentCase(id);
  }

  recordAgentCaseLabel(caseId, { reviewer, verdict, expectedAllocations = [], reviewSeconds = null,
    baselineSeconds = null, note = null }) {
    const item = this.getAgentCase(caseId);
    if (!item) throw new Error('Agent case not found');
    if (!['correct', 'incorrect', 'not_applicable'].includes(verdict)) throw new Error('Invalid label verdict');
    if (!Array.isArray(expectedAllocations)) throw new Error('Expected allocations must be an array');
    for (const value of [reviewSeconds, baselineSeconds]) {
      if (value != null && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 86400)) {
        throw new Error('Review timing must be an integer between 0 and 86400 seconds');
      }
    }
    const policyVersion = this.getAgentRun(item.currentRunId)?.policyVersion ?? 'unknown';
    const id = this.transaction(() => {
      const inserted = this.db.prepare(`INSERT INTO agent_case_labels
        (case_id, reviewer, policy_version, verdict, expected_allocations_json, review_seconds, baseline_seconds, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(caseId, reviewer, policyVersion, verdict, JSON.stringify(expectedAllocations),
        reviewSeconds == null ? null : Number(reviewSeconds), baselineSeconds == null ? null : Number(baselineSeconds), note);
      this.db.prepare(`INSERT INTO agent_case_events (case_id, event_type, actor, detail_json)
        VALUES (?, 'case_labeled', ?, ?)`).run(caseId, reviewer,
        JSON.stringify({ verdict, expectedAllocations, reviewSeconds, baselineSeconds, note }));
      return Number(inserted.lastInsertRowid);
    });
    return this.listAgentCaseLabels(caseId).find((item) => item.id === id);
  }

  listAgentCaseLabels(caseId = null) {
    const rows = caseId
      ? this.db.prepare('SELECT * FROM agent_case_labels WHERE case_id=? ORDER BY id').all(caseId)
      : this.db.prepare('SELECT * FROM agent_case_labels ORDER BY id').all();
    return rows.map((row) => ({
      id: row.id, caseId: row.case_id, reviewer: row.reviewer, policyVersion: row.policy_version, verdict: row.verdict,
      expectedAllocations: parseJson(row.expected_allocations_json, []), reviewSeconds: row.review_seconds,
      baselineSeconds: row.baseline_seconds, note: row.note, createdAt: row.created_at
    }));
  }

  getAgentRun(id) {
    const run = this.db.prepare('SELECT * FROM agent_runs WHERE id=?').get(id);
    if (!run) return null;
    const steps = this.db.prepare('SELECT * FROM agent_steps WHERE run_id=? ORDER BY sequence').all(id).map(mapAgentStep);
    return mapAgentRun(run, steps);
  }

  getLatestAgentRun() {
    const run = this.db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 1').get();
    return run ? this.getAgentRun(run.id) : null;
  }

  getAgentOutcomeMetrics() {
    const currentPolicy = this.db.prepare('SELECT policy_version FROM agent_runs ORDER BY id DESC LIMIT 1').get()?.policy_version ?? null;
    const cases = this.db.prepare(`SELECT
      COUNT(*) total_cases,
      SUM(CASE WHEN c.disposition='ready_for_approval' THEN 1 ELSE 0 END) ready_for_approval,
      SUM(CASE WHEN c.state='open' THEN 1 ELSE 0 END) open_cases
      FROM agent_cases c JOIN agent_runs r ON r.id=c.current_run_id
      WHERE r.policy_version=?`).get(currentPolicy);
    const outcomes = this.db.prepare(`SELECT e.event_type, COUNT(DISTINCT e.case_id) count
      FROM agent_case_events e
      JOIN agent_cases c ON c.id=e.case_id
      JOIN agent_runs r ON r.id=c.current_run_id
      WHERE r.policy_version=? AND e.event_type IN ('allocation_approved', 'allocation_executed', 'allocation_rejected')
      GROUP BY e.event_type`).all(currentPolicy);
    const byType = Object.fromEntries(outcomes.map((row) => [row.event_type, Number(row.count)]));
    const accepted = (byType.allocation_approved ?? 0) + (byType.allocation_executed ?? 0);
    const rejected = byType.allocation_rejected ?? 0;
    const reviewed = accepted + rejected;
    const latestLabels = this.db.prepare(`SELECT l.*, c.disposition
      FROM agent_case_labels l
      JOIN (SELECT case_id, MAX(id) id FROM agent_case_labels WHERE policy_version=? GROUP BY case_id) latest ON latest.id=l.id
      JOIN agent_cases c ON c.id=l.case_id
      JOIN agent_runs r ON r.id=c.current_run_id
      WHERE l.policy_version=? AND r.policy_version=?`).all(currentPolicy, currentPolicy, currentPolicy);
    const labeledReady = latestLabels.filter((row) => row.disposition === 'ready_for_approval' && row.verdict !== 'not_applicable');
    const correctReady = labeledReady.filter((row) => row.verdict === 'correct');
    const readyCases = this.db.prepare(`SELECT c.evidence_json FROM agent_cases c
      JOIN agent_runs r ON r.id=c.current_run_id
      WHERE c.disposition='ready_for_approval' AND r.policy_version=?`).all(currentPolicy);
    const groundedReady = readyCases.filter((row) => {
      const authorities = new Set(parseJson(row.evidence_json, []).map((item) => item.authority));
      return authorities.has('receipt_authority') && authorities.has('invoice_authority');
    });
    const reviewDurations = latestLabels.map((row) => row.review_seconds).filter(Number.isInteger).sort((a, b) => a - b);
    const baselineDurations = latestLabels.map((row) => row.baseline_seconds).filter(Number.isInteger).sort((a, b) => a - b);
    const medianReviewSeconds = median(reviewDurations);
    const medianBaselineSeconds = median(baselineDurations);
    const unsafeFinancialWrites = this.db.prepare('SELECT summary_json FROM agent_runs').all()
      .reduce((sum, row) => sum + Number(parseJson(row.summary_json, {}).financialWrites ?? 0), 0);
    const duplicateRecordedPayments = Number(this.db.prepare(`SELECT COUNT(*) count FROM (
      SELECT invoice_id, reference FROM lago_payments
      WHERE status='succeeded' AND reference LIKE 'lgr:%'
      GROUP BY invoice_id, reference HAVING COUNT(*) > 1
    )`).get().count ?? 0);
    return {
      policyVersion: currentPolicy,
      metricsScope: 'current_policy',
      totalCases: Number(cases.total_cases ?? 0),
      readyForApproval: Number(cases.ready_for_approval ?? 0),
      openCases: Number(cases.open_cases ?? 0),
      reviewedCases: reviewed,
      acceptedCases: accepted,
      rejectedCases: rejected,
      reviewerAcceptanceRate: reviewed ? accepted / reviewed : null,
      labeledReadyCases: labeledReady.length,
      correctReadyCases: correctReady.length,
      labeledPrecision: labeledReady.length ? correctReady.length / labeledReady.length : null,
      readyEvidenceCoverage: readyCases.length ? groundedReady.length / readyCases.length : null,
      medianReviewSeconds,
      medianBaselineSeconds,
      medianSecondsSaved: medianReviewSeconds != null && medianBaselineSeconds != null ? medianBaselineSeconds - medianReviewSeconds : null,
      unsafeFinancialWrites,
      duplicateRecordedPayments,
      note: 'Metrics are scoped to the current policy. Acceptance measures workflow adoption; labeled precision compares Ready-to-approve cases with reviewer ground truth.'
    };
  }

  getPilotReadiness() {
    const metrics = this.getAgentOutcomeMetrics();
    const gates = [
      gate('labeled_sample', metrics.labeledReadyCases >= 30, metrics.labeledReadyCases, 'At least 30 labeled Ready-to-approve cases'),
      gate('precision', metrics.labeledPrecision === 1, metrics.labeledPrecision, '100% labeled precision before automation'),
      gate('acceptance', metrics.reviewedCases >= 30 && metrics.reviewerAcceptanceRate >= 0.95,
        metrics.reviewerAcceptanceRate, 'At least 95% reviewer acceptance across 30 reviews'),
      gate('evidence', metrics.readyEvidenceCoverage === 1, metrics.readyEvidenceCoverage, 'Every ready case cites receipt and invoice authority'),
      gate('autonomous_writes', metrics.unsafeFinancialWrites === 0, metrics.unsafeFinancialWrites, 'Zero autonomous financial writes'),
      gate('duplicate_payments', metrics.duplicateRecordedPayments === 0, metrics.duplicateRecordedPayments, 'Zero duplicate Lago payments'),
      gate('operator_time', metrics.medianSecondsSaved != null && metrics.medianSecondsSaved > 0,
        metrics.medianSecondsSaved, 'Median handling time decreases against the recorded baseline')
    ];
    return {
      ready: gates.every((item) => item.passed),
      readyFor: 'shadow_pilot_review',
      productionReady: false,
      automationEligible: false,
      mode: 'shadow',
      gates,
      metrics,
      limitations: [
        'Duplicate-payment coverage is limited to the local Lago payment projection.',
        'Ingestion completeness and operator workflow impact require live pilot verification.',
        'Passing these gates never authorizes unattended execution.'
      ]
    };
  }

  replaceIdentityEdges(edges) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM identity_edges').run();
      const insert = this.db.prepare(`INSERT INTO identity_edges
        (id, source, source_record_id, edge_type, from_type, from_id, to_type, to_id, label, confidence, verified, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const edge of edges) insert.run(edge.id, edge.source, edge.sourceRecordId, edge.edgeType,
        edge.fromType, edge.fromId, edge.toType, edge.toId, edge.label ?? null,
        edge.confidence, edge.verified ? 1 : 0, JSON.stringify(edge.evidence ?? {}));
    });
  }

  listIdentityEdges() {
    return this.db.prepare('SELECT * FROM identity_edges ORDER BY verified DESC, confidence DESC, id').all().map((row) => ({
      id: row.id, source: row.source, sourceRecordId: row.source_record_id, edgeType: row.edge_type,
      fromType: row.from_type, fromId: row.from_id, toType: row.to_type, toId: row.to_id,
      label: row.label, confidence: row.confidence, verified: Boolean(row.verified), evidence: parseJson(row.evidence_json, {})
    }));
  }

  upsertAgentPlaybook(playbook) {
    this.db.prepare(`INSERT INTO agent_playbooks
      (id, name, enabled, version, conditions_json, effects_json, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled,
        version=agent_playbooks.version + 1, conditions_json=excluded.conditions_json,
        effects_json=excluded.effects_json, updated_at=CURRENT_TIMESTAMP`)
      .run(playbook.id, playbook.name, playbook.enabled === false ? 0 : 1, playbook.version ?? 1,
        JSON.stringify(playbook.conditions ?? {}), JSON.stringify(playbook.effects ?? {}), playbook.createdBy);
    return this.getAgentPlaybook(playbook.id);
  }

  getAgentPlaybook(id) {
    const row = this.db.prepare('SELECT * FROM agent_playbooks WHERE id=?').get(id);
    return row ? mapPlaybook(row) : null;
  }

  listAgentPlaybooks(enabledOnly = false) {
    const rows = enabledOnly
      ? this.db.prepare('SELECT * FROM agent_playbooks WHERE enabled=1 ORDER BY name').all()
      : this.db.prepare('SELECT * FROM agent_playbooks ORDER BY name').all();
    return rows.map(mapPlaybook);
  }

  upsertStripeCashTransaction(event) {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO stripe_cash_transactions
        (id, customer_id, type, amount_cents, currency, created_at_provider, payment_intent_id, reference, sender_name, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET type=excluded.type, amount_cents=excluded.amount_cents,
        payment_intent_id=excluded.payment_intent_id, reference=excluded.reference, sender_name=excluded.sender_name,
        raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`).run(
        event.id, event.customerId, event.type, event.amountCents, event.currency, event.createdAt,
        event.paymentIntentId ?? null, event.reference ?? null, event.senderName ?? null, safeJson(event.raw ?? event));
      if (event.type === 'funded' && Number(event.amountCents) > 0) {
        const receiptId = `stripe:${event.customerId}:${event.id}`;
        this.db.prepare(`INSERT INTO cash_receipts (
          id, source_system, source_account_id, source_record_id, status, gross_amount_cents, currency,
          received_at, counterparty_name, reference, raw_json
        ) VALUES (?, 'stripe_cash_balance', ?, ?, 'posted', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_system, source_account_id, source_record_id) DO UPDATE SET
          status=excluded.status, gross_amount_cents=excluded.gross_amount_cents, currency=excluded.currency,
          received_at=excluded.received_at, counterparty_name=excluded.counterparty_name,
          reference=excluded.reference, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`).run(
          receiptId, event.customerId, event.id, event.amountCents, event.currency, event.createdAt,
          event.senderName ?? null, event.reference ?? null, safeJson(event.raw ?? event)
        );
      }
    });
  }

  upsertStripePaymentIntent(intent) {
    this.db.prepare(`INSERT INTO stripe_payment_intents
      (id, customer_id, status, amount_cents, amount_received_cents, currency, created_at_provider,
       invoice_id, invoice_number, payment_id, description, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, amount_received_cents=excluded.amount_received_cents,
      invoice_id=excluded.invoice_id, invoice_number=excluded.invoice_number, payment_id=excluded.payment_id,
      description=excluded.description, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`).run(
      intent.id, intent.customerId, intent.status, intent.amountCents, intent.amountReceivedCents,
      intent.currency, intent.createdAt, intent.invoiceId ?? null, intent.invoiceNumber ?? null, intent.paymentId ?? null,
      intent.description ?? null, safeJson(intent.raw ?? intent));
  }

  replaceIncidents(scope, incidents) {
    this.transaction(() => {
      this.db.prepare(`UPDATE reconciliation_incidents SET status='resolved', last_seen_at=CURRENT_TIMESTAMP
        WHERE scope = ? AND status = 'open'`).run(scope);
      const insert = this.db.prepare(`INSERT INTO reconciliation_incidents
        (id, kind, severity, scope, status, summary, evidence_json) VALUES (?, ?, ?, ?, 'open', ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, severity=excluded.severity, scope=excluded.scope,
        status='open', summary=excluded.summary, evidence_json=excluded.evidence_json, last_seen_at=CURRENT_TIMESTAMP`);
      incidents.forEach((row) => insert.run(row.id, row.kind, row.severity, row.scope, row.summary, JSON.stringify(row.evidence)));
    });
  }

  listIncidents(status) {
    const rows = status
      ? this.db.prepare('SELECT * FROM reconciliation_incidents WHERE status = ? ORDER BY CASE severity WHEN \'critical\' THEN 0 ELSE 1 END, last_seen_at DESC').all(status)
      : this.db.prepare('SELECT * FROM reconciliation_incidents ORDER BY last_seen_at DESC').all();
    return rows.map((row) => ({ id: row.id, kind: row.kind, severity: row.severity, scope: row.scope,
      status: row.status, summary: row.summary, evidence: parseJson(row.evidence_json, {}), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at }));
  }

  getIncident(id) { return this.listIncidents().find((item) => item.id === id) ?? null; }

  getTransfer(id) {
    const row = this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
    return row ? mapTransfer(row) : null;
  }

  setTransferReviewStatus(id, status) {
    this.db.prepare('UPDATE transfers SET review_status = ?, updated_at=CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
  }

  listTransfers(status) {
    const rows = status
      ? this.db.prepare('SELECT * FROM transfers WHERE review_status = ? ORDER BY booked_at DESC').all(status)
      : this.db.prepare('SELECT * FROM transfers ORDER BY booked_at DESC').all();
    return rows.map((row) => ({ ...mapTransfer(row), proposals: this.listProposals(row.id) }));
  }

  getReceipt(id) {
    const row = this.db.prepare(`SELECT r.*,
      COALESCE(SUM(CASE WHEN a.status IN ('approved', 'executed', 'confirmed', 'reversal_required') THEN a.amount_cents ELSE 0 END), 0) allocated_amount_cents
      FROM cash_receipts r LEFT JOIN cash_allocations a ON a.receipt_id = r.id
      WHERE r.id = ? GROUP BY r.id`).get(id);
    return row ? {
      ...mapReceipt(row, this.listAllocations(id), this.listAdjustments(id)),
      evidenceLinks: this.listReceiptEvidence(id), remittanceClaims: this.listRemittanceClaims(id)
    } : null;
  }

  listReceipts() {
    return this.db.prepare(`SELECT r.*,
      COALESCE(SUM(CASE WHEN a.status IN ('approved', 'executed', 'confirmed', 'reversal_required') THEN a.amount_cents ELSE 0 END), 0) allocated_amount_cents
      FROM cash_receipts r LEFT JOIN cash_allocations a ON a.receipt_id = r.id
      GROUP BY r.id ORDER BY r.received_at DESC`).all().map((row) => ({
        ...mapReceipt(row, this.listAllocations(row.id), this.listAdjustments(row.id)),
        evidenceLinks: this.listReceiptEvidence(row.id), remittanceClaims: this.listRemittanceClaims(row.id)
      }));
  }

  attachReceiptEvidence({ receiptId, sourceSystem, sourceRecordId, relation, direction = 'unknown',
    authority, amountCents = null, currency = null, occurredAt = null, metadata = {}, addedBy }) {
    if (!this.db.prepare('SELECT 1 FROM cash_receipts WHERE id=?').get(receiptId)) throw new Error('Receipt not found');
    if (!sourceSystem || !sourceRecordId || !relation || !authority || !addedBy) throw new Error('Evidence identity, relation, authority, and actor are required');
    if (direction === 'debit' && authority === 'receipt_authority') throw new Error('An outgoing payment cannot be receipt authority');
    if (amountCents != null && (!Number.isInteger(Number(amountCents)) || Number(amountCents) <= 0)) throw new Error('Evidence amount must be a positive integer');
    const id = `${receiptId}:${sourceSystem}:${sourceRecordId}:${relation}`;
    this.db.prepare(`INSERT INTO receipt_evidence_links
      (id, receipt_id, source_system, source_record_id, relation, direction, authority,
       amount_cents, currency, occurred_at, metadata_json, added_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(receipt_id, source_system, source_record_id, relation) DO UPDATE SET
        direction=excluded.direction, authority=excluded.authority, amount_cents=excluded.amount_cents,
        currency=excluded.currency, occurred_at=excluded.occurred_at, metadata_json=excluded.metadata_json,
        added_by=excluded.added_by, updated_at=CURRENT_TIMESTAMP`).run(
      id, receiptId, sourceSystem, sourceRecordId, relation, direction, authority,
      amountCents == null ? null : Number(amountCents), currency, occurredAt, safeJson(metadata), addedBy
    );
    return this.listReceiptEvidence(receiptId).find((item) => item.id === id);
  }

  listReceiptEvidence(receiptId) {
    return this.db.prepare('SELECT * FROM receipt_evidence_links WHERE receipt_id=? ORDER BY created_at, id').all(receiptId).map((row) => ({
      id: row.id, receiptId: row.receipt_id, sourceSystem: row.source_system,
      sourceRecordId: row.source_record_id, relation: row.relation, direction: row.direction,
      authority: row.authority, amountCents: row.amount_cents, currency: row.currency,
      occurredAt: row.occurred_at, metadata: parseJson(row.metadata_json, {}),
      addedBy: row.added_by, createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  upsertRemittanceDocument({ receiptId, sourceSystem, sourceRecordId, mimeType, contentHash,
    extractor, extractorVersion = null, metadata = {}, claims, addedBy }) {
    if (!this.db.prepare('SELECT 1 FROM cash_receipts WHERE id=?').get(receiptId)) throw new Error('Receipt not found');
    if (!sourceSystem || !sourceRecordId || !mimeType || !contentHash || !extractor || !addedBy) {
      throw new Error('Remittance source, MIME type, content hash, extractor, and actor are required');
    }
    validateRemittanceClaims(claims);
    const id = `remittance:${hash(`${receiptId}:${sourceSystem}:${sourceRecordId}`).slice(0, 32)}`;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO remittance_documents
        (id, receipt_id, source_system, source_record_id, mime_type, content_hash,
         extractor, extractor_version, metadata_json, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(receipt_id, source_system, source_record_id) DO UPDATE SET
          mime_type=excluded.mime_type, content_hash=excluded.content_hash, extractor=excluded.extractor,
          extractor_version=excluded.extractor_version, status='extracted', metadata_json=excluded.metadata_json,
          added_by=excluded.added_by, updated_at=CURRENT_TIMESTAMP`).run(
        id, receiptId, sourceSystem, sourceRecordId, mimeType, contentHash,
        extractor, extractorVersion, safeJson(metadata), addedBy
      );
      this.db.prepare('DELETE FROM remittance_claims WHERE document_id=?').run(id);
      const insert = this.db.prepare(`INSERT INTO remittance_claims
        (id, document_id, invoice_number, amount_cents, currency, citation_locator,
         citation_excerpt, citation_text_hash, extraction_confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      claims.forEach((claim, index) => insert.run(
        `${id}:${index + 1}`, id, claim.invoiceNumber, claim.amountCents, claim.currency,
        claim.citation.locator, redactSensitive(claim.citation.excerpt), claim.citation.textHash,
        claim.extractionConfidence ?? null
      ));
      this.db.prepare(`INSERT INTO cash_application_events
        (event_type, receipt_id, actor, detail_json) VALUES ('remittance_extracted', ?, ?, ?)`).run(
        receiptId, addedBy, JSON.stringify({ documentId: id, sourceSystem, sourceRecordId, claimCount: claims.length })
      );
    });
    return this.getRemittanceDocument(id);
  }

  getRemittanceDocument(id) {
    const row = this.db.prepare('SELECT * FROM remittance_documents WHERE id=?').get(id);
    return row ? mapRemittanceDocument(row, this.db.prepare(
      'SELECT * FROM remittance_claims WHERE document_id=? ORDER BY id').all(id).map(mapRemittanceClaim)) : null;
  }

  listRemittanceClaims(receiptId) {
    return this.db.prepare(`SELECT c.* FROM remittance_claims c
      JOIN remittance_documents d ON d.id=c.document_id
      WHERE d.receipt_id=? AND d.status='extracted' ORDER BY d.created_at, c.id`).all(receiptId).map(mapRemittanceClaim);
  }

  upsertCashApplicationPolicy(policy, actor) {
    validateCashApplicationPolicy(policy);
    this.db.prepare(`INSERT INTO cash_application_policies
      (customer_id, max_bank_fee_cents, withholding_bps, max_short_pay_cents,
       max_short_pay_bps, enabled, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET version=version + 1,
        max_bank_fee_cents=excluded.max_bank_fee_cents, withholding_bps=excluded.withholding_bps,
        max_short_pay_cents=excluded.max_short_pay_cents, max_short_pay_bps=excluded.max_short_pay_bps,
        enabled=excluded.enabled, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`).run(
      policy.customerId, policy.maxBankFeeCents ?? 0, policy.withholdingBps ?? 0,
      policy.maxShortPayCents ?? 0, policy.maxShortPayBps ?? 0, policy.enabled === false ? 0 : 1, actor
    );
    this.audit('cash_application_policy_updated', 'customer', policy.customerId, actor, {
      maxBankFeeCents: policy.maxBankFeeCents ?? 0, withholdingBps: policy.withholdingBps ?? 0,
      maxShortPayCents: policy.maxShortPayCents ?? 0, maxShortPayBps: policy.maxShortPayBps ?? 0,
      enabled: policy.enabled !== false
    });
    return this.getCashApplicationPolicy(policy.customerId);
  }

  getCashApplicationPolicy(customerId) {
    const row = this.db.prepare('SELECT * FROM cash_application_policies WHERE customer_id=?').get(customerId);
    return row ? mapCashApplicationPolicy(row) : null;
  }

  listCashApplicationPolicies(enabledOnly = true) {
    const rows = enabledOnly
      ? this.db.prepare('SELECT * FROM cash_application_policies WHERE enabled=1 ORDER BY customer_id').all()
      : this.db.prepare('SELECT * FROM cash_application_policies ORDER BY customer_id').all();
    return rows.map(mapCashApplicationPolicy);
  }

  listAllocations(receiptId) {
    return this.db.prepare('SELECT * FROM cash_allocations WHERE receipt_id = ? ORDER BY id').all(receiptId).map(mapAllocation);
  }

  listAdjustments(receiptId) {
    return this.db.prepare('SELECT * FROM cash_application_adjustments WHERE receipt_id = ? ORDER BY id').all(receiptId).map(mapAdjustment);
  }

  // The same money seen through another source (e.g. a Qonto sync and a CSV export of that account)
  // gets a second receipt. Find one that is already applied: same amount, currency and day.
  findAppliedLookalikeReceipt(receiptId) {
    return this.db.prepare(`SELECT other.id, other.source_system sourceSystem, other.gross_amount_cents amountCents,
        other.currency, substr(other.received_at, 1, 10) receivedOn, invoice.number invoiceNumber
      FROM cash_receipts receipt
      JOIN cash_receipts other ON other.id != receipt.id AND other.currency = receipt.currency
        AND other.gross_amount_cents = receipt.gross_amount_cents
        AND substr(other.received_at, 1, 10) = substr(receipt.received_at, 1, 10)
        AND other.status != 'reversed'
        AND NOT (other.source_system = receipt.source_system AND other.source_account_id = receipt.source_account_id)
      JOIN cash_allocations allocation ON allocation.receipt_id = other.id
        AND allocation.status IN ('approved', 'executed', 'confirmed', 'reversal_required')
      LEFT JOIN invoices invoice ON invoice.id = allocation.invoice_id
      WHERE receipt.id = ? LIMIT 1`).get(receiptId) ?? null;
  }

  getReceiptCommittedAmount(receiptId) {
    const row = this.db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) amount
      FROM cash_allocations WHERE receipt_id=? AND status IN ('approved', 'executed', 'confirmed', 'reversal_required')`).get(receiptId);
    return Number(row.amount ?? 0);
  }

  getInvoiceAllocationExposure(invoiceId) {
    const allocation = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('approved', 'executed') THEN amount_cents ELSE 0 END), 0) reserved_amount,
      SUM(CASE WHEN status='reversal_required' THEN 1 ELSE 0 END) reversal_count
      FROM cash_allocations WHERE invoice_id=?`).get(invoiceId);
    const adjustment = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('approved', 'executed') THEN amount_cents ELSE 0 END), 0) reserved_amount,
      SUM(CASE WHEN status='reversal_required' THEN 1 ELSE 0 END) reversal_count
      FROM cash_application_adjustments WHERE invoice_id=?`).get(invoiceId);
    return {
      reservedAmountCents: Number(allocation.reserved_amount ?? 0) + Number(adjustment.reserved_amount ?? 0),
      reversalRequired: Number(allocation.reversal_count ?? 0) + Number(adjustment.reversal_count ?? 0) > 0
    };
  }

  excludeRejectedProposals(transferId, proposals) {
    const rejected = new Set(this.db.prepare(`SELECT p.allocations_json FROM decisions d
      JOIN proposals p ON p.id = d.proposal_id
      WHERE d.transfer_id = ? AND d.action = 'reject'`).all(transferId)
      .map(row => matchIdentity(JSON.parse(row.allocations_json))));
    return proposals.filter(proposal => !rejected.has(matchIdentity(proposal.allocations)));
  }

  replaceProposals(transferId, proposals) {
    const accepted = this.excludeRejectedProposals(transferId, proposals);
    this.transaction(() => {
      this.db.prepare(`DELETE FROM proposals WHERE transfer_id = ?
        AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = proposals.id)`).run(transferId);
      this.db.prepare(`UPDATE proposals SET rank = -id WHERE transfer_id = ?
        AND EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = proposals.id)`).run(transferId);
      const insert = this.db.prepare(`INSERT INTO proposals
        (transfer_id, rank, kind, score, confidence, margin, allocations_json, adjustments_json,
         signals_json, explanation, auto_eligible, policy_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      accepted.forEach((proposal, index) => insert.run(
        transferId, index + 1, proposal.kind, proposal.score, proposal.confidence ?? 'possible', proposal.margin ?? 0,
        JSON.stringify(proposal.allocations), JSON.stringify(proposal.adjustments ?? []), JSON.stringify(proposal.signals), proposal.explanation,
        proposal.autoEligible ? 1 : 0, POLICY_VERSION
      ));
    });
    return accepted;
  }

  listProposals(transferId) {
    return this.excludeRejectedProposals(transferId, this.db.prepare(`SELECT p.*, GROUP_CONCAT(i.number, ', ') AS invoice_numbers,
      GROUP_CONCAT(i.customer_name, ', ') AS customer_names
      FROM proposals p
      JOIN transfers t ON t.id = p.transfer_id
      LEFT JOIN json_each(p.allocations_json) a
      LEFT JOIN invoices i ON i.id = json_extract(a.value, '$.invoiceId')
      WHERE p.transfer_id = ?
        AND t.review_status != 'exception'
        AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id)
      GROUP BY p.id ORDER BY p.rank`).all(transferId).map(mapProposal));
  }

  getProposal(id) {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
    return row ? mapProposal(row) : null;
  }

  listIdentities() {
    return this.db.prepare('SELECT * FROM confirmed_identities').all().map((row) => ({
      fingerprint: row.fingerprint, customerId: row.customer_id, label: row.label
    }));
  }

  decide({ transferId, proposalId = null, action, allocations = [], adjustments = [], actor, note = null }) {
    return this.transaction(() => {
      if (action === 'approve') this.assertApplicationCapacity(transferId, allocations, adjustments);
      const result = this.db.prepare(`INSERT INTO decisions
        (transfer_id, proposal_id, action, allocations_json, adjustments_json, actor, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        transferId, proposalId, action, JSON.stringify(allocations), JSON.stringify(adjustments), actor, note);
      const decisionId = Number(result.lastInsertRowid);
      if (action === 'approve') {
        const receipt = this.db.prepare('SELECT currency FROM cash_receipts WHERE id = ?').get(transferId);
        if (!receipt) throw new Error(`Cash receipt not found: ${transferId}`);
        const insert = this.db.prepare(`INSERT INTO cash_allocations
          (receipt_id, invoice_id, amount_cents, currency, status, decision_id, actor, note)
          VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)`);
        const event = this.db.prepare(`INSERT INTO cash_application_events
          (event_type, receipt_id, allocation_id, actor, detail_json) VALUES ('allocation_approved', ?, ?, ?, ?)`);
        for (const allocation of allocations) {
          const inserted = insert.run(transferId, allocation.invoiceId, allocation.amountCents, receipt.currency, decisionId, actor, note);
          const allocationId = Number(inserted.lastInsertRowid);
          event.run(transferId, allocationId, actor, JSON.stringify({ decisionId, ...allocation }));
        }
        const insertAdjustment = this.db.prepare(`INSERT INTO cash_application_adjustments
          (receipt_id, invoice_id, type, amount_cents, currency, status, decision_id, policy_version, actor, note)
          VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`);
        const adjustmentEvent = this.db.prepare(`INSERT INTO cash_application_events
          (event_type, receipt_id, actor, detail_json) VALUES ('adjustment_approved', ?, ?, ?)`);
        for (const adjustment of adjustments) {
          const inserted = insertAdjustment.run(transferId, adjustment.invoiceId, adjustment.type,
            adjustment.amountCents, receipt.currency, decisionId, adjustment.policyVersion, actor, note);
          adjustmentEvent.run(transferId, actor, JSON.stringify({
            decisionId, adjustmentId: Number(inserted.lastInsertRowid), ...adjustment
          }));
        }
      }
      const status = action === 'approve' ? 'approved' : action === 'reject' ? 'unreviewed' : 'held';
      this.db.prepare('UPDATE transfers SET review_status = ?, updated_at=CURRENT_TIMESTAMP WHERE id = ?').run(status, transferId);
      this.audit('review_decision', 'transfer', transferId, actor, { action, proposalId, allocations, adjustments, note });
      return decisionId;
    });
  }

  assertApplicationCapacity(receiptId, allocations, adjustments = []) {
    const receipt = this.db.prepare('SELECT status, gross_amount_cents, currency FROM cash_receipts WHERE id=?').get(receiptId);
    if (!receipt) throw new Error(`Cash receipt not found: ${receiptId}`);
    if (receipt.status === 'reversed') throw new Error('A reversed receipt cannot be allocated');
    if (!Array.isArray(allocations) || !allocations.length) throw new Error('At least one invoice allocation is required');
    if (!Array.isArray(adjustments)) throw new Error('Adjustments must be an array');

    const invoiceIds = new Set();
    for (const allocation of allocations) {
      if (!allocation?.invoiceId || invoiceIds.has(allocation.invoiceId)) throw new Error('Each allocation must reference a distinct invoice');
      invoiceIds.add(allocation.invoiceId);
      if (!Number.isInteger(allocation.amountCents) || allocation.amountCents <= 0) {
        throw new Error('Allocation amount must be positive integer minor units');
      }
    }
    const adjustedInvoiceIds = new Set();
    for (const adjustment of adjustments) {
      if (!invoiceIds.has(adjustment.invoiceId)) throw new Error('Every adjustment must accompany cash applied to the same invoice');
      if (adjustedInvoiceIds.has(adjustment.invoiceId)) throw new Error('An invoice can have at most one settlement adjustment per decision');
      adjustedInvoiceIds.add(adjustment.invoiceId);
      if (!['bank_fee_writeoff', 'withholding_tax', 'short_pay'].includes(adjustment.type)) throw new Error('Unknown settlement adjustment type');
      if (adjustment.currency !== receipt.currency) throw new Error('Adjustment currency does not match receipt');
      if (!Number.isInteger(adjustment.amountCents) || adjustment.amountCents <= 0 || !Number.isInteger(adjustment.policyVersion)) {
        throw new Error('Adjustment amount and policy version must be positive integers');
      }
    }

    const proposedCash = allocations.reduce((sum, item) => sum + item.amountCents, 0);
    const reservedCash = Number(this.db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) amount
      FROM cash_allocations WHERE receipt_id=? AND status IN ('approved', 'executed', 'confirmed', 'reversal_required')`).get(receiptId).amount);
    if (reservedCash + proposedCash > receipt.gross_amount_cents) {
      throw new Error(`Cash allocation exceeds receipt value: ${reservedCash} already allocated, ${receipt.gross_amount_cents - reservedCash} available`);
    }

    const plannedByInvoice = new Map();
    for (const item of [...allocations, ...adjustments]) {
      plannedByInvoice.set(item.invoiceId, (plannedByInvoice.get(item.invoiceId) ?? 0) + item.amountCents);
    }
    let customerId = null;
    for (const [invoiceId, proposed] of plannedByInvoice) {
      const invoice = this.db.prepare('SELECT customer_id, currency, remaining_amount_cents, payment_status FROM invoices WHERE id=?').get(invoiceId);
      if (!invoice || invoice.payment_status === 'succeeded' || invoice.remaining_amount_cents <= 0) throw new Error(`Invoice is not open: ${invoiceId}`);
      if (invoice.currency !== receipt.currency) throw new Error('Allocation currency does not match receipt');
      if (customerId && customerId !== invoice.customer_id) throw new Error('A receipt cannot cross Lago customers');
      customerId = invoice.customer_id;
      const exposure = this.getInvoiceAllocationExposure(invoiceId);
      if (exposure.reversalRequired) throw new Error(`Invoice has an unresolved receipt reversal: ${invoiceId}`);
      const available = invoice.remaining_amount_cents - exposure.reservedAmountCents;
      if (proposed > available) {
        throw new Error(`Application exceeds available invoice balance: ${invoiceId}`);
      }
      if (adjustedInvoiceIds.has(invoiceId)) {
        if (proposed !== available) throw new Error('A settlement adjustment must close the available invoice balance exactly');
        const adjustmentItem = adjustments.find((item) => item.invoiceId === invoiceId);
        const policy = this.db.prepare(`SELECT * FROM cash_application_policies
          WHERE customer_id=? AND enabled=1 AND version=?`).get(invoice.customer_id, adjustmentItem.policyVersion);
        assertStoredAdjustmentAllowed(adjustmentItem, available, policy);
      }
    }
  }

  confirmIdentity({ fingerprint, customerId, label, actor, transferId }) {
    this.db.prepare(`INSERT INTO confirmed_identities
      (fingerprint, customer_id, label, confirmed_by, source_transfer_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint, customer_id) DO UPDATE SET label=excluded.label, confirmed_by=excluded.confirmed_by,
      source_transfer_id=excluded.source_transfer_id`).run(fingerprint, customerId, label, actor, transferId);
    this.audit('identity_confirmed', 'customer', customerId, actor, { fingerprint, label, transferId });
  }

  updateDecisionExecution(decisionId, status, result) {
    this.transaction(() => {
      this.db.prepare(`UPDATE decisions SET execution_status=?, execution_result_json=?,
        execution_claimed_at=NULL, execution_claimed_by=NULL WHERE id=?`)
        .run(status, JSON.stringify(result), decisionId);
      if (status === 'succeeded') {
        const allocations = this.db.prepare('SELECT * FROM cash_allocations WHERE decision_id = ?').all(decisionId);
        const payments = Array.isArray(result?.payments) ? result.payments : [];
        for (const [index, allocation] of allocations.entries()) {
          const payment = payments[index]?.payment ?? payments[index];
          const lagoPaymentId = payment?.lago_id ?? payment?.id ?? null;
          this.db.prepare(`UPDATE cash_allocations SET status='executed', lago_payment_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(lagoPaymentId, allocation.id);
          this.db.prepare(`INSERT INTO cash_application_events
            (event_type, receipt_id, allocation_id, actor, detail_json) VALUES ('allocation_executed', ?, ?, 'system', ?)`)
            .run(allocation.receipt_id, allocation.id, JSON.stringify({ decisionId, lagoPaymentId }));
        }
      }
    });
  }

  claimDecisionExecution(decisionId, actor, leaseSeconds = 300) {
    const safeLease = Math.max(30, Math.min(3600, Number(leaseSeconds) || 300));
    const result = this.db.prepare(`UPDATE decisions SET execution_status='executing', execution_result_json=NULL,
      execution_claimed_at=CURRENT_TIMESTAMP, execution_claimed_by=?, execution_attempts=execution_attempts + 1
      WHERE id=? AND (
        execution_status IN ('not_requested', 'failed', 'partial', 'uncertain') OR
        (execution_status='executing' AND execution_claimed_at <= datetime('now', ?))
      )`).run(actor, decisionId, `-${safeLease} seconds`);
    return result.changes === 1;
  }

  voidDecision(decisionId, actor, reason) {
    if (!String(reason ?? '').trim()) throw new Error('A reason is required to void an approval');
    return this.transaction(() => {
      const decision = this.db.prepare('SELECT * FROM decisions WHERE id=? AND action=\'approve\'').get(decisionId);
      if (!decision) throw Object.assign(new Error('Approved decision not found'), { status: 404 });
      if (['voided', 'reversal_required'].includes(decision.execution_status)) return this.getDecision(decisionId);
      if (decision.execution_status === 'executing') {
        throw Object.assign(new Error('An actively executing decision cannot be voided'), { status: 409 });
      }
      const allocations = this.db.prepare('SELECT * FROM cash_allocations WHERE decision_id=?').all(decisionId);
      const adjustments = this.db.prepare('SELECT * FROM cash_application_adjustments WHERE decision_id=?').all(decisionId);
      let reversalRequired = false;
      for (const allocation of allocations) {
        const next = ['executed', 'confirmed', 'reversal_required'].includes(allocation.status) ? 'reversal_required' : 'voided';
        reversalRequired ||= next === 'reversal_required';
        this.db.prepare(`UPDATE cash_allocations SET status=?, voided_at=CURRENT_TIMESTAMP,
          voided_by=?, void_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(next, actor, reason, allocation.id);
        this.db.prepare(`INSERT INTO cash_application_events
          (event_type, receipt_id, allocation_id, actor, detail_json) VALUES (?, ?, ?, ?, ?)`).run(
          next === 'voided' ? 'allocation_voided' : 'allocation_reversal_requested',
          allocation.receipt_id, allocation.id, actor, JSON.stringify({ decisionId, reason })
        );
      }
      for (const adjustment of adjustments) {
        const next = ['executed', 'reversal_required'].includes(adjustment.status) ? 'reversal_required' : 'voided';
        reversalRequired ||= next === 'reversal_required';
        this.db.prepare(`UPDATE cash_application_adjustments SET status=?, voided_at=CURRENT_TIMESTAMP,
          voided_by=?, void_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(next, actor, reason, adjustment.id);
        this.db.prepare(`INSERT INTO cash_application_events
          (event_type, receipt_id, actor, detail_json) VALUES (?, ?, ?, ?)`).run(
          next === 'voided' ? 'adjustment_voided' : 'adjustment_reversal_requested',
          adjustment.receipt_id, actor, JSON.stringify({ decisionId, adjustmentId: adjustment.id, reason })
        );
      }
      const executionStatus = reversalRequired ? 'reversal_required' : 'voided';
      this.db.prepare(`UPDATE decisions SET execution_status=?, execution_result_json=?,
        execution_claimed_at=NULL, execution_claimed_by=NULL WHERE id=?`).run(
        executionStatus, JSON.stringify({ reason, actor, reversalRequired }), decisionId
      );
      this.db.prepare('UPDATE transfers SET review_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(
        reversalRequired ? 'exception' : 'unreviewed', decision.transfer_id
      );
      this.audit('approval_voided', 'decision', String(decisionId), actor, { reason, reversalRequired });
      return this.getDecision(decisionId);
    });
  }

  markReceiptReversed(receiptId, actor = 'system') {
    this.transaction(() => {
      this.db.prepare(`UPDATE cash_receipts SET status='reversed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(receiptId);
      const allocations = this.db.prepare(`SELECT * FROM cash_allocations
        WHERE receipt_id=? AND status IN ('approved', 'executed', 'confirmed')`).all(receiptId);
      const adjustments = this.db.prepare(`SELECT * FROM cash_application_adjustments
        WHERE receipt_id=? AND status IN ('approved', 'executed')`).all(receiptId);
      const decisionIds = new Set([...allocations, ...adjustments].map((item) => item.decision_id));
      for (const allocation of allocations) {
        const next = allocation.status === 'approved' ? 'voided' : 'reversal_required';
        this.db.prepare(`UPDATE cash_allocations SET status=?, voided_at=CURRENT_TIMESTAMP,
          voided_by=?, void_reason='receipt_reversed', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(next, actor, allocation.id);
        this.db.prepare(`INSERT INTO cash_application_events
          (event_type, receipt_id, allocation_id, actor, detail_json) VALUES (?, ?, ?, ?, ?)`)
          .run(next === 'voided' ? 'allocation_voided' : 'allocation_reversal_requested',
            receiptId, allocation.id, actor, JSON.stringify({ reason: 'receipt_reversed' }));
      }
      for (const adjustment of adjustments) {
        const next = adjustment.status === 'approved' ? 'voided' : 'reversal_required';
        this.db.prepare(`UPDATE cash_application_adjustments SET status=?, voided_at=CURRENT_TIMESTAMP,
          voided_by=?, void_reason='receipt_reversed', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(next, actor, adjustment.id);
        this.db.prepare(`INSERT INTO cash_application_events
          (event_type, receipt_id, actor, detail_json) VALUES (?, ?, ?, ?)`)
          .run(next === 'voided' ? 'adjustment_voided' : 'adjustment_reversal_requested',
            receiptId, actor, JSON.stringify({ adjustmentId: adjustment.id, reason: 'receipt_reversed' }));
      }
      for (const decisionId of decisionIds) {
        const reversalRequired = Boolean(this.db.prepare(`SELECT 1 FROM (
          SELECT status FROM cash_allocations WHERE decision_id=?
          UNION ALL SELECT status FROM cash_application_adjustments WHERE decision_id=?
        ) WHERE status='reversal_required' LIMIT 1`).get(decisionId, decisionId));
        this.db.prepare(`UPDATE decisions SET execution_status=?, execution_result_json=?,
          execution_claimed_at=NULL, execution_claimed_by=NULL WHERE id=?`).run(
          reversalRequired ? 'reversal_required' : 'voided',
          JSON.stringify({ reason: 'receipt_reversed', reversalRequired }), decisionId
        );
      }
      this.db.prepare(`INSERT INTO cash_application_events (event_type, receipt_id, actor, detail_json)
        SELECT 'receipt_reversed', ?, ?, '{}' WHERE NOT EXISTS (
          SELECT 1 FROM cash_application_events WHERE receipt_id=? AND event_type='receipt_reversed'
        )`).run(receiptId, actor, receiptId);
    });
  }

  getDecision(id) {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
    return row ? {
      ...row, allocations: JSON.parse(row.allocations_json), adjustments: parseJson(row.adjustments_json, []),
      executionResult: parseJson(row.execution_result_json)
    } : null;
  }

  hasWebhookEvent(provider, eventId) {
    return Boolean(this.db.prepare('SELECT 1 FROM webhook_events WHERE provider = ? AND event_id = ?').get(provider, eventId));
  }

  recordWebhookEvent(provider, eventId, payload) {
    this.db.prepare('INSERT OR IGNORE INTO webhook_events (provider, event_id, payload_json) VALUES (?, ?, ?)')
      .run(provider, eventId, safeJson(payload));
  }

  getSyncState(provider, accountId = 'agent') {
    const row = this.db.prepare('SELECT * FROM sync_state WHERE provider=? AND account_id=?').get(provider, accountId);
    return row ? { provider: row.provider, accountId: row.account_id, cursor: row.cursor, lastSyncedAt: row.last_synced_at } : null;
  }

  setSyncState(provider, { accountId = 'agent', cursor = null, lastSyncedAt = new Date().toISOString() } = {}) {
    this.db.prepare(`INSERT INTO sync_state (provider, account_id, cursor, last_synced_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, account_id) DO UPDATE SET cursor=excluded.cursor, last_synced_at=excluded.last_synced_at`)
      .run(provider, accountId, cursor, lastSyncedAt);
  }

  audit(eventType, entityType, entityId, actor, detail) {
    this.db.prepare('INSERT INTO audit_log (event_type, entity_type, entity_id, actor, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(eventType, entityType, entityId, actor, JSON.stringify(detail));
  }

  stats() {
    const rows = this.db.prepare(`SELECT review_status, currency, COUNT(*) count, COALESCE(SUM(amount_cents), 0) amount
      FROM transfers GROUP BY review_status, currency`).all();
    const output = {};
    for (const row of rows) {
      output[row.review_status] ??= { count: 0, amounts: {} };
      output[row.review_status].count += row.count;
      output[row.review_status].amounts[row.currency] = row.amount;
    }
    return output;
  }
}

function parseJson(value, fallback = null) {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
}

function safeJson(value) { return JSON.stringify(redactSensitive(value)); }

function mapTransfer(row) {
  return {
    id: row.id, provider: row.provider, accountId: row.account_id, providerTransactionId: row.provider_transaction_id,
    status: row.status, amountCents: row.amount_cents, currency: row.currency, bookedAt: row.booked_at,
    senderName: row.sender_name, senderAccountFingerprint: row.sender_account_fingerprint,
    reference: row.reference, description: row.description, note: row.note, reviewStatus: row.review_status
  };
}

function mapReceipt(row, allocations = [], adjustments = []) {
  const allocatedAmountCents = Number(row.allocated_amount_cents ?? 0);
  return {
    id: row.id,
    sourceSystem: row.source_system,
    sourceAccountId: row.source_account_id,
    sourceRecordId: row.source_record_id,
    status: row.status,
    grossAmountCents: row.gross_amount_cents,
    allocatedAmountCents,
    unappliedAmountCents: Math.max(0, row.gross_amount_cents - allocatedAmountCents),
    currency: row.currency,
    receivedAt: row.received_at,
    counterpartyName: row.counterparty_name,
    counterpartyAccountFingerprint: row.counterparty_account_fingerprint,
    reference: row.reference,
    allocations,
    adjustments
  };
}

function mapAllocation(row) {
  return {
    id: row.id,
    receiptId: row.receipt_id,
    invoiceId: row.invoice_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    decisionId: row.decision_id,
    lagoPaymentId: row.lago_payment_id,
    actor: row.actor,
    note: row.note,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapInvoice(row) {
  return {
    id: row.id, number: row.number, customerId: row.customer_id, customerName: row.customer_name,
    customerLegalName: row.customer_legal_name, customerExternalSalesforceId: row.customer_external_salesforce_id,
    currency: row.currency, totalAmountCents: row.total_amount_cents,
    remainingAmountCents: row.remaining_amount_cents, paymentStatus: row.payment_status, issuedAt: row.issued_at,
    raw: parseJson(row.raw_json, {})
  };
}

function mapProposal(row) {
  return {
    id: row.id, transferId: row.transfer_id, rank: row.rank, kind: row.kind, score: row.score,
    confidence: row.confidence, margin: row.margin, allocations: parseJson(row.allocations_json, []),
    adjustments: parseJson(row.adjustments_json, []),
    signals: parseJson(row.signals_json, []), explanation: row.explanation, autoEligible: Boolean(row.auto_eligible),
    policyVersion: row.policy_version, invoiceNumbers: row.invoice_numbers?.split(', ') ?? [],
    customerNames: [...new Set(row.customer_names?.split(', ') ?? [])]
  };
}

function mapAdjustment(row) {
  return {
    id: row.id, receiptId: row.receipt_id, invoiceId: row.invoice_id, type: row.type,
    amountCents: row.amount_cents, currency: row.currency, status: row.status,
    decisionId: row.decision_id, policyVersion: row.policy_version, actor: row.actor, note: row.note,
    voidedAt: row.voided_at, voidedBy: row.voided_by, voidReason: row.void_reason,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapRemittanceClaim(row) {
  return {
    id: row.id, documentId: row.document_id, invoiceNumber: row.invoice_number,
    amountCents: row.amount_cents, currency: row.currency,
    citation: { locator: row.citation_locator, excerpt: row.citation_excerpt, textHash: row.citation_text_hash },
    extractionConfidence: row.extraction_confidence, createdAt: row.created_at
  };
}

function mapRemittanceDocument(row, claims = []) {
  return {
    id: row.id, receiptId: row.receipt_id, sourceSystem: row.source_system,
    sourceRecordId: row.source_record_id, mimeType: row.mime_type, contentHash: row.content_hash,
    extractor: row.extractor, extractorVersion: row.extractor_version, status: row.status,
    metadata: parseJson(row.metadata_json, {}), addedBy: row.added_by,
    createdAt: row.created_at, updatedAt: row.updated_at, claims
  };
}

function mapCashApplicationPolicy(row) {
  return {
    customerId: row.customer_id, version: row.version, maxBankFeeCents: row.max_bank_fee_cents,
    withholdingBps: row.withholding_bps, maxShortPayCents: row.max_short_pay_cents,
    maxShortPayBps: row.max_short_pay_bps, enabled: Boolean(row.enabled),
    updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapAgentCase(row) {
  return {
    id: row.id, caseKey: row.case_key, currentRunId: row.current_run_id,
    kind: row.kind, priority: row.priority, state: row.state, disposition: row.disposition,
    confidence: row.confidence, ownerName: row.owner_name,
    assignment: {
      queue: row.queue, assigneeId: row.assignee_id, assigneeName: row.assignee_name,
      requiredPermission: row.required_permission, commercialOwnerId: row.commercial_owner_id,
      commercialOwnerName: row.commercial_owner_name
    },
    title: row.title,
    rationale: row.rationale, action: { type: row.action_type, payload: parseJson(row.action_payload_json, {}) },
    amountCents: row.amount_cents, currency: row.currency, evidence: parseJson(row.evidence_json, []),
    trace: parseJson(row.trace_json, []), sourceCoverage: parseJson(row.source_coverage_json, {}),
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, resolvedAt: row.resolved_at,
    resolution: parseJson(row.resolution_json)
  };
}

function mapAgentStep(row) {
  return {
    id: row.id, runId: row.run_id, sequence: row.sequence, toolName: row.tool_name,
    category: row.category, status: row.status, input: parseJson(row.input_json, {}),
    output: parseJson(row.output_json), error: parseJson(row.error_json),
    startedAt: row.started_at, completedAt: row.completed_at
  };
}

function mapAgentRun(row, steps = []) {
  return {
    id: row.id, trigger: row.trigger, status: row.status, policyVersion: row.policy_version,
    sourcePlan: parseJson(row.source_plan_json, []), summary: parseJson(row.summary_json, {}),
    error: parseJson(row.error_json), startedAt: row.started_at, completedAt: row.completed_at, steps
  };
}

function mapPlaybook(row) {
  return {
    id: row.id, name: row.name, enabled: Boolean(row.enabled), version: row.version,
    conditions: parseJson(row.conditions_json, {}), effects: parseJson(row.effects_json, {}),
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function validateRemittanceClaims(claims) {
  if (!Array.isArray(claims) || !claims.length) throw new Error('At least one remittance claim is required');
  const invoiceNumbers = new Set();
  for (const claim of claims) {
    const number = String(claim?.invoiceNumber ?? '').trim();
    if (!number || invoiceNumbers.has(number.toUpperCase())) throw new Error('Remittance invoice numbers must be present and unique');
    invoiceNumbers.add(number.toUpperCase());
    if (!Number.isInteger(claim.amountCents) || claim.amountCents <= 0) throw new Error('Remittance amount must use positive integer minor units');
    if (!/^[A-Z]{3}$/.test(String(claim.currency ?? ''))) throw new Error('Remittance currency must be a three-letter uppercase code');
    if (!String(claim.citation?.locator ?? '').trim() || !String(claim.citation?.excerpt ?? '').trim() ||
      !/^[a-f0-9]{64}$/i.test(String(claim.citation?.textHash ?? ''))) {
      throw new Error('Every remittance claim requires a source locator, excerpt, and SHA-256 text hash');
    }
    if (claim.extractionConfidence != null && (!Number.isInteger(claim.extractionConfidence) ||
      claim.extractionConfidence < 0 || claim.extractionConfidence > 100)) {
      throw new Error('Extraction confidence must be an integer from 0 to 100');
    }
  }
}

function validateCashApplicationPolicy(policy) {
  if (!String(policy?.customerId ?? '').trim()) throw new Error('Customer ID is required');
  for (const field of ['maxBankFeeCents', 'withholdingBps', 'maxShortPayCents', 'maxShortPayBps']) {
    const value = Number(policy[field] ?? 0);
    const isBasisPoints = field.endsWith('Bps');
    if (!Number.isInteger(value) || value < 0 || (isBasisPoints && value > 10_000)) {
      throw new Error(`${field} must be a non-negative integer${isBasisPoints ? ' no greater than 10000' : ''}`);
    }
  }
}

function assertStoredAdjustmentAllowed(adjustment, availableInvoiceAmount, policy) {
  if (!policy) throw new Error('Settlement adjustment requires the current enabled customer policy');
  const gap = adjustment.amountCents;
  if (adjustment.type === 'bank_fee_writeoff' && gap <= policy.max_bank_fee_cents) return;
  const expectedWithholding = Math.round(availableInvoiceAmount * policy.withholding_bps / 10_000);
  if (adjustment.type === 'withholding_tax' && expectedWithholding > 0 && Math.abs(expectedWithholding - gap) <= 1) return;
  const maxShortPay = Math.max(policy.max_short_pay_cents,
    Math.round(availableInvoiceAmount * policy.max_short_pay_bps / 10_000));
  if (adjustment.type === 'short_pay' && gap <= maxShortPay) return;
  throw new Error('Settlement adjustment exceeds the configured customer policy');
}

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');

function median(values) {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function gate(id, passed, value, requirement) { return { id, passed, value, requirement }; }
