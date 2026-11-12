export type WarrantyPolicySource = 'repair' | 'family' | 'none';
export type WarrantyPolicy = { enabled: boolean; days: number | null; source: WarrantyPolicySource };

type WarrantyRepair = { warrantyDays?: unknown; warrantyExcluded?: boolean };
type WarrantyFamily = { days?: unknown } | null | undefined;

const validDays = (value: unknown): number | null => {
  const days = Number(value);
  return Number.isInteger(days) && days > 0 ? days : null;
};

export function resolveWarrantyPolicy(repair: WarrantyRepair, family: WarrantyFamily): WarrantyPolicy {
  if (repair.warrantyExcluded) return { enabled: false, days: null, source: 'none' };
  if (repair.warrantyDays !== undefined && Number(repair.warrantyDays) <= 0) return { enabled: false, days: null, source: 'none' };
  const repairDays = validDays(repair.warrantyDays);
  if (repairDays) return { enabled: true, days: repairDays, source: 'repair' };
  const familyDays = validDays(family?.days);
  if (familyDays) return { enabled: true, days: familyDays, source: 'family' };
  return { enabled: false, days: null, source: 'none' };
}
