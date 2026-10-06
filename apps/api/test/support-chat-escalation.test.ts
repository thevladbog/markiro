import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { supportTranscriptNotice } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupportChatFixture, type SupportChatFixture } from "./support/support-chat-fixture";
import { SupportChatEscalationService } from "../src/modules/support-chat/support-chat-escalation.service";
import { SupportChatProposalsService } from "../src/modules/support-chat/support-chat-proposals.service";

const enabled =
  process.env.SUPPORT_CHAT_ISOLATED_DB === "1" &&
  Boolean(process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL);

describe.skipIf(!enabled)("support chat escalation", () => {
  let fixture: SupportChatFixture;
  let operatorId: string;

  beforeAll(async () => {
    fixture = await createSupportChatFixture();
    const [operator] = await fixture.db.select().from(schema.platformUsers).limit(1);
    if (!operator) throw new Error("Expected platform fixture user");
    operatorId = operator.id;
    await fixture.db
      .update(schema.platformUsers)
      .set({ role: "platform_admin", status: "active", twoFactorEnabled: true })
      .where(eq(schema.platformUsers.id, operatorId));
    await fixture.db.insert(schema.platformTwoFactors).values({
      id: randomUUID(),
      userId: operatorId,
      secret: "test-only-totp",
      backupCodes: "[]",
      verified: true,
    });
  }, 90_000);
  afterAll(async () => {
    await fixture?.cleanup();
  });

  async function episode() {
    return (
      await fixture.customerB
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201)
    ).body.id as string;
  }
  async function propose(id: string, key = randomUUID(), title = "Line stopped") {
    return fixture.platform
      .post(`/platform/support-chat/episodes/${id}/proposals`)
      .set("Cookie", fixture.platformCookie)
      .send({ title, summary: "Need a support request", idempotencyKey: key });
  }
  async function decide(
    id: string,
    proposal: { id: string; revision: number; noticeVersion: string },
    decision: "accept" | "decline",
    overrides: Record<string, unknown> = {},
  ) {
    return fixture.customerB
      .post(`/support-chat/episodes/${id}/proposals/${proposal.id}/decision`)
      .send({
        decision,
        revision: proposal.revision,
        noticeVersion: proposal.noticeVersion,
        noticeLocale: "en",
        idempotencyKey: randomUUID(),
        ...overrides,
      });
  }

  it("creates no request for a proposal or decline and rejects stale consent", async () => {
    const id = await episode();
    const proposed = await propose(id);
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ state: "pending", revision: 1 });
    expect(await fixture.db.select().from(schema.tenantBillingRequests)).toHaveLength(0);
    await decide(id, proposed.body, "accept", { revision: 2 }).then((response) =>
      expect(response.status).toBe(409),
    );
    await decide(id, proposed.body, "accept", { noticeVersion: "support-transcript-v0" }).then(
      (response) => expect(response.status).toBe(409),
    );
    const decisionKey = randomUUID();
    await decide(id, proposed.body, "decline", { idempotencyKey: decisionKey }).then((response) =>
      expect(response.status).toBe(201),
    );
    expect(
      (await decide(id, proposed.body, "decline", { idempotencyKey: decisionKey })).status,
    ).toBe(201);
    expect(
      (
        await decide(id, proposed.body, "decline", {
          idempotencyKey: decisionKey,
          noticeLocale: "ru",
        })
      ).status,
    ).toBe(409);
    expect(
      (await decide(id, proposed.body, "accept", { idempotencyKey: decisionKey })).status,
    ).toBe(409);
    const next = await propose(id);
    expect(next.status).toBe(201);
    expect((await decide(id, next.body, "decline", { idempotencyKey: decisionKey })).status).toBe(
      409,
    );
    expect(await fixture.db.select().from(schema.tenantBillingRequests)).toHaveLength(0);
  });

  it("accepts exactly once with an exact notice and distinct audit actors", async () => {
    const id = await episode();
    const proposed = await propose(id);
    expect(proposed.status).toBe(201);
    const key = randomUUID();
    const payload = { idempotencyKey: key };
    const [a, b] = await Promise.all([
      decide(id, proposed.body, "accept", payload),
      decide(id, proposed.body, "accept", payload),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.request?.id).toBe(b.body.request?.id);
    expect(a.body.request?.number).toMatch(/^BR-\d+$/);
    const requestRows = await fixture.db
      .select()
      .from(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.id, a.body.request.id));
    expect(requestRows).toHaveLength(1);
    expect(requestRows[0]).toMatchObject({
      tenantId: fixture.tenantId,
      type: "support",
      createdByUserId: fixture.userB,
    });
    const [requestEvent] = await fixture.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(eq(schema.tenantBillingRequestEvents.requestId, a.body.request.id));
    expect(requestEvent).toMatchObject({
      kind: "created",
      actorKind: "platform_user",
      actorUserId: null,
      actorPlatformUserId: operatorId,
      metadata: {
        source: "support_chat_consent",
        initiatedByUserId: fixture.userB,
        proposedByPlatformUserId: operatorId,
      },
    });
    const consents = await fixture.db
      .select()
      .from(schema.supportChatConsents)
      .where(eq(schema.supportChatConsents.proposalId, proposed.body.id));
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      userId: fixture.userB,
      operatorId,
      noticeVersion: "support-transcript-v1",
      noticeLocale: "en",
      noticeText: supportTranscriptNotice("en").text,
    });
    const jobs = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(
        and(eq(schema.supportChatJobs.episodeId, id), eq(schema.supportChatJobs.kind, "import")),
      );
    expect(jobs).toHaveLength(1);
    const tenantConsentAudit = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
          eq(schema.tenantAuditEvents.action, "support.consent.accepted"),
          eq(schema.tenantAuditEvents.targetId, proposed.body.id),
        ),
      );
    expect(tenantConsentAudit).toHaveLength(1);
    expect(tenantConsentAudit[0]).toMatchObject({
      actorUserId: fixture.userB,
      outcome: "success",
      targetType: "support_chat_proposal",
      after: { initiatedByUserId: fixture.userB, proposedByPlatformUserId: operatorId },
    });
    const tenantRequestAudit = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
          eq(schema.tenantAuditEvents.action, "billing.request.created"),
          eq(schema.tenantAuditEvents.targetId, a.body.request.id),
        ),
      );
    expect(tenantRequestAudit).toHaveLength(0);
    const platformAudit = await fixture.db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.tenantId, fixture.tenantId),
          eq(schema.platformAuditEvents.action, "support.escalation.created"),
          eq(schema.platformAuditEvents.targetId, a.body.request.id),
        ),
      );
    expect(platformAudit).toHaveLength(1);
    expect(platformAudit[0]).toMatchObject({
      actorPlatformUserId: operatorId,
      actorRole: "platform_admin",
      outcome: "success",
      targetType: "tenant_billing_request",
      after: { initiatedByUserId: fixture.userB, proposedByPlatformUserId: operatorId },
    });
    await fixture.db
      .update(schema.platformUsers)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(eq(schema.platformUsers.id, operatorId));
    const replayAfterRevocation = await decide(id, proposed.body, "accept", {
      idempotencyKey: key,
    });
    expect(replayAfterRevocation.status).toBe(201);
    expect(replayAfterRevocation.body.request?.id).toBe(a.body.request.id);
    await fixture.db
      .update(schema.platformUsers)
      .set({ status: "active", updatedAt: new Date(0) })
      .where(eq(schema.platformUsers.id, operatorId));
    expect(
      await fixture.db
        .select()
        .from(schema.supportChatConsents)
        .where(eq(schema.supportChatConsents.proposalId, proposed.body.id)),
    ).toHaveLength(1);
    expect(
      (await decide(id, proposed.body, "accept", { idempotencyKey: key, noticeLocale: "ru" }))
        .status,
    ).toBe(409);
    expect((await fixture.customerB.get(`/billing/requests/${a.body.request.id}`)).status).toBe(
      403,
    );
  });

  it("keeps a manager's consent distinct from the platform-created BR event", async () => {
    await fixture.db
      .update(schema.member)
      .set({ role: "manager" })
      .where(
        and(
          eq(schema.member.organizationId, fixture.tenantId),
          eq(schema.member.userId, fixture.userB),
        ),
      );
    try {
      const id = await episode();
      const proposed = await propose(id);
      expect(proposed.status).toBe(201);
      const accepted = await decide(id, proposed.body, "accept");
      expect(accepted.status).toBe(201);
      const [request] = await fixture.db
        .select()
        .from(schema.tenantBillingRequests)
        .where(eq(schema.tenantBillingRequests.id, accepted.body.request.id));
      expect(request?.createdByUserId).toBe(fixture.userB);
      const [event] = await fixture.db
        .select()
        .from(schema.tenantBillingRequestEvents)
        .where(eq(schema.tenantBillingRequestEvents.requestId, request!.id));
      expect(event).toMatchObject({
        actorKind: "platform_user",
        actorUserId: null,
        actorPlatformUserId: operatorId,
        metadata: { initiatedByUserId: fixture.userB, proposedByPlatformUserId: operatorId },
      });
      const genericBillingAudit = await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.action, "billing.request.created"),
            eq(schema.tenantAuditEvents.targetId, request!.id),
          ),
        );
      expect(genericBillingAudit).toHaveLength(0);
    } finally {
      await fixture.db
        .update(schema.member)
        .set({ role: "member" })
        .where(
          and(
            eq(schema.member.organizationId, fixture.tenantId),
            eq(schema.member.userId, fixture.userB),
          ),
        );
    }
  });

  it("rejects another user and a revoked member before creating any request", async () => {
    const id = await episode();
    const proposed = await propose(id);
    expect(proposed.status).toBe(201);
    const foreign = await fixture.customerA
      .post(`/support-chat/episodes/${id}/proposals/${proposed.body.id}/decision`)
      .send({
        decision: "accept",
        revision: 1,
        noticeVersion: "support-transcript-v1",
        noticeLocale: "ru",
        idempotencyKey: randomUUID(),
      });
    expect(foreign.status).toBe(404);
    const secondOrg = await fixture.customerB
      .post("/api/auth/organization/create")
      .send({ name: "Other support tenant", slug: `support-${randomUUID()}` })
      .expect(200);
    try {
      await fixture.customerB
        .post("/api/auth/organization/set-active")
        .send({ organizationId: secondOrg.body.id })
        .expect(200);
      expect((await decide(id, proposed.body, "accept")).status).toBe(404);
    } finally {
      await fixture.customerB
        .post("/api/auth/organization/set-active")
        .send({ organizationId: fixture.tenantId })
        .expect(200);
    }
    const [membership] = await fixture.db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, fixture.tenantId),
          eq(schema.member.userId, fixture.userB),
        ),
      );
    if (!membership) throw new Error("Missing member fixture");
    await fixture.db.delete(schema.member).where(eq(schema.member.id, membership.id));
    try {
      expect((await decide(id, proposed.body, "accept")).status).toBe(403);
      expect(
        await fixture.db
          .select()
          .from(schema.tenantBillingRequests)
          .where(eq(schema.tenantBillingRequests.contextId, id)),
      ).toHaveLength(0);
    } finally {
      await fixture.db.insert(schema.member).values(membership);
    }
  });

  it("replays a committed acceptance after the caller loses its result", async () => {
    const id = await episode();
    const proposed = await propose(id);
    expect(proposed.status).toBe(201);
    const key = randomUUID();
    const service = fixture.app.get(SupportChatEscalationService);
    await expect(
      (async () => {
        await service.decide(
          { tenantId: fixture.tenantId, userId: fixture.userB },
          id,
          proposed.body.id,
          {
            decision: "accept",
            revision: proposed.body.revision,
            noticeVersion: proposed.body.noticeVersion,
            noticeLocale: "en",
            idempotencyKey: key,
          },
        );
        throw new Error("simulated response lost after commit");
      })(),
    ).rejects.toThrow("simulated response lost after commit");
    const replay = await decide(id, proposed.body, "accept", { idempotencyKey: key });
    expect(replay.status).toBe(201);
    expect(replay.body.request?.number).toMatch(/^BR-\d+$/);
    expect(
      await fixture.db
        .select()
        .from(schema.tenantBillingRequests)
        .where(eq(schema.tenantBillingRequests.contextId, id)),
    ).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(schema.supportChatConsents)
        .where(eq(schema.supportChatConsents.proposalId, proposed.body.id)),
    ).toHaveLength(1);
  });

  it("rejects revoked proposing operators and conflicting proposal keys", async () => {
    const id = await episode();
    const key = randomUUID();
    const proposed = await propose(id, key);
    expect(proposed.status).toBe(201);
    expect((await propose(id, key)).body.id).toBe(proposed.body.id);
    expect((await propose(id, key, "Changed title")).status).toBe(409);
    expect((await propose(id)).status).toBe(409);
    await fixture.db
      .update(schema.platformUsers)
      .set({ status: "suspended" })
      .where(eq(schema.platformUsers.id, operatorId));
    await fixture.db.insert(schema.platformAuditEvents).values({
      actorPlatformUserId: operatorId,
      actorRole: "platform_admin",
      action: "platform.team.suspended",
      outcome: "success",
      targetType: "platform_user",
      targetId: operatorId,
      createdAt: new Date(0),
    });
    try {
      expect((await decide(id, proposed.body, "accept")).status).toBe(409);
      expect(
        await fixture.db
          .select()
          .from(schema.tenantBillingRequests)
          .where(eq(schema.tenantBillingRequests.contextId, id)),
      ).toHaveLength(0);
    } finally {
      await fixture.db
        .update(schema.platformUsers)
        .set({ status: "active", updatedAt: new Date(0) })
        .where(eq(schema.platformUsers.id, operatorId));
    }
    expect((await decide(id, proposed.body, "accept")).status).toBe(409);
    const replacement = await propose(id);
    expect(replacement.status).toBe(201);
    expect(replacement.body.revision).toBe(2);
    expect((await decide(id, replacement.body, "accept")).status).toBe(201);
    const [old] = await fixture.db
      .select()
      .from(schema.supportChatProposals)
      .where(eq(schema.supportChatProposals.id, proposed.body.id));
    expect(old?.state).toBe("declined");
    await fixture.db
      .update(schema.platformUsers)
      .set({ updatedAt: new Date(0) })
      .where(eq(schema.platformUsers.id, operatorId));
  });

  it.each([
    "platform.team.role_changed",
    "platform.team.two_factor_recovered",
    "platform.team.activation_renewed",
    "platform.activation.completed",
  ])("invalidates a proposal when a later %s fact has an older timestamp", async (action) => {
    const id = await episode();
    const proposed = await propose(id);
    expect(proposed.status).toBe(201);
    await fixture.db.insert(schema.platformAuditEvents).values({
      actorPlatformUserId: operatorId,
      actorRole: "platform_admin",
      action,
      outcome: "success",
      targetType: "platform_user",
      targetId: operatorId,
      createdAt: new Date(0),
    });
    expect((await decide(id, proposed.body, "accept")).status).toBe(409);
    expect(
      await fixture.db
        .select()
        .from(schema.tenantBillingRequests)
        .where(eq(schema.tenantBillingRequests.contextId, id)),
    ).toHaveLength(0);
    const replacement = await propose(id);
    expect(replacement.status).toBe(201);
    expect(replacement.body.revision).toBe(2);
  });

  it("does not accept a billing.read-only proposal principal", async () => {
    const id = await episode();
    const service = fixture.app.get(SupportChatProposalsService);
    await expect(
      service.propose(
        {
          userId: operatorId,
          role: "platform_admin",
          capabilities: ["billing.read"],
          twoFactorReady: true,
        } as never,
        id,
        { title: "Support", summary: "Issue", idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await fixture.db
        .select()
        .from(schema.supportChatProposals)
        .where(eq(schema.supportChatProposals.episodeId, id)),
    ).toHaveLength(0);
  });

  it("allows the owner to decline even after the proposing operator loses access", async () => {
    const id = await episode();
    const proposed = await propose(id);
    expect(proposed.status).toBe(201);
    await fixture.db
      .update(schema.platformUsers)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(eq(schema.platformUsers.id, operatorId));
    try {
      expect((await decide(id, proposed.body, "decline")).status).toBe(201);
      expect(
        await fixture.db
          .select()
          .from(schema.tenantBillingRequests)
          .where(eq(schema.tenantBillingRequests.contextId, id)),
      ).toHaveLength(0);
    } finally {
      await fixture.db
        .update(schema.platformUsers)
        .set({ status: "active", updatedAt: new Date(0) })
        .where(eq(schema.platformUsers.id, operatorId));
    }
  });

  it("serializes simultaneous accept and decline on one proposal", async () => {
    const id = await episode();
    const proposed = await propose(id);
    expect(proposed.status).toBe(201);
    const [accept, decline] = await Promise.all([
      decide(id, proposed.body, "accept"),
      decide(id, proposed.body, "decline"),
    ]);
    expect([accept.status, decline.status].sort()).toEqual([201, 409]);
    const consents = await fixture.db
      .select()
      .from(schema.supportChatConsents)
      .where(eq(schema.supportChatConsents.proposalId, proposed.body.id));
    expect(consents).toHaveLength(1);
    const requests = await fixture.db
      .select()
      .from(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.contextId, id));
    expect(requests).toHaveLength(consents[0]?.decision === "accept" ? 1 : 0);
  });
});
