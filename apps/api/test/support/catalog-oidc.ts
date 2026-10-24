import { randomUUID } from "node:crypto";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
  type JWSHeaderParameters,
} from "jose";
export async function oidcFixture() {
  const now = Math.floor(Date.now() / 1000),
    key = await generateKeyPair("RS256"),
    jwk = await exportJWK(key.publicKey),
    resolver = createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] });
  const workflow = {
    product: "station" as const,
    environment: "station-release",
    workflowRef: "owner/repo/.github/workflows/station-stable-release.yml@refs/heads/main",
    workflowSha: "b".repeat(40),
    subject: "repo:owner/repo:environment:station-release",
  };
  const config = {
    repository: "owner/repo",
    repositoryId: "123",
    ownerId: "456",
    workflows: [workflow],
  };
  const claims: JWTPayload = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "markiro-release-catalog",
    sub: workflow.subject,
    repository: "owner/repo",
    repository_id: "123",
    repository_owner_id: "456",
    repository_owner: "owner",
    ref: "refs/heads/main",
    ref_type: "branch",
    environment: workflow.environment,
    workflow_ref: workflow.workflowRef,
    workflow_sha: workflow.workflowSha,
    sha: workflow.workflowSha,
    event_name: "workflow_dispatch",
    run_id: "789",
    run_attempt: "1",
    actor_id: "1011",
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 300,
  };
  const sign = (patch: JWTPayload = {}, header: Partial<JWSHeaderParameters> = {}) =>
    new SignJWT({ ...claims, ...patch })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "fixture", ...header })
      .sign(key.privateKey);
  return { now, key, resolver, workflow, config, claims, sign };
}
