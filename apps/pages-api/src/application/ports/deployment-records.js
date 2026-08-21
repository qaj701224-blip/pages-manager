export function createDeploymentRecordsPort(store) {
  return {
    createForIdempotency: bindRequired(store, 'createDeploymentForIdempotency'),
  };
}

function bindRequired(target, name) {
  if (typeof target?.[name] !== 'function') throw new TypeError(`deployment records port method is required: ${name}`);
  return target[name].bind(target);
}
