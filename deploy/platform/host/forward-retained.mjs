import { forwardSourceImage } from "./forward-history.mjs";
/** Full private pre-replacement metadata. Never print or upload this document. */
import { canonical, ensure, keys } from "../backup/schemas.mjs";
import { readPrivateFile, writePrivateFile, inventoryDocumentOptions } from "./files.mjs";
import { withHeldForwardState } from "./forward-state.mjs";
import { runHostProcess } from "./process.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
export function validateForwardRetained(record, admission) {
  keys(record, [
    "version",
    "kind",
    "operationId",
    "configurationSha256",
    "postgresImageId",
    "containers",
    "images",
  ]);
  ensure(
    record.version === 1 &&
      record.kind === "platform-forward-retained-runtime" &&
      record.operationId === admission.identity.operationId &&
      record.configurationSha256 === admission.candidateConfigurationSha256,
  );
  ensure(/^sha256:[a-f0-9]{64}$/u.test(record.postgresImageId));
  for (const rows of [record.containers, record.images]) keys(rows, ["postgres", "api", "edge"]);
  for (const service of ["postgres", "api", "edge"]) {
    const c = record.containers[service],
      image = record.images[service],
      selected = forwardSourceImage(admission, service);
    const id = service === "postgres" ? record.postgresImageId : selected.imageId;
    ensure(
      c.Id === admission.baseline.containers[service] &&
        c.Image === id &&
        image.Id === id &&
        image.Os === "linux" &&
        image.Architecture === "amd64",
    );
    ensure(
      c.State.Paused === false &&
        c.State.Restarting === false &&
        c.State.Running === (service === "postgres"),
    );
    if (service === "postgres") ensure(c.State.Health?.Status === "healthy");
    else
      ensure(
        c.Config.Image === selected.reference &&
          Array.isArray(image.RepoDigests) &&
          image.RepoDigests.includes(selected.reference),
      );
  }
  return record;
}
export async function readForwardRetained(root, admission) {
  const bytes = await readPrivateFile(
    root,
    `forward-retained-${admission.identity.operationId}.json`,
    inventoryDocumentOptions,
  );
  return { bytes, record: validateForwardRetained(JSON.parse(bytes), admission) };
}
export async function captureForwardRetained(input, capability, options = {}) {
  keys(options, Object.hasOwn(options, "verifyAdmission") ? ["verifyAdmission"] : []);
  ensure(options.verifyAdmission === undefined || typeof options.verifyAdmission === "function");
  return withHeldForwardState(capability, async (held) => {
    ensure(
      !held.cleanup &&
        held.state.phase === "admitted" &&
        held.state.status === "entered" &&
        !held.state.decision &&
        held.state.migrationEntered,
    );
    ensure(held.root === input.root);
    same(held.state.admission, input.admission);
    const { root, admission } = input;
    if (options.verifyAdmission) {
      await held.verify();
      same(await options.verifyAdmission(held), admission.identity);
      await held.verify();
    }
    const one = async (kind, id) => {
      await held.verify();
      const result = await (input.runProcess ?? runHostProcess)({
        executable: "/usr/bin/docker",
        args: ["--host", "unix:///var/run/docker.sock", kind, "inspect", id],
        cwd: root,
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
          DOCKER_CONFIG: `${root}/docker`,
        },
        timeoutMs: 30000,
        outputLimitBytes: 1048576,
      });
      await held.verify();
      const rows = JSON.parse(String(result.stdout));
      ensure(Array.isArray(rows) && rows.length === 1);
      return rows[0];
    };
    const containers = {},
      images = {};
    for (const service of ["postgres", "api", "edge"]) {
      containers[service] = await one("container", admission.baseline.containers[service]);
      const id =
        service === "postgres"
          ? input.postgresImageId
          : forwardSourceImage(admission, service).imageId;
      images[service] = await one("image", id);
    }
    const record = validateForwardRetained(
      {
        version: 1,
        kind: "platform-forward-retained-runtime",
        operationId: admission.identity.operationId,
        configurationSha256: admission.candidateConfigurationSha256,
        postgresImageId: input.postgresImageId,
        containers,
        images,
      },
      admission,
    );
    await held.verify();
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    // Aggregate inventory-bearing metadata only: explicit existing 2 MiB document
    // budget; each child command retains its normal 1 MiB output bound.
    await writePrivateFile(
      root,
      `forward-retained-${admission.identity.operationId}.json`,
      bytes,
      inventoryDocumentOptions,
    );
    const actual = await readForwardRetained(root, admission);
    ensure(actual.bytes.equals(bytes));
    await held.verify();
    return actual;
  });
}
