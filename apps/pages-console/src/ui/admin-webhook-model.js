const VARIABLE_PATTERN = /{{\s*([A-Za-z0-9_.]+)\s*}}/g;

export function readTemplateVariablePaths(templateText) {
  let template;
  try {
    template = JSON.parse(templateText || '{}');
  } catch {
    return [];
  }

  const paths = [];
  const seen = new Set();
  walkTemplate(template, (value) => {
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(VARIABLE_PATTERN)) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        paths.push(match[1]);
      }
    }
  });
  return paths;
}

export function getTemplateVariableWarnings(templateText, selectedEventTypes, supportedEvents) {
  const paths = readTemplateVariablePaths(templateText);
  if (!paths.length) return [];

  const descriptorMap = new Map((supportedEvents || []).map((event) => [event.type, event]));
  return paths
    .map((path) => ({
      path,
      events: (selectedEventTypes || [])
        .map((type) => descriptorMap.get(type) || { type, label: type })
        .filter((event) => !(event.requiredTemplateVariables || []).includes(path))
        .map((event) => ({ type: event.type, label: event.label || event.type })),
    }))
    .filter(({ events }) => events.length > 0);
}

function walkTemplate(value, visit) {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkTemplate(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entryValue of Object.values(value)) walkTemplate(entryValue, visit);
  }
}
