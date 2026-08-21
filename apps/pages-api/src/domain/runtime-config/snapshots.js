export function runtimeConfigSnapshotsEqual(expectedVars, expectedSecrets, actualVars, actualSecrets) {
  return runtimeVarSnapshotsEqual(expectedVars, actualVars) && runtimeSecretSnapshotsEqual(expectedSecrets, actualSecrets);
}

export function runtimeVarSnapshotsEqual(left = [], right = []) {
  const normalizedLeft = runtimeVarSnapshot(left);
  const normalizedRight = runtimeVarSnapshot(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((entry, index) => {
    const other = normalizedRight[index];
    return entry.name === other.name && entry.value === other.value && entry.revision === other.revision;
  });
}

function runtimeVarSnapshot(vars = []) {
  const records = Array.isArray(vars) ? vars : Object.keys(vars || {}).map((name) => ({ name, value: vars[name], revision: 0 }));
  return records
    .map((record) => ({
      name: record.name,
      value: record.value,
      revision: Number(record.revision || 0),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function runtimeSecretSnapshotsEqual(left = [], right = []) {
  const normalizedLeft = runtimeSecretSnapshot(left);
  const normalizedRight = runtimeSecretSnapshot(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((entry, index) => {
    const other = normalizedRight[index];
    return entry.name === other.name && entry.revision === other.revision;
  });
}

function runtimeSecretSnapshot(secrets = []) {
  return secrets
    .map((secret) => ({
      name: secret.name,
      revision: Number(secret.revision || 0),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
