import { recordDeploymentStage } from '../../deployment-trace.js';

export async function traceSucceeded(trace, { stage, operation, diagnostics }) {
  if (!trace) return null;
  return recordDeploymentStage(trace, {
    stage,
    operation,
    status: 'succeeded',
    diagnostics,
  });
}

export async function recordSkippedDeploymentStages(trace, stages) {
  if (!trace) return;
  for (const [stage, operation] of stages) {
    await recordDeploymentStage(trace, {
      stage,
      operation,
      status: 'skipped',
    });
  }
}
