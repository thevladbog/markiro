import {
  runUsDatasetCommand,
  usDatasetCommandDiagnostic,
} from "./deployment/us-dataset-command-runtime";

async function main(): Promise<void> {
  const result = await runUsDatasetCommand(process.argv.slice(2), process.env);
  // Only owned canonical IDs/hashes and the conservative completion flag leave this boundary.
  process.stdout.write(
    `${JSON.stringify({
      synthetic: true,
      state: result.state,
      datasetComplete: result.datasetComplete,
      datasetId: result.datasetId,
      version: result.version,
      definitionDigest: result.definitionDigest,
      plan: { id: result.artifacts.plan.plan.id, sha256: result.artifacts.plan.artifact.sha256 },
      requests: result.artifacts.requests.map((request) => ({
        unitKey: request.unitKey,
        requestId: request.request.id,
        runId: request.run.id,
        inputDigest: request.run.inputDigest,
        artifacts: request.artifacts.map(({ id, sha256 }) => ({ id, sha256 })),
        artifactsDigest: request.artifactsDigest,
        publicationDigest: request.publicationDigest,
      })),
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(usDatasetCommandDiagnostic(error))}\n`);
  process.exitCode = 1;
});
