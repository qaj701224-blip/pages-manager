import { createPagesRuntime } from './worker/index.js';
import { createHandlePagesRuntimeRequest } from './internal/adapter/core.js';

export { PagesSDKError } from './errors.js';
export type { PagesRuntimeEnv } from './types.js';

export const handlePagesRuntimeRequest = createHandlePagesRuntimeRequest(createPagesRuntime);
