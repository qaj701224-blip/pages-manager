function firstSet(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') || '';
}

export function readSlackAgentConfig(env = process.env) {
  return {
    sharedSecret: env.SLACK_AGENT_SHARED_SECRET || '',
    modelProvider: firstSet(env.AGENT_MODEL_PROVIDER, env.SLACK_AGENT_MODEL_PROVIDER) || 'company-agent',
    modelName: firstSet(env.AGENT_MODEL_NAME, env.SLACK_AGENT_MODEL_NAME),
    gatewayUrl: firstSet(env.AGENT_GATEWAY_URL, env.SLACK_AGENT_GATEWAY_URL),
    apiKey: env.SLACK_AGENT_API_KEY || '',
    maxContextMessages: Number(env.SLACK_AGENT_MAX_CONTEXT_MESSAGES || 50),
    maxOutputTokens: Number(env.SLACK_AGENT_MAX_OUTPUT_TOKENS || 2048),
    requestTimeoutMs: Number(env.SLACK_AGENT_REQUEST_TIMEOUT_SECONDS || 120) * 1000,
  };
}
