import { randomUUID } from "node:crypto";
import type request from "supertest";

/**
 * Signs up a fresh user and creates an org for them, WITHOUT activating it
 * as the session's active organization. Every e2e spec in this directory
 * declares its own copy of this pair (`signUpWithInactiveOrg` /
 * `signUpAndActivate`) inline, each with its own generated-password literal
 * -- which is exactly what GitGuardian's Generic Password detector flags on
 * a NEW file that reintroduces the pattern (see conflicts.e2e.test.ts's
 * history). New specs should import from here instead of pasting another
 * copy, so the literal exists in exactly one place going forward.
 *
 * Not migrating the ~20 already-committed copies here: they predate this
 * helper, are not what's failing CI, and rewriting them is out of scope for
 * the fix that unblocks the red check.
 */
export async function signUpWithInactiveOrg(
  agent: ReturnType<typeof request.agent>,
): Promise<string> {
  const email = `t-${randomUUID()}@example.com`;
  await agent
    .post("/api/auth/sign-up/email")
    .send({ email, password: `Pw-${randomUUID()}!Aa1`, name: "T" })
    .expect(200);

  const org = await agent
    .post("/api/auth/organization/create")
    .send({
      name: "Test Plant",
      slug: `plant-${randomUUID()}`,
      keepCurrentActiveOrganization: true,
    })
    .expect(200);

  return org.body.id as string;
}

export async function signUpAndActivate(agent: ReturnType<typeof request.agent>): Promise<string> {
  const orgId = await signUpWithInactiveOrg(agent);
  await agent.post("/api/auth/organization/set-active").send({ organizationId: orgId }).expect(200);
  return orgId;
}
