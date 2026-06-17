import { startPagesAgent } from './jobs/coding-agent.js';
import { startIssueAndIndex } from './jobs/issue-and-index.js';
import { startPagesPreview } from './jobs/preview.js';

export { startPagesAgent } from './jobs/coding-agent.js';
export { startIssueAndIndex } from './jobs/issue-and-index.js';
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
