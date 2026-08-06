import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Auth, type Db } from "@markiro/db";
import type { INestApplication } from "@nestjs/common";
import type request from "supertest";
import { AUTH, DB } from "../../src/auth/auth.module";

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

/** Replaces the fixture's sole membership role without changing its session. */
export async function setOnlyOrganizationMemberRole(
  db: Db,
  organizationId: string,
  role: string,
): Promise<void> {
  const rows = await db
    .update(schema.member)
    .set({ role })
    .where(eq(schema.member.organizationId, organizationId))
    .returning({ id: schema.member.id });
  if (rows.length !== 1) {
    throw new Error("Expected exactly one organization member in test fixture");
  }
}

/**
 * Test-only station fixture. Production pairing is deliberately the only
 * production credential path; tests needing an already-paired station seed a
 * durable record through the normal create route, then link a Better Auth key
 * directly through the test harness.
 */
export async function createTestStationDevice(
  app: INestApplication,
  agent: ReturnType<typeof request.agent>,
  name: string,
): Promise<{ apiKey: string; deviceId: string; body: { apiKey: string; deviceId: string } }> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("createTestStationDevice is restricted to tests");
  }
  const db = app.get<Db>(DB);

  const created = await agent.post("/station-devices").send({ name, lineId: null }).expect(201);
  const deviceId = (created.body as { id: string }).id;
  const [device] = await db
    .select({ tenantId: schema.stationDevices.tenantId })
    .from(schema.stationDevices)
    .where(eq(schema.stationDevices.id, deviceId));
  if (!device) throw new Error("Expected test station device to persist");
  const [member] = await db
    .select({ userId: schema.member.userId })
    .from(schema.member)
    .where(eq(schema.member.organizationId, device.tenantId));
  if (!member) throw new Error("Expected test station tenant to have a member");

  const auth = app.get<Auth>(AUTH);
  const key = await auth.api.createApiKey({
    body: {
      configId: "station",
      organizationId: device.tenantId,
      userId: member.userId,
      name,
      metadata: { kind: "station" },
    },
  });
  try {
    await db
      .update(schema.stationDevices)
      .set({ apiKeyId: key.id, pairedAt: new Date(), revokedAt: null })
      .where(eq(schema.stationDevices.id, deviceId));
  } catch (error) {
    await db.delete(schema.apikey).where(eq(schema.apikey.id, key.id));
    throw error;
  }
  return { apiKey: key.key, deviceId, body: { apiKey: key.key, deviceId } };
}
