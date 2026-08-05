const V1_STALE_THRESHOLD_MS = 180 * 24 * 60 * 60 * 1000;

export function isV1SiteStale(updatedAt, now = Date.now()) {
  const updatedAtMs = Date.parse(updatedAt || '');
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - updatedAtMs >= V1_STALE_THRESHOLD_MS;
}

export function filterV1Sites(sites, { query = '', filter = 'all', now = Date.now() } = {}) {
  const normalizedQuery = String(query).trim().toLowerCase();
  return sites.filter((site) => {
    const searchable = [site.name, site.url, site.preset, site.workerName].filter(Boolean).join(' ').toLowerCase();
    if (normalizedQuery && !searchable.includes(normalizedQuery)) return false;
    if (filter === 'stale') return isV1SiteStale(site.updatedAt, now);
    if (filter === 'migrated') return site.migratedCandidate === true;
    return true;
  });
}

export function filterWorkerOrphanScanWorkers(workers, filter = 'all') {
  if (filter === 'active_route') return workers.filter((worker) => worker.referencedByActiveRoute);
  if (filter === 'rollback') return workers.filter((worker) => worker.rollbackEligibleVersion);
  if (filter === 'cleanup') return workers.filter((worker) => worker.hasPendingCleanupTask);
  if (filter === 'orphan') return workers.filter((worker) => worker.orphanCandidate);
  if (['no_d1_reference', 'deleted_site', 'stale_previous_version'].includes(filter)) {
    return workers.filter((worker) => worker.orphanReason === filter);
  }
  return workers;
}

export function formatCleanupBacklogAge(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '—';
  const totalSeconds = Math.floor(Number(seconds));
  if (totalSeconds === 0) return '0 分钟';
  if (totalSeconds < 60) return '< 1 分钟';
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  return `${minutes} 分钟`;
}
