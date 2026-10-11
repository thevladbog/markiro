import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupportChatFixture, type SupportChatFixture } from "./support/support-chat-fixture";
import { signUpAndActivate } from "./support/auth";
import { SupportChatSyncService } from "../src/modules/support-chat/support-chat-sync.service";

const ready =
  process.env.SUPPORT_CHAT_ISOLATED_DB === "1" &&
  Boolean(process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL);

describe.skipIf(!ready)("support transcript trust domains", () => {
  let fixture: SupportChatFixture;
  let requestId: string;
  let episodeId: string;
  let operatorId: string;
  beforeAll(async () => {
    fixture = await createSupportChatFixture();
    const [operator] = await fixture.db.select().from(schema.platformUsers).limit(1);
    if (!operator) throw new Error("Expected platform user");
    operatorId = operator.id;
    await fixture.db
      .update(schema.platformUsers)
      .set({
        role: "platform_admin",
        status: "active",
        twoFactorEnabled: true,
      })
      .where(eq(schema.platformUsers.id, operator.id));
    await fixture.db.insert(schema.platformTwoFactors).values({
      id: randomUUID(),
      userId: operator.id,
      secret: "test-only-totp",
      backupCodes: "[]",
      verified: true,
    });
    episodeId = (
      await fixture.customerB
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201)
    ).body.id as string;
    const proposal = (
      await fixture.platform
        .post(`/platform/support-chat/episodes/${episodeId}/proposals`)
        .set("Cookie", fixture.platformCookie)
        .send({ title: "Line stopped", summary: "Need help", idempotencyKey: randomUUID() })
        .expect(201)
    ).body as { id: string; revision: number; noticeVersion: string };
    requestId = (
      await fixture.customerB
        .post(`/support-chat/episodes/${episodeId}/proposals/${proposal.id}/decision`)
        .send({
          decision: "accept",
          revision: proposal.revision,
          noticeVersion: proposal.noticeVersion,
          noticeLocale: "en",
          idempotencyKey: randomUUID(),
        })
        .expect(201)
    ).body.request.id as string;
  }, 120_000);
  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("lets billing readers see a request transcript but denies member and foreign scope", async () => {
    const path = `/billing/requests/${requestId}/transcript`;
    const owner = await fixture.customerA.get(path).expect(200);
    expect(owner.body).toEqual({
      items: [],
      nextCursor: null,
      sync: { state: "pending", lastSyncedAt: null, errorCode: null },
    });
    expect((await fixture.customerB.get(path)).status).toBe(403);
    expect(
      (await fixture.customerA.get(`/billing/requests/${randomUUID()}/transcript`)).status,
    ).toBe(404);
    const foreignTenant = fixture.freshAgent();
    await signUpAndActivate(foreignTenant);
    expect((await foreignTenant.get(path)).status).toBe(404);
    const platform = await fixture.platform
      .get(`/platform/billing/requests/${requestId}/transcript`)
      .set("Cookie", fixture.platformCookie)
      .expect(200);
    expect(platform.body).toEqual(owner.body);
    expect(
      (await fixture.anonymous.get(`/platform/billing/requests/${requestId}/transcript`)).status,
    ).toBe(401);
  });

  it("uses stable timestamp then remote ID order and rejects a foreign cursor", async () => {
    const [episode] = await fixture.db
      .select()
      .from(schema.supportChatEpisodes)
      .where(eq(schema.supportChatEpisodes.id, episodeId));
    const [job] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.episodeId, episodeId));
    if (!episode?.remoteConversationId || !job) throw new Error("Expected mapped episode");
    for (const id of [803, 801, 802])
      fixture.upstream.addMessage({
        id,
        conversation_id: episode.remoteConversationId,
        inbox_id: 17,
        content: id === 802 ? "private secret" : `public-${id}`,
        content_type: "text",
        message_type: 1,
        private: id === 802,
        created_at: 1_700_000_000,
        source_id: null,
      });
    const [importJob] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.kind, "import"));
    if (!importJob) throw new Error("Expected import job");
    await fixture.db
      .update(schema.supportChatJobs)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(schema.supportChatJobs.id, importJob.id));
    expect(await fixture.app.get(SupportChatSyncService).run(importJob.id, randomUUID())).toBe(
      true,
    );
    const first = await fixture.customerA
      .get(`/billing/requests/${requestId}/transcript?limit=1`)
      .expect(200);
    expect(first.body.items.map((item: { text: string }) => item.text)).toEqual(["public-801"]);
    expect(first.body.nextCursor).toBeTypeOf("string");
    const second = await fixture.customerA
      .get(`/billing/requests/${requestId}/transcript?limit=1&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body.items.map((item: { text: string }) => item.text)).toEqual(["public-803"]);
    expect(second.body.nextCursor).toBeNull();
    expect(JSON.stringify(second.body)).not.toContain("private secret");
    expect(
      (await fixture.customerA.get(`/billing/requests/${requestId}/transcript?cursor=bogus`))
        .status,
    ).toBe(400);
    expect(
      (
        await fixture.customerB.get(
          `/billing/requests/${requestId}/transcript?cursor=${first.body.nextCursor}`,
        )
      ).status,
    ).toBe(403);
  });

  it("strictly schedules one fenced retry with exact operator audit and revoked denial", async () => {
    const path = `/platform/support-chat/episodes/${episodeId}/retry-sync`;
    expect(
      (
        await fixture.platform
          .post(path)
          .set("Cookie", fixture.platformCookie)
          .send({ arbitrary: true })
      ).status,
    ).toBe(400);
    const first = await fixture.platform
      .post(path)
      .set("Cookie", fixture.platformCookie)
      .send({})
      .expect(200);
    expect(first.body).toMatchObject({ id: episodeId, request: { id: requestId } });
    expect(first.body.sync.state).toBe("pending");
    const jobs = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.episodeId, episodeId));
    expect(jobs.filter((job) => job.kind === "import")).toHaveLength(1);
    const [job] = jobs.filter((item) => item.kind === "import");
    if (!job) throw new Error("Expected import job");
    const leaseToken = randomUUID();
    await fixture.db
      .update(schema.supportChatJobs)
      .set({
        state: "leased",
        attemptToken: leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.supportChatJobs.id, job.id));
    await fixture.platform.post(path).set("Cookie", fixture.platformCookie).send({}).expect(200);
    const [retained] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, job.id));
    expect(retained).toMatchObject({ state: "leased", attemptToken: leaseToken });
    const audits = await fixture.db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.action, "support.transcript.retry_requested"));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actorPlatformUserId: operatorId,
      tenantId: fixture.tenantId,
      targetType: "support_chat_episode",
      targetId: episodeId,
      outcome: "success",
      after: { scheduled: true, jobId: job.id },
    });
    expect(audits[1]).toMatchObject({
      actorPlatformUserId: operatorId,
      tenantId: fixture.tenantId,
      targetType: "support_chat_episode",
      targetId: episodeId,
      outcome: "success",
      after: { scheduled: false, jobId: job.id },
    });
    await fixture.db
      .update(schema.platformUsers)
      .set({ status: "suspended" })
      .where(eq(schema.platformUsers.id, operatorId));
    expect(
      (await fixture.platform.post(path).set("Cookie", fixture.platformCookie).send({})).status,
    ).toBe(403);
  });
});
