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
  buildChzOmsAuthPayload,
  buildChzTrueApiAuthPayload,
} from "./chz-constants";
import { ChzCryptoService } from "./chz-crypto.service";

/**
 * Narrow contract PgBossService depends on for its cron-driven `run()` call.
 * Keeping this separate from the concrete class means a rename of `run()`
 * fails the callers' typecheck instead of silently passing through an
 * `as SignerSchedulerService` cast in tests.
 */
export interface SignerScheduler {
  run(now?: Date): Promise<void>;
}

/** Common shape of `chz_api_tokens`/`chz_oms_tokens`: enough for the refresh loop below. */
interface RefreshableToken {
  expiresAt: Date;
}

@Injectable()
export class SignerSchedulerService implements SignerScheduler {
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
      // enqueueing entirely instead; stale-task expiry above still runs. This
      // applies to both true_api_auth and oms_auth alike -- an agent's real
      // СУЗ login would fail the same way in SignerTasksService.complete.
      this.logger.error("CHZ_TOKEN_ENCRYPTION_KEY is not configured; token refresh paused");
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
        await this.refreshTokenKind(now, tenantId, "true_api_auth");
        await this.refreshTokenKind(now, tenantId, "oms_auth");
      } catch (error) {
        this.logger.error(
          `Signer scheduler failed for tenant ${tenantId}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  /**
   * Per-tenant, per-token-kind refresh check: read the current token (if
   * any), emit the one-time degradation event if it just crossed its expiry,
   * and enqueue a fresh signer task when none is already open. `oms_auth`
   * additionally has a "not configured yet" exit: `buildChzOmsAuthPayload`
   * returns `null` when the channel carries no СУЗ installation, and there is
   * nothing to log in or refresh towards in that case.
   */
  private async refreshTokenKind(
    now: Date,
    tenantId: string,
    kind: "true_api_auth" | "oms_auth",
  ): Promise<void> {
    const settings = await this.loadSettings(tenantId);

    if (kind === "true_api_auth") {
      const [token] = await this.db
        .select()
        .from(schema.chzApiTokens)
        .where(eq(schema.chzApiTokens.tenantId, tenantId));
      await this.emitExpiryDegradation(
        tenantId,
        now,
        token,
        "True API token expired; signer agent has not refreshed it",
      );
      if (token && token.expiresAt > new Date(now.getTime() + CHZ_TOKEN_REFRESH_LEAD_MS)) return;
      if (await this.hasOpenTask(tenantId, "true_api_auth")) return;
      const [inserted] = await this.db
        .insert(schema.chzSignerTasks)
        .values({
          tenantId,
          type: "true_api_auth",
          payload: buildChzTrueApiAuthPayload(settings),
        })
        // This check-then-insert is an optimization, not the guarantee: two
        // overlapping run() invocations (two API replicas booting, or boot
        // racing the cron tick) can both pass the `hasOpenTask` check above
        // for the same tenant. The partial unique index
        // chz_signer_tasks_open_uq is the real backstop --
        // onConflictDoNothing() makes the race loser a silent no-op instead
        // of a duplicate КЭП login, and we only log when a row actually
        // landed.
        .onConflictDoNothing()
        .returning({ id: schema.chzSignerTasks.id });
      if (inserted) {
        this.logger.log(`Enqueued True API token refresh for tenant ${tenantId}`);
      }
      return;
    }

    const payload = buildChzOmsAuthPayload(settings);
    if (payload === null) return; // no СУЗ installation configured for this channel yet
    const [token] = await this.db
      .select()
      .from(schema.chzOmsTokens)
      .where(eq(schema.chzOmsTokens.tenantId, tenantId));
    await this.emitExpiryDegradation(
      tenantId,
      now,
      token,
      "СУЗ token expired; signer agent has not refreshed it",
    );
    if (token && token.expiresAt > new Date(now.getTime() + CHZ_TOKEN_REFRESH_LEAD_MS)) return;
    if (await this.hasOpenTask(tenantId, "oms_auth")) return;
    const [inserted] = await this.db
      .insert(schema.chzSignerTasks)
      .values({ tenantId, type: "oms_auth", payload })
      .onConflictDoNothing()
      .returning({ id: schema.chzSignerTasks.id });
    if (inserted) {
      this.logger.log(`Enqueued СУЗ token refresh for tenant ${tenantId}`);
    }
  }

  /** Деградация: токен пересёк границу истечения в последнем cron-периоде — одно error-событие на переход (cron идёт каждые 15 минут). */
  private async emitExpiryDegradation(
    tenantId: string,
    now: Date,
    token: RefreshableToken | undefined,
    message: string,
  ): Promise<void> {
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
        message,
      });
    }
  }

  private async hasOpenTask(tenantId: string, type: string): Promise<boolean> {
    const [open] = await this.db
      .select({ id: schema.chzSignerTasks.id })
      .from(schema.chzSignerTasks)
      .where(
        and(
          eq(schema.chzSignerTasks.tenantId, tenantId),
          eq(schema.chzSignerTasks.type, type),
          inArray(schema.chzSignerTasks.status, ["pending", "claimed"]),
        ),
      )
      .limit(1);
    return Boolean(open);
  }

  private async loadSettings(tenantId: string): Promise<z.infer<typeof chzSignerSettingsSchema>> {
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
