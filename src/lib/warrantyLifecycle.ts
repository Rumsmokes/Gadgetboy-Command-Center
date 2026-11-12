export type WarrantyCoverage = { id: string; repairLabel: string; warrantyDays: number; startedAt: string; expiresAt: string; claimCount: number };

export function warrantyState(coverage: WarrantyCoverage, now = new Date()): 'active' | 'expired' {
  return new Date(coverage.expiresAt).getTime() >= now.getTime() ? 'active' : 'expired';
}

export function renewWarranty(coverage: WarrantyCoverage, completedAt: string): WarrantyCoverage {
  const start = new Date(completedAt);
  const expiry = new Date(start);
  expiry.setUTCDate(expiry.getUTCDate() + coverage.warrantyDays);
  return { ...coverage, startedAt: start.toISOString(), expiresAt: expiry.toISOString(), claimCount: coverage.claimCount + 1 };
}
