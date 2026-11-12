import { randomUUID } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  verifyPublisherToken,
  publisherConfiguration,
} from "../src/modules/release-catalog/catalog-oidc";
import { oidcFixture } from "./support/catalog-oidc";
let f: Awaited<ReturnType<typeof oidcFixture>>;
beforeAll(async () => {
  f = await oidcFixture();
});

function taggedFixture(product: "handheld" | "standalone") {
  const ref = `refs/tags/${product}-publisher-v1`;
  const workflowRef = `${f.config.repository}/.github/workflows/${product}-stable-release.yml@${ref}`;
  const environment = `${product}-stable-publisher`;
  const workflowSha = "d".repeat(40);
  const subject = `repo:${f.config.repository}:environment:${environment}`;
  const workflow = {
    mode: "pinned-tag",
    product,
    environment,
    workflowRef,
    workflowSha,
    subject,
    jobWorkflowRef: workflowRef,
    jobWorkflowSha: workflowSha,
  };
  return {
    workflow,
    config: { ...f.config, workflows: [f.workflow, workflow] },
    claims: {
      ref,
      ref_type: "tag",
      environment,
      sub: subject,
      workflow_ref: workflowRef,
      workflow_sha: workflowSha,
      sha: workflowSha,
      job_workflow_ref: workflowRef,
      job_workflow_sha: workflowSha,
      actor_id: f.config.ownerId,
    },
  };
}

