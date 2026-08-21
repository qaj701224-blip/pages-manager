export function createRollbackOfficeNetVerification({ versions, officeNet }) {
  if (typeof versions?.getById !== 'function') throw new TypeError('versions.getById is required');
  if (typeof officeNet?.ensure !== 'function') throw new TypeError('officeNet.ensure is required');

  return { verify };

  async function verify(command) {
    await officeNet.ensure(officeNetCommand(command, command.version));

    if (
      command.exposure !== 'public' ||
      !command.currentVersionId ||
      command.currentVersionId === command.version.id
    ) {
      return { ok: true };
    }

    const currentVersion = await versions.getById(command.currentVersionId, command.environment);
    if (!currentVersion) {
      return {
        ok: false,
        error: {
          code: 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED',
          reason: 'current_version_missing',
        },
      };
    }

    await officeNet.ensure(officeNetCommand(command, currentVersion));
    return { ok: true };
  }
}

function officeNetCommand(command, version) {
  return {
    environment: command.environment,
    siteId: command.siteId,
    workerName: version.workerName,
    executionProvider: version.executionProvider,
    deploymentShape: version.deploymentShape,
    exposure: command.exposure,
    signal: command.signal,
  };
}
