import assert from "node:assert/strict";
import test from "node:test";

import { parseRegistryEnvelope, withRegistryAuthentication } from "../registry-auth.mjs";

test("registry envelope carries only the exact credential entries and bounded child stdin", () => {
  const envelope = parseRegistryEnvelope(
    `${JSON.stringify({
      entries: [
        { key: "GHCR_USERNAME", textValue: "user" },
        { key: "GHCR_TOKEN", textValue: "token" },
      ],
      commandInput: '{"state":"pending"}\n',
    })}\n`,
  );
  assert.equal(envelope.commandInput, '{"state":"pending"}\n');
  assert.equal(envelope.payload.entries.length, 2);
  assert.throws(
    () => parseRegistryEnvelope(JSON.stringify({ entries: [], commandInput: "x".repeat(70_000) })),
    /registry credential envelope is invalid/,
  );
});

test("deploy-only registry helper validates Lockbox shape, uses password-stdin, and always cleans up", async () => {
  const calls = [];
  await withRegistryAuthentication(
    {
      getPayload: async () => ({
        entries: [
          { key: "GHCR_USERNAME", textValue: "markiro-deployer" },
          { key: "GHCR_TOKEN", textValue: "sensitive-token" },
        ],
      }),
      makeDirectory: async () => "/run/markiro-registry-auth/session",
      run: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        return { code: 0 };
      },
      remove: async (path) => calls.push({ remove: path }),
    },
    ["node", "deploy/production/deploy.mjs", "prepare"],
    "candidate-input\n",
  );

  assert.deepEqual(calls[0].args, [
    "login",
    "ghcr.io",
    "--username",
    "markiro-deployer",
    "--password-stdin",
  ]);
  assert.equal(calls[0].options.input, "sensitive-token");
  assert.equal(calls[1].options.environment.DOCKER_CONFIG, "/run/markiro-registry-auth/session");
  assert.equal(calls[1].options.input, "candidate-input\n");
  assert.deepEqual(calls[2].args, ["logout", "ghcr.io"]);
  assert.deepEqual(calls[3], { remove: "/run/markiro-registry-auth/session" });
  assert.doesNotMatch(JSON.stringify(calls.map(({ options, ...call }) => call)), /sensitive-token/);
});

test("deploy-only registry helper rejects extra payload entries before docker login", async () => {
  let invoked = false;
  await assert.rejects(
    withRegistryAuthentication(
      {
        getPayload: async () => ({
          entries: [
            { key: "GHCR_USERNAME", textValue: "user" },
            { key: "GHCR_TOKEN", textValue: "token" },
            { key: "DATABASE_URL", textValue: "forbidden" },
          ],
        }),
        makeDirectory: async () => "/run/session",
        run: async () => {
          invoked = true;
        },
        remove: async () => {},
      },
      ["true"],
    ),
    /registry credential payload is invalid/,
  );
  assert.equal(invoked, false);
});
