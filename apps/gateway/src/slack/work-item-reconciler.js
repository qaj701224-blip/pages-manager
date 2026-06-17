import { reconcileClosedGithubIssueForJob } from '../github/resource-reconciler.js';
import { normalizeSlackWorkItemQueryState, slackWorkItemIncludesInactive } from './work-item-query.js';
import { isActionableSlackWorkItem, listSlackWorkItemsForSession } from './work-items.js';

export async function listReconciledSlackWorkItemsForSession(store, body, env, options = {}) {
  const displayLimit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
  const reconcileLimit = options.reconcileLimit || Math.max(displayLimit, 20);
  const workItemState = normalizeSlackWorkItemQueryState(options.workItemState || (options.includeInactive ? 'all' : 'active'));
  const result = await listSlackWorkItemsForSession(store, body, {
    ...options,
    limit: reconcileLimit,
    workItemState,
  });
  const reconciledJobs = [];

  for (const job of result.jobs || []) {
    const reconciled = await reconcileClosedGithubIssueForJob(store, env, job);
    const actionable = isActionableSlackWorkItem(reconciled);
    if (workItemState === 'closed' ? !actionable : slackWorkItemIncludesInactive(workItemState) || actionable) {
      reconciledJobs.push(reconciled);
    }
  }

  const jobs = reconciledJobs.slice(0, displayLimit);
  return {
    ...result,
    jobs,
    total: jobs.length,
    limit: displayLimit,
    workItemState,
  };
}
