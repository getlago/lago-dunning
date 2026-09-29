const effect = (system, action, description, options = {}) => ({
  system, action, description, reversible: options.reversible ?? false,
  requiresApproval: true, parameters: options.parameters ?? {}
});

export function buildRepairPreview(incident) {
  if (!incident) throw new Error('Incident not found');
  const common = {
    incidentId: incident.id,
    incidentKind: incident.kind,
    mode: 'preview_only',
    executable: false,
    requiresAuthenticatedFinanceApproval: true,
    prohibitedActions: ['create_fake_invoice', 'delete_evidence', 'directly_toggle_invoice_payment_status'],
    verification: ['Re-sync Lago and the receipt authority', 'Keep the case open until source systems agree']
  };

  if (incident.kind === 'stripe_unallocated_cash_balance' || incident.kind === 'lago_invoice_missing_stripe_intent') {
    return { ...common, strategy: 'apply_existing_cash_without_reinvoicing', effects: [
      effect('lago', 'verify_open_invoice', 'Confirm the intended invoice and current remaining balance.'),
      effect('stripe', 'create_or_recover_payment_intent', 'Expose the reviewed Lago invoice to Stripe without creating a duplicate invoice.', { reversible: true }),
      effect('stripe', 'apply_customer_cash_balance', 'Apply only the reviewed amount from existing customer cash.', { reversible: true }),
      effect('lago', 'verify_provider_settlement', 'Let the standard provider settlement path derive invoice state.')
    ] };
  }

  if (['stripe_allocation_reference_mismatch', 'stripe_old_cash_auto_applied'].includes(incident.kind)) {
    return { ...common, strategy: 'unapply_then_reallocate', effects: [
      effect('lago', 'hold_dunning', 'Pause collection while the allocation is disputed.', { reversible: true }),
      effect('stripe', 'unapply_payment_to_cash_balance', 'Return the misapplied amount to customer cash rather than refunding the bank.', { reversible: true }),
      effect('stripe', 'apply_cash_to_reviewed_intent', 'Apply cash only after Finance confirms the intended invoice.', { reversible: true }),
      effect('lago', 'verify_settlement_projection', 'Re-sync payments and confirm the intended invoice is settled.')
    ] };
  }

  if (incident.kind === 'lago_manual_payment_without_stripe_settlement') {
    return { ...common, strategy: 'reconcile_manual_settlement_before_moving_cash', effects: [
      effect('lago', 'inspect_manual_payment', 'Preserve the manual payment and identify its underlying receipt.'),
      effect('stripe', 'inspect_customer_cash_ledger', 'Prove whether cash remains unapplied or funded another intent.'),
      effect('lago', 'record_receipt_lineage', 'Link the proven receipt to the manual Lago payment without creating another payment.')
    ] };
  }

  if (incident.kind === 'late_stripe_failure_after_settlement' || incident.kind === 'stripe_settled_lago_unpaid') {
    return { ...common, strategy: 'restore_monotonic_settlement', effects: [
      effect('lago', 'hold_dunning', 'Prevent customer outreach while settled evidence contradicts overdue state.', { reversible: true }),
      effect('lago', 'recompute_from_successful_payment', 'Restore settlement from the successful provider payment; do not replay a charge.'),
      effect('lago', 'verify_event_precedence', 'Confirm an older attempt cancellation cannot regress the successful settlement.')
    ] };
  }

  if (incident.kind.includes('missing_in_lago')) {
    return { ...common, strategy: 'review_external_payment_import', effects: [
      effect(incident.scope.replace('erp:', ''), 'verify_external_payment', 'Confirm the external record is not a Lago-originated echo.'),
      effect('lago', 'record_manual_payment_with_origin', 'Create one reviewed Lago payment with source identity and sync suppression.')
    ] };
  }

  return { ...common, strategy: 'manual_investigation', effects: [
    effect('lago', 'review_divergence', 'Resolve source ownership and design a compensating action before any mutation.')
  ] };
}
