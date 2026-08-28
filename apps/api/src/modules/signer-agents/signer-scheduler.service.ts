import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { JournalService } from "../integrations/journal.service";
import {
  CHZ_CHANNEL_TYPE,
  CHZ_TASK_STALE_MS,
  CHZ_TOKEN_REFRESH_LEAD_MS,
  CHZ_TRUE_API_BASE_URLS,
} from "./chz-constants";
import { ChzCryptoService } from "./chz-crypto.service";

@Injectable()
export class SignerSchedulerService {
  private readonly logger = new Logger(SignerSchedulerService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly journal: JournalService,
    private readonly crypto: ChzCryptoService,
  ) {}

  /** Идемпотентный проход: детерминирован относительно now — тесты дёргают напрямую. */
  async run(now: Date = new Date()): Promise<void> {
    await this.expireStaleTasks(now);
    await this.enqueueRefreshTasks(now);
  }

  private async expireStaleTasks(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - CHZ_TASK_STALE_MS);
    const expired = await this.db
      .update(schema.chzSignerTasks)
      .set({ status: "expired" })
      .where(
        and(
          inArray(schema.chzSignerTasks.status, ["pending", "claimed"]),
          sql`coalesce(${schema.chzSignerTasks.claimedAt}, ${schema.chzSignerTasks.createdAt}) < ${cutoff}`,
        ),
      )
      .returning({ id: schema.chzSignerTasks.id, tenantId: schema.chzSignerTasks.tenantId });
    for (const task of expired) {
      // A single failed journal append is audit-trail noise, not a reason to
      // abort the rest of the expiry pass -- every other expired task's row
      // update already committed above, so skipping its journal entry here
      // must not stop the loop.
      try {
        await this.journal.append({
          tenantId: task.tenantId,
          channelType: CHZ_CHANNEL_TYPE,
          sessionId: null,
          direction: "local",
          outcome: "warn",
          grain: "item",
          message: "Signer task expired without an agent response",
          details: { taskId: task.id },
        });
      } catch (error) {
        this.logger.error(
          `Signer scheduler failed to journal expired task ${task.id} for tenant ${task.tenantId}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  private async enqueueRefreshTasks(now: Date): Promise<void> {
    if (!this.crypto.isConfigured()) {
      // Without the key, an agent's real КЭП login would only hit a 503 on
      // `/signer-agent/tasks/:id/complete` (SignerTasksService.complete) --
      // enqueueing here would mean every 15-minute tick sends an agent
      // through a real login just to fail storing the result, expire after
      // 30 minutes, and re-enqueue: a silent infinite signing loop. Skip
      // enqueueing entirely instead; stale-task expiry above still runs.
      this.logger.error(
        "CHZ_TOKEN_ENCRYPTION_KEY is not configured; token refresh paused",
      );
      return;
    }
    const tenants = await this.db
      .selectDistinct({ tenantId: schema.chzSignerAgents.tenantId })
      .from(schema.chzSignerAgents)
      .where(eq(schema.chzSignerAgents.status, "active"));
    for (const { tenantId } of tenants) {
      // One tenant's failure (journal insert, task insert) must not abort
      // the whole run and leave every other tenant unprocessed for this tick.
      try {
        const [token] = await this.db
          .select()
          .from(schema.chzApiTokens)
          .where(eq(schema.chzApiTokens.tenantId, tenantId));

        // Деградация: токен пересёк границу истечения в последнем cron-периоде —
        // одно error-событие на переход (cron идёт каждые 15 минут).
        if (
          token &&
          token.expiresAt <= now &&
          token.expiresAt > new Date(now.getTime() - 15 * 60_000)
        ) {
          await this.journal.append({
            tenantId,
            channelType: CHZ_CHANNEL_TYPE,
            sessionId: null,
            direction: "local",
            outcome: "error",
            grain: "session",
            message: "True API token expired; signer agent has not refreshed it",
          });
        }

        const threshold = new Date(now.getTime() + CHZ_TOKEN_REFRESH_LEAD_MS);
        if (token && token.expiresAt > threshold) continue;

        const [open] = await this.db
          .select({ id: schema.chzSignerTasks.id })
          .from(schema.chzSignerTasks)
          .where(
            and(
              eq(schema.chzSignerTasks.tenantId, tenantId),
              eq(schema.chzSignerTasks.type, "true_api_auth"),
              inArray(schema.chzSignerTasks.status, ["pending", "claimed"]),
            ),
          )
          .limit(1);
        if (open) continue;

        const settings = await this.loadSettings(tenantId);
        // This check-then-insert is an optimization, not the guarantee: two
        // overlapping run() invocations (two API replicas booting, or boot
        // racing the cron tick) can both pass the `open` check above for the
        // same tenant. The partial unique index chz_signer_tasks_open_uq is
        // the real backstop — onConflictDoNothing() makes the race loser a
        // silent no-op instead of a duplicate КЭП login, and we only log when
        // a row actually landed.
        const [inserted] = await this.db
          .insert(schema.chzSignerTasks)
          .values({
            tenantId,
            type: "true_api_auth",
            payload: {
              trueApiBaseUrl: CHZ_TRUE_API_BASE_URLS[settings.environment],
              ...(settings.mchdInn ? { inn: settings.mchdInn } : {}),
            },
          })
          .onConflictDoNothing()
          .returning({ id: schema.chzSignerTasks.id });
        if (inserted) {
          this.logger.log(`Enqueued True API token refresh for tenant ${tenantId}`);
        }
      } catch (error) {
        this.logger.error(
          `Signer scheduler failed for tenant ${tenantId}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  private async loadSettings(
    tenantId: string,
  ): Promise<z.infer<typeof chzSignerSettingsSchema>> {
    const [channel] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, CHZ_CHANNEL_TYPE),
        ),
      );
    const parsed = chzSignerSettingsSchema.safeParse(channel?.settings ?? {});
    return parsed.success ? parsed.data : { environment: "production" };
  }
}
