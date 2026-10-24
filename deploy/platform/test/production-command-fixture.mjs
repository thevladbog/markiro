// Shared by production-command*.test.mjs; the cases are split across files so
// `node --test` runs them on separate workers (each makes hundreds of real
// fake-docker process calls).
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { productionAuthorization } from "./production-activation-fixture.mjs";
import { commandIntegrationFixture } from "./host-command-integration-fixture.mjs";
export async function fixture(t) {
  const f = await commandIntegrationFixture(t),
    record = f.record.deployment.preparedTarget;
  record.version = 2;
  const observedAt = Date.now();
  record.observations.egress.observedAt = new Date(observedAt).toISOString();
  record.observations.egress.value = productionAuthorization(record, f, observedAt);
  await f.publish();
  const path = join(f.root, "daemon.json"),
    daemon = JSON.parse(await readFile(path));
  daemon.activationProjection = structuredClone(record.observations.egress.value.review.projection);
  await writeFile(path, JSON.stringify(daemon), { mode: 0o600 });
  return f;
}
export async function calls(f) {
  return String(await readFile(join(f.root, "daemon.json.trace")))
    .trim()
    .split("\n")
    .map(JSON.parse);
}
