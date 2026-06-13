export async function postExecutorCallback(fetchImpl, config, body) {
  const callbackUrl = config.workerCallbackUrl || config.callbackUrl;
  const headers = {
    'Content-Type': 'application/json',
  };

  if (config.callbackToken) {
    headers['X-Pages-Callback-Token'] = config.callbackToken;
  }

  const response = await fetchImpl(callbackUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null);

  if (!response.ok) {
    const message = responseBody?.error || response.statusText || `HTTP ${response.status}`;
    throw new Error(`Gateway callback failed: ${message}`);
  }

  return responseBody;
}
