import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SupportChatJobsService } from "../src/modules/support-chat/support-chat-jobs.service";
import { SupportChatSyncService } from "../src/modules/support-chat/support-chat-sync.service";
import { createSupportChatFixture, type SupportChatFixture } from "./support/support-chat-fixture";

const ready =
  process.env.SUPPORT_CHAT_ISOLATED_DB === "1" &&
  Boolean(process.env.SUPPORT_CHAT_TEST_MAINTENANCE_URL);

describe.skipIf(!ready)("support transcript job repair", () => {
  let fixture: SupportChatFixture;
  beforeAll(async () => {
    fixture = await createSupportChatFixture();
  }, 120_000);
  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("retains committed due work when a queue wakeup fails", async () => {
    const episodeId = (
      await fixture.customerA
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201)
    ).body.id as string;
    const [job] = await fixture.db
      .insert(schema.supportChatJobs)
      .values({
        tenantId: fixture.tenantId,
        episodeId,
        kind: "import",
        checkpoint: { consentId: randomUUID() },
        nextAttemptAt: new Date(0),
      })
      .returning();
    if (!job) throw new Error("Expected job");
    const repair = fixture.app.get(SupportChatJobsService);
    await repair.repairAndWake(async () => {
      throw new Error("queue unavailable");
    });
    const [retained] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(eq(schema.supportChatJobs.id, job.id));
    expect(retained).toMatchObject({ state: "pending", retryCount: 0 });
    const woken: string[] = [];
    await repair.repairAndWake(async (id) => {
      woken.push(id);
    });
    expect(woken).toContain(job.id);
    await fixture.db
      .update(schema.supportChatJobs)
      .set({
        state: "leased",
        attemptToken: randomUUID(),
        leaseExpiresAt: new Date(0),
      })
      .where(eq(schema.supportChatJobs.id, job.id));
    woken.length = 0;
    await repair.repairAndWake(async (id) => {
      woken.push(id);
    });
    expect(woken).toContain(job.id);
    const [stillLeased] = await fixture.db
      .select()
      .from(schema.supportChatJobs)
      .where(
        and(eq(schema.supportChatJobs.id, job.id), eq(schema.supportChatJobs.state, "leased")),
      );
    expect(stillLeased?.id).toBe(job.id);
  });

  it("backs off from five seconds to five minutes and checks errors every fifteen minutes", async () => {
    const episodeId = (
      await fixture.customerA
        .post("/support-chat/episodes")
        .send({ idempotencyKey: randomUUID() })
        .expect(201)
    ).body.id as string;
    const [job] = await fixture.db
      .insert(schema.supportChatJobs)
      .values({
        tenantId: fixture.tenantId,
        episodeId,
        kind: "import",
        checkpoint: { consentId: randomUUID() },
        nextAttemptAt: new Date(0),
      })
      .returning();
    if (!job) throw new Error("Expected job");
    const sync = fixture.app.get(SupportChatSyncService);
    for (let attempt = 1; attempt <= 12; attempt++) {
      const started = Date.now();
      expect(await sync.run(job.id, randomUUID())).toBe(false);
      const [current] = await fixture.db
        .select()
        .from(schema.supportChatJobs)
        .where(eq(schema.supportChatJobs.id, job.id));
      if (!current) throw new Error("Expected durable job");
      expect(current.retryCount).toBe(attempt);
      expect(current.state).toBe(attempt === 12 ? "failed" : "pending");
      const expectedMs =
        attempt === 12 ? 15 * 60_000 : Math.min(5_000 * 2 ** (attempt - 1), 5 * 60_000);
      expect(current.nextAttemptAt.getTime() - started).toBeGreaterThanOrEqual(expectedMs - 100);
      expect(current.nextAttemptAt.getTime() - started).toBeLessThan(expectedMs + 2_000);
      await fixture.db
        .update(schema.supportChatJobs)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(schema.supportChatJobs.id, job.id));
    }
  });
});
