export function createRollbackOfficeNetVerification({ versions, officeNet, telemetry }) {
  if (typeof versions?.getById !== 'function') throw new TypeError('versions.getById is required');
  if (typeof officeNet?.ensure !== 'function') throw new TypeError('officeNet.ensure is required');
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');

  return { verify };

  function verify(command) {
    const stage = telemetry.start();
    return verifyAfterStart(command, stage);
  }

  async function verifyAfterStart(command, stage) {
    let result;
    try {
      result = await verifyVersions(command);
    } catch (cause) {
      await telemetry.finish(stage, { status: 'failed', cause });
      throw cause;
    }
    if (!result.ok) {
      await telemetry.finish(stage, { status: 'failed', error: result.error });
      return result;
    }
    try {
      await telemetry.finish(stage, { status: command.exposure === 'public' ? 'succeeded' : 'skipped' });
    } catch (cause) {
      await telemetry.finish(stage, { status: 'failed', cause });
      throw cause;
    }
    return result;
  }

  async function verifyVersions(command) {
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
