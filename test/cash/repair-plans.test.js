import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRepairPreview } from '../../src/cash/repair-plans.js';

const incident = (kind) => ({ id: `${kind}:customer:1`, kind, severity: 'critical', scope: 'cus_stripe', evidence: {} });

test('reused-wire repair preview applies existing cash without creating a fake invoice', () => {
  const plan = buildRepairPreview(incident('stripe_unallocated_cash_balance'));
  assert.equal(plan.executable, false);
  assert.equal(plan.strategy, 'apply_existing_cash_without_reinvoicing');
  assert(plan.prohibitedActions.includes('create_fake_invoice'));
  assert(plan.effects.some((item) => item.action === 'apply_customer_cash_balance'));
});

test('wrong-cash repair preview un-applies wrong cash before reviewed reallocation', () => {
  const plan = buildRepairPreview(incident('stripe_allocation_reference_mismatch'));
  assert.equal(plan.strategy, 'unapply_then_reallocate');
  assert.deepEqual(plan.effects.map((item) => item.system), ['lago', 'stripe', 'stripe', 'lago']);
  assert(plan.effects.every((item) => item.requiresApproval));
});

test('regression repair preview restores settlement without replaying a charge', () => {
  const plan = buildRepairPreview(incident('late_stripe_failure_after_settlement'));
  assert.equal(plan.strategy, 'restore_monotonic_settlement');
  assert(!plan.effects.some((item) => item.action.includes('charge')));
  assert(plan.effects.some((item) => item.action === 'hold_dunning'));
});
