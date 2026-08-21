import { ADMIN_EXPOSURE_EVENT_TYPE, ADMIN_EXPOSURE_TERMINAL_FAILURE_STAGES } from './constants.js';

export function resolveLatestAdminSitePublicExposureReason(events, { currentExposure } = {}) {
  if (currentExposure !== 'public') return null;
  const operations = new Map();
  for (const event of events || []) {
    const metadata = event?.metadata;
    if (
      event?.eventType !== ADMIN_EXPOSURE_EVENT_TYPE ||
      metadata?.requestedExposure !== 'public' ||
      !metadata?.operationId ||
      !String(metadata.reason || '').trim()
    ) {
      continue;
    }
    const operationId = String(metadata.operationId);
    const operation = operations.get(operationId) || [];
    operation.push(event);
    operations.set(operationId, operation);
  }

  const orderedOperations = [...operations.values()].sort((left, right) =>
    compareExposureAuditEvents(latestExposureAuditEvent(right), latestExposureAuditEvent(left))
  );
  for (const operationEvents of orderedOperations) {
    const terminalFailure = operationEvents.some((event) => ADMIN_EXPOSURE_TERMINAL_FAILURE_STAGES.has(event.metadata?.stage));
    if (terminalFailure) continue;
    const effectiveSuccess = operationEvents
      .filter((event) => event.metadata?.stage === 'effective_success' && event.metadata?.effectiveExposure === 'public')
      .sort((left, right) => compareExposureAuditEvents(right, left))[0];
    if (effectiveSuccess) return exposureReasonFromAuditEvent(effectiveSuccess);
  }
  return null;
}

export function latestExposureAuditEvent(events) {
  return [...events].sort((left, right) => compareExposureAuditEvents(right, left))[0];
}

export function compareExposureAuditEvents(left, right) {
  const leftTime = Date.parse(left?.createdAt || '');
  const rightTime = Date.parse(right?.createdAt || '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

export function exposureReasonFromAuditEvent(event) {
  return {
    text: String(event.metadata.reason).trim(),
    changedAt: event.createdAt,
  };
}
