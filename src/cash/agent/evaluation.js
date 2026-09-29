export function evaluateAgent(cases, expectations, summary) {
  const byKey = new Map(cases.map((item) => [item.caseKey, item]));
  const results = expectations.map((expected) => {
    const actual = byKey.get(expected.caseKey);
    const checks = {
      found: Boolean(actual),
      kind: actual?.kind === expected.kind,
      disposition: actual?.disposition === expected.disposition,
      queue: actual?.assignment?.queue === (expected.queue ?? 'cash_application'),
      permission: actual?.assignment?.requiredPermission === (expected.permission ??
        (['safe_match', 'suggested_match', 'split_allocation', 'remittance_allocation', 'settlement_adjustment'].includes(expected.kind)
          ? 'payments:create' : 'payments:view')),
      grounded: Boolean(actual?.evidence?.length) && actual.evidence.every((item) => item.citation && item.authority),
      traced: (actual?.trace?.length ?? 0) >= 2
    };
    return { ...expected, actual: actual ? { kind: actual.kind, disposition: actual.disposition, assignment: actual.assignment } : null, checks, passed: Object.values(checks).every(Boolean) };
  });
  const passed = results.filter((item) => item.passed).length;
  return {
    scenarios: results.length, passed,
    scenarioAccuracy: results.length ? passed / results.length : 1,
    groundedEvidenceRate: results.length ? results.filter((item) => item.checks.grounded).length / results.length : 1,
    traceCoverage: results.length ? results.filter((item) => item.checks.traced).length / results.length : 1,
    unsafeFinancialWrites: summary.financialWrites ?? 0,
    results
  };
}
