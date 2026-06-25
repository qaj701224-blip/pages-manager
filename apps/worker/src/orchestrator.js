import { startPagesAgent } from './jobs/coding-agent.js';
import { startIssueAndIndex } from './jobs/issue-and-index.js';
import { startPlatformDevItem } from './jobs/platform-dev.js';
import { startPagesPreview } from './jobs/preview.js';

export { startPagesAgent } from './jobs/coding-agent.js';
export { startIssueAndIndex } from './jobs/issue-and-index.js';
export { startPlatformDevItem } from './jobs/platform-dev.js';
export { startPagesPreview } from './jobs/preview.js';

export async function runWorkerForJob(job, config, adapters = {}) {
  if (!job?.id) {
    throw new Error('job is required');
  }

  if (job.status === 'received') {
    return startIssueAndIndex(job, config, adapters);
  }

  if (job.status === 'generating_page') {
    return startPagesAgent(job, config, adapters);
  }

  if (job.status === 'fixing') {
    return startPagesAgent(job, config, adapters);
  }

  if (job.status === 'previewing') {
    return startPagesPreview(job, config, adapters);
  }

  return {
    action: 'noop',
    reason: `No worker action for job status ${job.status}`,
  };
}

export async function runWorkerForWorkItem(input, config, adapters = {}) {
  const workItemKind = input?.workItemKind || input?.work_item_kind;
  if (workItemKind === 'platform_dev') {
    const item = input.platformDevItem || input.platform_dev_item || input.item;
    if (!item?.id) throw new Error('platformDevItem is required');
    return startPlatformDevItem(item, config, adapters);
  }

  if (input?.job) return runWorkerForJob(input.job, config, adapters);
  throw new Error('Unsupported work item');
}
