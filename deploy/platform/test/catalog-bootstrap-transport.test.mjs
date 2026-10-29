import test from "node:test";
import assert from "node:assert/strict";
import { readBootstrapSshArguments } from "../catalog-bootstrap-transport.mjs";
const dispatch = { toolingSha: "a".repeat(40), runId: "123", runAttempt: "1" };
const target = {
  host: "201.34.136.19",
  port: "22",
  user: "root",
  identityFile: "/tmp/test-key",
  knownHostsFile: "/tmp/test-hosts",
};
test("bootstrap SSH uses strict pinned transport and a fixed new operator path, never an old activation", () => {
  const args = readBootstrapSshArguments(
    target,
    "de7a478d-e712-45bb-b36f-40067a62ab1d",
    "b".repeat(64),
    dispatch,
  );
  assert.ok(args.includes("StrictHostKeyChecking=yes") && args.includes("IdentityAgent=none"));
  assert.match(
    args.at(-1),
    /catalog-bootstrap-executors\/[a-f0-9]{40}\/deploy\/platform\/catalog-bootstrap-transport.mjs execute /,
  );
  assert.ok(!args.at(-1).includes("upgrade-bootstrap"));
  for (const bad of ["../bad", "x; echo forbidden", "$(echo forbidden)"])
    assert.throws(() => readBootstrapSshArguments(target, bad, "b".repeat(64), dispatch));
  assert.throws(() =>
    readBootstrapSshArguments(target, "de7a478d-e712-45bb-b36f-40067a62ab1d", "bad", dispatch),
  );
  assert.throws(() =>
    readBootstrapSshArguments(
      { ...target, host: "evil;echo" },
      "de7a478d-e712-45bb-b36f-40067a62ab1d",
      "b".repeat(64),
      dispatch,
    ),
  );
});
