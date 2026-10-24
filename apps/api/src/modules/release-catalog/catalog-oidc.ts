import { createHash } from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { CatalogFault } from "./catalog-types";
export const CATALOG_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const CATALOG_OIDC_AUDIENCE = "markiro-release-catalog";
const githubKeys = createRemoteJWKSet(new URL(`${CATALOG_OIDC_ISSUER}/.well-known/jwks`), {
  timeoutDuration: 5000,
  cooldownDuration: 30000,
  cacheMaxAge: 300000,
});
const id = z.string().regex(/^[1-9][0-9]{0,19}$/),
  sha = z.string().regex(/^[a-f0-9]{40}$/),
  word = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_.-]+$/);
const workflow = z
  .object({
    product: z.enum(["station", "handheld"]),
    environment: word,
    workflowRef: z
      .string()
      .max(512)
      .regex(
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@refs\/heads\/main$/,
      ),
    workflowSha: sha,
    subject: z.string().min(1).max(1024),
    jobWorkflowRef: z
      .string()
      .max(512)
      .regex(
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@(?:refs\/heads\/main|[a-f0-9]{40})$/,
      )
      .optional(),
    jobWorkflowSha: sha.optional(),
  })
  .strict()
  .refine((w) => (w.jobWorkflowRef === undefined) === (w.jobWorkflowSha === undefined));
const configSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    repositoryId: id,
    ownerId: id,
    workflows: z.array(workflow).min(1).max(16),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>(),
      [owner, repo] = c.repository.split("/");
    for (const w of c.workflows) {
      const key = JSON.stringify([w.workflowRef, w.workflowSha, w.environment]);
      const subjects = [
        `repo:${c.repository}:environment:${w.environment}`,
        `repo:${owner}@${c.ownerId}/${repo}@${c.repositoryId}:environment:${w.environment}`,
      ];
      if (
        !w.workflowRef.startsWith(`${c.repository}/`) ||
        seen.has(key) ||
        !subjects.includes(w.subject)
      )
        ctx.addIssue({ code: "custom", message: "invalid pinned publisher" });
      seen.add(key);
    }
  });
export function publisherConfiguration(raw: string | undefined): PublisherConfig | null {
  if (!raw) return null;
  try {
    if (Buffer.byteLength(raw) > 65536) throw new Error();
    return configSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Invalid release catalog publisher configuration");
  }
}
export type PublisherConfig = z.infer<typeof configSchema>;
const claimsSchema = z.object({
  iss: z.literal(CATALOG_OIDC_ISSUER),
  aud: z.literal(CATALOG_OIDC_AUDIENCE),
  sub: z.string(),
  repository: z.string(),
  repository_id: id,
  repository_owner_id: id,
  repository_owner: z.string(),
  ref: z.literal("refs/heads/main"),
  ref_type: z.literal("branch"),
  environment: word,
  workflow_ref: z.string(),
  workflow_sha: sha,
  sha,
  event_name: z.literal("workflow_dispatch"),
  run_id: id,
  run_attempt: id,
  actor_id: id,
  jti: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[0-9A-Za-z_-]+$/),
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  job_workflow_ref: z.string().optional(),
  job_workflow_sha: sha.optional(),
});
export interface GithubPublisherPrincipal {
  kind: "github";
  product: "station" | "handheld";
  repository: string;
  repositoryId: string;
  ownerId: string;
  environment: string;
  workflowRef: string;
  workflowSha: string;
  runId: string;
  runAttempt: string;
  actorId: string;
  fingerprint: string;
  tokenHash: string;
  expiresAt: number;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Only the fixed GitHub key source is used in production; tests inject locally generated JWKS. */
export async function verifyPublisherToken(
  token: string,
  input: unknown,
  now = Math.floor(Date.now() / 1000),
  keys: JWTVerifyGetKey = githubKeys,
): Promise<GithubPublisherPrincipal> {
  const configured = configSchema.safeParse(input);
  if (!configured.success || !Number.isSafeInteger(now) || now < 0)
    throw new CatalogFault("not_ready");
  if (typeof token !== "string" || token.length > 16384 || !token.length)
    throw new CatalogFault("forbidden");
  try {
    const header = decodeProtectedHeader(token);
    if (
      header.alg !== "RS256" ||
      header.typ !== "JWT" ||
      typeof header.kid !== "string" ||
      header.kid.length < 1 ||
      header.kid.length > 256 ||
      Object.keys(header).some((k) => !["alg", "typ", "kid"].includes(k))
    )
      throw new CatalogFault("forbidden");
    const verified = await jwtVerify(
      token,
      async (h, t) => {
        try {
          return await keys(h, t);
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            ["ERR_JWKS_NO_MATCHING_KEY", "ERR_JWKS_MULTIPLE_MATCHING_KEYS"].includes(
              String(error.code),
            )
          )
            throw new CatalogFault("forbidden");
          throw new CatalogFault("unavailable");
        }
      },
      {
        issuer: CATALOG_OIDC_ISSUER,
        audience: CATALOG_OIDC_AUDIENCE,
        algorithms: ["RS256"],
        currentDate: new Date(now * 1000),
        clockTolerance: 30,
        requiredClaims: Object.keys(claimsSchema.shape).filter((k) => !k.startsWith("job_")),
      },
    );
    const parsed = claimsSchema.safeParse(verified.payload);
    if (!parsed.success) throw new CatalogFault("forbidden");
    const c = parsed.data,
      config = configured.data;
    if (
      c.repository !== config.repository ||
      c.repository_id !== config.repositoryId ||
      c.repository_owner_id !== config.ownerId ||
      c.repository_owner !== config.repository.split("/")[0] ||
      c.sha !== c.workflow_sha ||
      c.iat > now + 30 ||
      c.iat < now - 600 ||
      c.nbf > now + 30 ||
      c.nbf < c.iat - 30 ||
      c.exp <= now ||
      c.exp <= c.iat ||
      c.exp - c.iat > 600
    )
      throw new CatalogFault("forbidden");
    const w = config.workflows.find(
      (w) =>
        w.workflowRef === c.workflow_ref &&
        w.workflowSha === c.workflow_sha &&
        w.environment === c.environment &&
        w.subject === c.sub,
    );
    if (!w || w.jobWorkflowRef !== c.job_workflow_ref || w.jobWorkflowSha !== c.job_workflow_sha)
      throw new CatalogFault("forbidden");
    const identity = {
      kind: "github" as const,
      product: w.product,
      repository: c.repository,
      repositoryId: c.repository_id,
      ownerId: c.repository_owner_id,
      environment: c.environment,
      workflowRef: c.workflow_ref,
      workflowSha: c.workflow_sha,
      runId: c.run_id,
      runAttempt: c.run_attempt,
      actorId: c.actor_id,
    };
    return {
      ...identity,
      fingerprint: hash(
        JSON.stringify({
          ...identity,
          jobWorkflowRef: w.jobWorkflowRef ?? null,
          jobWorkflowSha: w.jobWorkflowSha ?? null,
        }),
      ),
      tokenHash: hash(`${CATALOG_OIDC_ISSUER}\0${c.jti}`),
      expiresAt: c.exp * 1000,
    };
  } catch (error) {
    if (error instanceof CatalogFault) throw error;
    throw new CatalogFault("forbidden");
  }
}
export function requirePublisherProduct(principal: GithubPublisherPrincipal, product: unknown) {
  if (principal.product !== product || principal.expiresAt <= Date.now())
    throw new CatalogFault("forbidden");
}
