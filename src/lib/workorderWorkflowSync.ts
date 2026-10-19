export function preserveNewerWorkflow(local: any, cloud: any): any {
  const cloudTime = Date.parse(cloud?.workflowUpdatedAt || '') || 0;
  const localTime = Date.parse(local?.workflowUpdatedAt || '') || 0;
  if (!cloudTime || cloudTime <= localTime) return local;
  const merged = { ...local };
  // QR workflow owns these fields; desktop notes, cart, and payments stay local.
  for (const key of ['workflowStage', 'workflowUpdatedAt', 'repairStatus', 'statusUpdate', 'statusUpdatedAt', 'diagnosisStartedAt', 'testingStartedAt', 'lastTechnicianActivityAt', 'pickupReadyAt', 'scheduledPickupAt', 'pickupReminderSentAt', 'storageFeeStartedAt', 'storageFeeLastAccruedAt', 'pickedUpAt', 'pickedUpBy', 'clientPickupDate', 'promisedAt', 'promiseNote', 'partEta', 'clientDecision', 'clientDecisionAt']) {
    if (cloud[key] !== undefined) merged[key] = cloud[key];
  }
  if (!/^(closed|cancelled|canceled|void|refunded|deleted|archived)$/i.test(String(local?.status || '')) && !local?.checkoutDate && !local?.pickedUpAt && !local?.clientPickupDate) merged.status = cloud.status ?? local.status;
  return merged;
}
