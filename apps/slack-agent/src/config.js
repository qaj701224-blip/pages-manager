function firstSet(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') || '';
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalBoolean(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

export function readSlackAgentConfig(env = process.env) {
  return {
    sharedSecret: env.SLACK_AGENT_SHARED_SECRET || '',
    modelProvider: firstSet(env.AGENT_MODEL_PROVIDER, env.SLACK_AGENT_MODEL_PROVIDER) || 'company-agent',
    modelName: firstSet(env.AGENT_MODEL_NAME, env.SLACK_AGENT_MODEL_NAME),
    gatewayUrl: firstSet(env.AGENT_GATEWAY_URL, env.SLACK_AGENT_GATEWAY_URL),
    apiKey: env.SLACK_AGENT_API_KEY || '',
    temperature: optionalNumber(firstSet(env.AGENT_MODEL_TEMPERATURE, env.SLACK_AGENT_MODEL_TEMPERATURE)),
    maxContextMessages: Number(env.SLACK_AGENT_MAX_CONTEXT_MESSAGES || 50),
    maxOutputTokens: Number(env.SLACK_AGENT_MAX_OUTPUT_TOKENS || 2048),
    requestTimeoutMs: Number(env.SLACK_AGENT_REQUEST_TIMEOUT_SECONDS || 120) * 1000,
    mergeSummaryModel: env.SLACK_AGENT_MERGE_SUMMARY_MODEL || '',
    mergeSummaryTimeoutMs: Number(env.SLACK_AGENT_MERGE_SUMMARY_TIMEOUT_SECONDS || 30) * 1000,
    repoAnswerModel: env.SLACK_AGENT_REPO_ANSWER_MODEL || '',
    repoAnswerTimeoutMs: Number(env.SLACK_AGENT_REPO_ANSWER_TIMEOUT_SECONDS || 45) * 1000,
    streamingEnabled: optionalBoolean(firstSet(env.AGENT_MODEL_STREAMING, env.SLACK_AGENT_MODEL_STREAMING), true),
    semanticChunkMinChars: Number(env.SLACK_AGENT_SEMANTIC_CHUNK_MIN_CHARS || 16),
    semanticChunkMaxChars: Number(env.SLACK_AGENT_SEMANTIC_CHUNK_MAX_CHARS || 72),
  };
}
