import {
  handleCreatePublishingJob,
  handleGetPublishingJob,
  handleGetPublishingJobEvents,
  handleListPublishingJobs,
} from '../control-plane/handlers.js';

export function registerPublishingRoutes(router) {
  router.post('/api/publishing-jobs', handleCreatePublishingJob);
  router.get('/api/publishing-jobs', handleListPublishingJobs);
  router.get('/api/publishing-jobs/:jobId', handleGetPublishingJob);
  router.get('/api/publishing-jobs/:jobId/events', handleGetPublishingJobEvents);
}
