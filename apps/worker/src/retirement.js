import { jsonResponse } from '@xd/worker-kit';

export const SITE_PUBLISHING_RETIRED_CODE = 'PUBLISHING_LANE_RETIRED';
export const SITE_PUBLISHING_RETIRED_MESSAGE = '站点自动发布能力已停止服务，新的发布任务不会再创建或继续执行。';

export function sitePublishingRetiredResponse() {
  return jsonResponse(
    {
      error: SITE_PUBLISHING_RETIRED_CODE,
      message: SITE_PUBLISHING_RETIRED_MESSAGE,
    },
    410
  );
}
