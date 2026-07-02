const encoder = new globalThis.TextEncoder();

const ALLOWED_VARIABLE_PATHS = new Set([
  'event.id',
  'event.type',
  'event.environment',
  'event.occurredAt',
  'actor.type',
  'actor.userId',
  'actor.email',
  'actor.name',
  'site.id',
  'site.slug',
  'site.hostname',
  'site.ownerType',
  'site.ownerId',
  'site.visibility',
  'site.status',
  'team.id',
  'team.name',
  'team.teamType',
  'deployment.id',
  'deployment.status',
  'deployment.source',
  'deployment.operation',
  'deployment.createdAt',
  'deployment.completedAt',
]);

const VARIABLE_PATTERN = /{{\s*([A-Za-z0-9_.]+)\s*}}/g;
const EXACT_VARIABLE_PATTERN = /^{{\s*([A-Za-z0-9_.]+)\s*}}$/;

export function buildStandardWebhookPayload(event = {}) {
  const payload = {
    event: pickDefined({
      id: event.id,
      type: event.type,
      environment: event.environment,
      occurredAt: event.occurredAt,
    }),
  };

  const actor = pickDefined({
    type: event.actor?.type,
    userId: event.actor?.userId,
    email: event.actor?.email,
    name: event.actor?.name,
  });
  if (Object.keys(actor).length > 0) payload.actor = actor;

  const site = pickDefined({
    id: event.site?.id,
    slug: event.site?.slug,
    hostname: event.site?.hostname,
    ownerType: event.site?.ownerType,
    ownerId: event.site?.ownerId,
    visibility: event.site?.visibility,
    status: event.site?.status,
  });
  if (Object.keys(site).length > 0) payload.site = site;

  const team = pickDefined({
    id: event.team?.id,
    name: event.team?.name,
    teamType: event.team?.teamType,
  });
  if (Object.keys(team).length > 0) payload.team = team;

  const deployment = pickDefined({
    id: event.deployment?.id,
    status: event.deployment?.status,
    source: event.deployment?.source,
    operation: event.deployment?.operation,
    createdAt: event.deployment?.createdAt,
    completedAt: event.deployment?.completedAt,
  });
  if (Object.keys(deployment).length > 0) payload.deployment = deployment;

  return payload;
}

export function validateRestrictedTemplate(template) {
  walkTemplate(template, (value) => {
    if (typeof value !== 'string') return;
    for (const variablePath of readVariablePaths(value)) {
      assertAllowedVariable(variablePath);
    }
  });
}

export function renderRestrictedTemplate(template, payload) {
  validateRestrictedTemplate(template);
  return renderTemplateValue(template, payload);
}

export async function payloadHash(payload) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJson(payload)));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function renderTemplateValue(value, payload) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, payload));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, renderTemplateValue(entryValue, payload)]));
  }
  if (typeof value !== 'string') throw new Error('WEBHOOK_TEMPLATE_VALUE_UNSUPPORTED');

  const exactMatch = value.match(EXACT_VARIABLE_PATTERN);
  if (exactMatch) {
    const resolved = resolveVariable(payload, exactMatch[1]);
    if (resolved == null) throw new Error('WEBHOOK_TEMPLATE_MISSING_VALUE');
    return resolved;
  }

  return value.replace(VARIABLE_PATTERN, (_match, variablePath) => {
    const resolved = resolveVariable(payload, variablePath);
    return resolved == null ? '' : String(resolved);
  });
}

function resolveVariable(payload, variablePath) {
  assertAllowedVariable(variablePath);
  const parts = variablePath.split('.');
  let current = payload;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) return null;
    current = current[part];
  }
  return current == null ? null : current;
}

function readVariablePaths(value) {
  return [...String(value).matchAll(VARIABLE_PATTERN)].map((match) => match[1]);
}

function assertAllowedVariable(variablePath) {
  if (!ALLOWED_VARIABLE_PATHS.has(variablePath)) {
    throw new Error(`WEBHOOK_TEMPLATE_VARIABLE_FORBIDDEN:${variablePath}`);
  }
}

function walkTemplate(value, visit) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('WEBHOOK_TEMPLATE_VALUE_UNSUPPORTED');
  }
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkTemplate(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entryValue of Object.values(value)) walkTemplate(entryValue, visit);
  }
}

function pickDefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value !== 'object') throw new Error('WEBHOOK_PAYLOAD_UNSUPPORTED');

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}
