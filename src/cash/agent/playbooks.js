export function applyPlaybooks(cases, playbooks) {
  let applications = 0;
  const output = cases.map((item) => {
    let current = structuredClone(item);
    for (const playbook of playbooks.filter((candidate) => candidate.enabled && matches(current, candidate.conditions))) {
      applications += 1;
      current = applyEffects(current, playbook);
    }
    return current;
  });
  return { cases: output, applications };
}

function matches(item, conditions = {}) {
  const providers = item.evidence.filter((entry) => entry.authority === 'receipt_authority').map((entry) => entry.source);
  const customerIds = item.evidence.filter((entry) => entry.source === 'lago' && entry.entityType === 'invoice').map((entry) => entry.fields.customerId);
  if (conditions.kinds?.length && !conditions.kinds.includes(item.kind)) return false;
  if (conditions.dispositions?.length && !conditions.dispositions.includes(item.disposition)) return false;
  if (conditions.providers?.length && !conditions.providers.some((provider) => providers.includes(provider))) return false;
  if (conditions.currencies?.length && !conditions.currencies.includes(item.currency)) return false;
  if (conditions.customerIds?.length && !conditions.customerIds.some((id) => customerIds.includes(id))) return false;
  if (conditions.queues?.length && !conditions.queues.includes(item.assignment?.queue)) return false;
  if (conditions.commercialOwnerNames?.length && !conditions.commercialOwnerNames.includes(item.assignment?.commercialOwnerName)) return false;
  if (conditions.minAmountCents != null && Number(item.amountCents ?? 0) < Number(conditions.minAmountCents)) return false;
  if (conditions.maxAmountCents != null && Number(item.amountCents ?? 0) > Number(conditions.maxAmountCents)) return false;
  return true;
}

function applyEffects(item, playbook) {
  const effects = playbook.effects ?? {};
  const requiredAuthorities = effects.requireAuthorities ?? [];
  const present = new Set(item.evidence.map((entry) => entry.authority));
  const missing = requiredAuthorities.filter((authority) => !present.has(authority));
  const result = {
    ...item,
    priority: effects.priority ?? item.priority,
    assignment: {
      ...item.assignment,
      queue: effects.queue ?? item.assignment?.queue,
      assigneeId: effects.assigneeId ?? item.assignment?.assigneeId,
      assigneeName: effects.assigneeName ?? item.assignment?.assigneeName
    },
    trace: [...item.trace, {
      step: `playbook:${playbook.id}:v${playbook.version}`,
      status: missing.length ? 'blocked' : 'succeeded',
      conclusion: missing.length
        ? `${playbook.name} requires missing evidence: ${missing.join(', ')}.`
        : `${playbook.name} applied: ${(effects.reviewSteps ?? []).join('; ') || 'routing and control policy enforced'}.`
    }]
  };
  if (effects.reviewSteps?.length) result.rationale += ` Playbook review: ${effects.reviewSteps.join('; ')}.`;
  if (effects.blockReadyForApproval && result.disposition === 'ready_for_approval') {
    result.disposition = 'needs_review';
    result.rationale += ` Playbook “${playbook.name}” requires human review.`;
  }
  if (missing.length) {
    result.disposition = 'blocked';
    result.action = { type: 'collect_missing_evidence', payload: { missingAuthorities: missing, playbookId: playbook.id } };
    result.rationale += ` Missing mandatory evidence: ${missing.join(', ')}.`;
  }
  return result;
}
