import { jsonResponse } from '@xd/worker-kit';

export async function handleHealth() {
  return jsonResponse({ status: 'ok' });
}