describe("immutable stable publisher tags", () => {
  it.each(["handheld", "standalone"] as const)(
    "admits the exact %s publisher and preserves legacy admission",
    async (product) => {
      const tagged = taggedFixture(product);
      expect(publisherConfiguration(JSON.stringify(tagged.config))).toEqual(tagged.config);
      const verified = await verifyPublisherToken(
        await f.sign(tagged.claims),
        tagged.config,
        f.now,
        f.resolver,
      );
      expect(verified).toMatchObject({
        product,
        mode: "pinned-tag",
        workflowSha: tagged.workflow.workflowSha,
        actorId: f.config.ownerId,
      });
      const legacyToken = await f.sign();
      const baseline = await verifyPublisherToken(legacyToken, f.config, f.now, f.resolver);
      const legacy = await verifyPublisherToken(legacyToken, tagged.config, f.now, f.resolver);
      expect(legacy).toEqual(baseline);
    },
  );

  it("rejects a changed or incomplete tag, repository, environment, job identity, or owner", async () => {
    const tagged = taggedFixture("standalone");
    for (const patch of [
      { ref: "refs/tags/standalone-publisher-v2" },
      { ref_type: "branch" },
      { environment: "standalone-release" },
      {
        workflow_ref:
          "owner/another/.github/workflows/standalone-stable-release.yml@refs/tags/standalone-publisher-v1",
      },
      { workflow_sha: "e".repeat(40), sha: "e".repeat(40) },
      { sha: "e".repeat(40) },
      { job_workflow_ref: undefined },
      { job_workflow_sha: undefined },
      { job_workflow_sha: "e".repeat(40) },
      { actor_id: "1011" },
    ]) {
      await expect(
        verifyPublisherToken(
          await f.sign({ ...tagged.claims, ...patch }),
          tagged.config,
          f.now,
          f.resolver,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("rejects tagged configuration with a moving ref, another product, or a nonidentical job pin", () => {
    const { workflow } = taggedFixture("handheld");
    for (const invalid of [
      { ...workflow, product: "station" },
      { ...workflow, mode: undefined },
      {
        ...workflow,
        workflowRef: workflow.workflowRef.replace(
          "refs/tags/handheld-publisher-v1",
          "refs/heads/main",
        ),
      },
      {
        ...workflow,
        workflowRef: workflow.workflowRef.replace(
          "handheld-publisher-v1",
          "handheld-publisher-v01",
        ),
      },
      { ...workflow, environment: "handheld-release" },
      { ...workflow, jobWorkflowRef: workflow.workflowRef.replace("v1", "v2") },
      { ...workflow, jobWorkflowSha: "e".repeat(40) },
      { ...workflow, jobWorkflowSha: undefined },
    ]) {
      expect(() =>
        publisherConfiguration(JSON.stringify({ ...f.config, workflows: [invalid] })),
      ).toThrow("Invalid release catalog publisher configuration");
    }
  });

  it("cannot admit two commits under the same publisher tag", () => {
    const { workflow } = taggedFixture("handheld");
    const nextSha = "e".repeat(40);
    expect(() =>
      publisherConfiguration(
        JSON.stringify({
          ...f.config,
          workflows: [workflow, { ...workflow, workflowSha: nextSha, jobWorkflowSha: nextSha }],
        }),
      ),
    ).toThrow("Invalid release catalog publisher configuration");
  });
});

describe("pinned GitHub release publisher identity", () => {
  it("accepts GitHub certificate thumbprint and its backdated not-before claim", async () => {
    const token = await f.sign({ nbf: f.now - 600 }, { x5t: "a".repeat(27) });
    expect((await verifyPublisherToken(token, f.config, f.now, f.resolver)).product).toBe(
      "station",
    );
  });
  it("verifies signed station identity without exposing token or raw jti", async () => {
    const token = await f.sign(),
      p = await verifyPublisherToken(token, f.config, f.now, f.resolver);
    expect(p).toMatchObject({
      kind: "github",
      product: "station",
      runId: "789",
      runAttempt: "1",
      actorId: "1011",
      environment: "station-release",
    });
    expect(p.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(p.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(p)).not.toContain(token);
    expect(JSON.stringify(p)).not.toContain(f.claims.jti);
    const renewed = await verifyPublisherToken(
      await f.sign({ jti: randomUUID() }),
      f.config,
      f.now,
      f.resolver,
    );
    expect(renewed.fingerprint).toBe(p.fingerprint);
    expect(renewed.tokenHash).not.toBe(p.tokenHash);
    const rerun = await verifyPublisherToken(
      await f.sign({ run_attempt: "2" }),
      f.config,
      f.now,
      f.resolver,
    );
    expect(rerun.fingerprint).not.toBe(p.fingerprint);
  });
  it("admits a separately pinned handheld workflow and the exact immutable subject format", async () => {
    const w = {
      ...f.workflow,
      product: "handheld" as const,
      environment: "handheld-release",
      workflowRef: "owner/repo/.github/workflows/handheld-release.yml@refs/heads/main",
      subject: "repo:owner@456/repo@123:environment:handheld-release",
    };
    const token = await f.sign({
      environment: w.environment,
      workflow_ref: w.workflowRef,
      sub: w.subject,
    });
    expect(
      (await verifyPublisherToken(token, { ...f.config, workflows: [w] }, f.now, f.resolver))
        .product,
    ).toBe("handheld");
    await expect(verifyPublisherToken(token, f.config, f.now, f.resolver)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it.each([
    ["iss", "https://attacker.invalid"],
    ["aud", "other"],
    ["aud", ["markiro-release-catalog", "other"]],
    ["sub", "repo:owner/repo:pull_request"],
    ["repository", "other/repo"],
    ["repository_id", "999"],
    ["repository_owner_id", "999"],
    ["repository_owner", "other"],
    ["ref", "refs/heads/feature"],
    ["ref_type", "tag"],
    ["environment", "handheld-release"],
    ["workflow_ref", "owner/repo/.github/workflows/other.yml@refs/heads/main"],
    ["workflow_sha", "c".repeat(40)],
    ["sha", "c".repeat(40)],
    ["event_name", "pull_request_target"],
    ["run_id", ""],
    ["run_id", "1e3"],
    ["run_attempt", "0"],
    ["actor_id", 42],
    ["jti", null],
  ] as const)("rejects wrong %s %s", async (key, value) => {
    await expect(
      verifyPublisherToken(await f.sign({ [key]: value }), f.config, f.now, f.resolver),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("rejects missing required claims", async () => {
    for (const key of Object.keys(f.claims)) {
      const payload = { ...f.claims };
      delete payload[key];
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "fixture" })
        .sign(f.key.privateKey);
      await expect(verifyPublisherToken(token, f.config, f.now, f.resolver)).rejects.toMatchObject({
        code: "forbidden",
      });
    }
  });
  it("rejects expired, future, old, fractional and unbounded time claims", async () => {
    for (const patch of [
      { exp: f.now },
      { iat: f.now + 31 },
      { nbf: f.now + 31 },
      { iat: f.now - 601 },
      { exp: f.now + 601 },
      { iat: f.now + 0.5 },
      { nbf: f.now - 601 },
      { exp: f.now - 1 },
    ])
      await expect(
        verifyPublisherToken(await f.sign(patch), f.config, f.now, f.resolver),
      ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("refuses attacker-selected keys, algorithms and forged signatures", async () => {
    for (const header of [
      { jku: "https://attacker.invalid/jwks" },
      { jwk: { kty: "RSA" } },
      { x5u: "https://attacker.invalid" },
      { typ: "other" },
      { x5t: "not-a-certificate-thumbprint" },
    ])
      await expect(
        verifyPublisherToken(await f.sign({}, header), f.config, f.now, f.resolver),
      ).rejects.toMatchObject({ code: "forbidden" });
    const secret = new Uint8Array(32),
      hs = await new SignJWT(f.claims).setProtectedHeader({ alg: "HS256" }).sign(secret);
    await expect(verifyPublisherToken(hs, f.config, f.now, f.resolver)).rejects.toMatchObject({
      code: "forbidden",
    });
    const other = await generateKeyPair("RS256"),
      forged = await new SignJWT(f.claims)
        .setProtectedHeader({ alg: "RS256", kid: "fixture", typ: "JWT" })
        .sign(other.privateKey);
    await expect(verifyPublisherToken(forged, f.config, f.now, f.resolver)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("requires exact reusable-workflow pins and forbids unconfigured reusable context", async () => {
    const job = {
        jobWorkflowRef: "owner/repo/.github/workflows/shared.yml@" + "d".repeat(40),
        jobWorkflowSha: "d".repeat(40),
      },
      config = { ...f.config, workflows: [{ ...f.workflow, ...job }] };
    await expect(
      verifyPublisherToken(await f.sign(), config, f.now, f.resolver),
    ).rejects.toMatchObject({ code: "forbidden" });
    const token = await f.sign({
      job_workflow_ref: job.jobWorkflowRef,
      job_workflow_sha: job.jobWorkflowSha,
    });
    expect((await verifyPublisherToken(token, config, f.now, f.resolver)).product).toBe("station");
    await expect(verifyPublisherToken(token, f.config, f.now, f.resolver)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("never allows signer/standalone publisher configs, duplicate workflow mappings or partial config", async () => {
    const token = await f.sign();
    for (const config of [
      null,
      {},
      { ...f.config, workflows: [{ ...f.workflow, product: "signer" }] },
      { ...f.config, workflows: [{ ...f.workflow, product: "standalone" }] },
      { ...f.config, workflows: [f.workflow, f.workflow] },
    ])
      await expect(verifyPublisherToken(token, config, f.now, f.resolver)).rejects.toMatchObject({
        code: "not_ready",
      });
  });
  it("reports key-source outage as unavailable without leaking its error", async () => {
    const token = await f.sign();
    await expect(
      verifyPublisherToken(token, f.config, f.now, async () => {
        throw new Error("sensitive-network-detail");
      }),
    ).rejects.toMatchObject({ code: "unavailable", message: "release catalog: unavailable" });
  });
});

it("publisher runtime config is absent or exactly pinned, with redacted startup errors", async () => {
  const f = await oidcFixture();
  expect(publisherConfiguration(undefined)).toBeNull();
  expect(publisherConfiguration(JSON.stringify(f.config))).toEqual(f.config);
  for (const raw of [
    "private invalid value",
    JSON.stringify({ ...f.config, credential: "private" }),
  ])
    expect(() => publisherConfiguration(raw)).toThrow(
      "Invalid release catalog publisher configuration",
    );
});
