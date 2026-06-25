import {
  handleCreatePublishingJob,
  handleGetPublishingJob,
  handleGetPublishingJobEvents,
  handleListPublishingJobs,
} from '../publishing/api-handlers.js';

export function registerPublishingRoutes(router) {
  router.post('/api/publishing-jobs', handleCreatePublishingJob);
  router.get('/api/publishing-jobs', handleListPublishingJobs);
  router.get('/api/publishing-jobs/:jobId', handleGetPublishingJob);
  router.get('/api/publishing-jobs/:jobId/events', handleGetPublishingJobEvents);
}
