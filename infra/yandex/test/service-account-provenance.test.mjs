import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchServiceAccountProvenance,
  validateServiceAccountProvenance,
  validateServiceAccountProvenanceDocument,
} from "../scripts/verify-service-account-provenance.mjs";

const folderId = "folder-production";
const token = "test-iam-token";
const identities = Object.freeze({
  app: "sa-app",
  audit: "sa-audit",
  controller: "sa-controller",
  runner: "sa-runner",
  terraform: "sa-terraform",
});
const names = Object.freeze({
  app: "markiro-production-app",
  audit: "markiro-production-audit",
  controller: "markiro-production-deployment-controller",
  runner: "markiro-production-runner",
  terraform: "markiro-production-terraform",
});

function account(role, overrides = {}) {
  return {
    id: identities[role],
    folderId,
    createdAt: "2026-08-05T00:00:00Z",
    name: names[role],
    description: `${role} account`,
    labels: { environment: "production" },
    status: "ACTIVE",
    ...overrides,
  };
}

function records(overrides = {}) {
  return Object.fromEntries(
    Object.keys(identities).map((role) => [role, overrides[role] ?? account(role)]),
  );
}

test("fetches each supplied ID through authenticated ServiceAccount.Get and emits canonical provenance", async () => {
  const requested = [];
  const result = await fetchServiceAccountProvenance({
    folderId,
    identities,
    token,
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      const id = decodeURIComponent(url.split("/").at(-1));
      const role = Object.keys(identities).find((candidate) => identities[candidate] === id);
      return new Response(JSON.stringify(account(role)));
    },
  });

  assert.deepEqual(result, {
    app: { folderId, id: "sa-app", name: "markiro-production-app", status: "ACTIVE" },
    audit: { folderId, id: "sa-audit", name: "markiro-production-audit", status: "ACTIVE" },
    controller: {
      folderId,
      id: "sa-controller",
      name: "markiro-production-deployment-controller",
      status: "ACTIVE",
    },
    runner: {
      folderId,
      id: "sa-runner",
      name: "markiro-production-runner",
      status: "ACTIVE",
    },
    terraform: {
      folderId,
      id: "sa-terraform",
      name: "markiro-production-terraform",
      status: "ACTIVE",
    },
  });
  assert.deepEqual(
    requested.map(({ url }) => url),
    ["sa-app", "sa-audit", "sa-controller", "sa-runner", "sa-terraform"].map(
      (id) => `https://iam.api.cloud.yandex.net/iam/v1/serviceAccounts/${id}`,
    ),
  );
  for (const { options } of requested) {
    assert.deepEqual(options.headers, { Authorization: `Bearer ${token}` });
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("rejects swapped but distinct identities", () => {
  const swapped = {
    ...identities,
    controller: identities.runner,
    runner: identities.controller,
  };
  assert.throws(
    () => validateServiceAccountProvenance({ folderId, identities: swapped, accounts: records() }),
    /service account provenance is invalid/,
  );
});

test("rejects misnamed, wrong-folder, and suspended service accounts", () => {
  for (const accounts of [
    records({ app: account("app", { name: "markiro-production-runner" }) }),
    records({ audit: account("audit", { folderId: "other-folder" }) }),
    records({ terraform: account("terraform", { status: "SUSPENDED" }) }),
  ]) {
    assert.throws(
      () => validateServiceAccountProvenance({ folderId, identities, accounts }),
      /service account provenance is invalid/,
    );
  }
});

test("rejects missing, extra, malformed, aliased, or mismatched records", () => {
  const { runner: _runner, ...missing } = records();
  for (const [candidateIdentities, accounts] of [
    [identities, missing],
    [identities, { ...records(), extra: account("app") }],
    [identities, { ...records(), app: null }],
    [identities, { ...records(), app: account("app", { id: "other-id" }) }],
    [{ ...identities, runner: identities.app }, records()],
  ]) {
    assert.throws(
      () =>
        validateServiceAccountProvenance({
          folderId,
          identities: candidateIdentities,
          accounts,
        }),
      /service account provenance is invalid/,
    );
  }
});

test("rejects tampered canonical plan evidence", () => {
  const canonical = validateServiceAccountProvenance({ folderId, identities, accounts: records() });
  for (const document of [
    { ...canonical, app: { ...canonical.app, name: "markiro-production-runner" } },
    { ...canonical, app: { ...canonical.app, description: "unexpected" } },
    { ...canonical, extra: canonical.app },
  ]) {
    assert.throws(
      () => validateServiceAccountProvenanceDocument({ folderId, identities, document }),
      /service account provenance is invalid/,
    );
  }
});

test("fails closed on an IAM error without disclosing token or provider response", async () => {
  const errors = [];
  await assert.rejects(
    fetchServiceAccountProvenance({
      folderId,
      identities,
      token,
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: "provider-secret-detail" }), { status: 403 }),
    }),
    (error) => {
      errors.push(error.message);
      return /service account provenance is invalid/.test(error.message);
    },
  );
  assert.doesNotMatch(errors.join("\n"), /test-iam-token|provider-secret-detail|403/);
});

test("rejects each oversized IAM response before accepting otherwise valid account fields", async () => {
  await assert.rejects(
    fetchServiceAccountProvenance({
      folderId,
      identities,
      token,
      fetchImpl: async (url) => {
        const id = decodeURIComponent(url.split("/").at(-1));
        const role = Object.keys(identities).find((candidate) => identities[candidate] === id);
        return new Response(JSON.stringify(account(role, { description: "x".repeat(128 * 1024) })));
      },
    }),
    /service account provenance is invalid/,
  );
});
