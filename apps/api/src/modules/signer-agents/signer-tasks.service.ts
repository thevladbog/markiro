import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  chzOmsAuthPayloadSchema,
  chzSignDetachedPayloadSchema,
  chzSignerTaskSchema,
  chzTrueApiAuthPayloadSchema,
  type ChzSignerSignatureComplete,
  type ChzSignerTask,
  type ChzSignerTaskComplete,
  type ChzSignerTaskCompleteBody,
  type ChzSignerTaskFail,
} from "@markiro/platform-contracts";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { JournalService } from "../integrations/journal.service";
import {
  buildChzTrueApiAuthPayload,
  CHZ_CHANNEL_TYPE,
  CHZ_OMS_TOKEN_TTL_MS,
  CHZ_TRUE_API_BASE_URLS,
} from "./chz-constants";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { ChzCryptoService, type EncryptedChzToken } from "./chz-crypto.service";

const CLAIM_POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What `complete()` reports to the journal once its transaction has committed. */
interface CompletionJournalEntry {
  outcome: "ok" | "warn";
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Serves the desktop signer agent's long-poll task queue. `claimNext` polls
 * with a `SELECT ... FOR UPDATE SKIP LOCKED` claim, same shape as
 * pickup/kiosk polling elsewhere in this app -- two agents racing on the
 * same tenant never claim the same row. `complete`/`fail` only ever touch a
 * task this exact agent holds in `claimed` status: a 404 there means either
 * a stale/duplicate report or another agent already owns it (see the
 * "does not let an agent complete a task claimed by another agent" e2e).
 */
@Injectable()
export class SignerTasksService {
  private readonly logger = new Logger(SignerTasksService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: ChzCryptoService,
    private readonly journal: JournalService,
  ) {}

  async claimNext(
    tenantId: string,
    agentId: string,
    waitMs: number,
  ): Promise<ChzSignerTask | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const claimed = await this.tryClaim(tenantId, agentId);
      if (claimed) return claimed;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await sleep(Math.min(CLAIM_POLL_INTERVAL_MS, remaining));
    }
  }

  private async tryClaim(tenantId: string, agentId: string): Promise<ChzSignerTask | null> {
    // Одностейтментный атомарный claim: SKIP LOCKED защищает от гонки двух агентов.
    const [task] = await this.db
      .update(schema.chzSignerTasks)
      .set({
        status: "claimed",
        agentId,
        claimedAt: new Date(),
        attempts: sql`${schema.chzSignerTasks.attempts} + 1`,
      })
      .where(
        sql`${schema.chzSignerTasks.id} in (
          select id from chz_signer_tasks
          where tenant_id = ${tenantId} and status = 'pending'
          order by created_at asc
          limit 1
          for update skip locked
        )`,
      )
      .returning({
        id: schema.chzSignerTasks.id,
        type: schema.chzSignerTasks.type,
        payload: schema.chzSignerTasks.payload,
      });
    if (!task) return null;
    return chzSignerTaskSchema.parse({ id: task.id, type: task.type, payload: task.payload });
  }

  async complete(
    tenantId: string,
    agentId: string,
    taskId: string,
    body: ChzSignerTaskCompleteBody,
  ): Promise<void> {
    const entry = await this.db.transaction(async (tx) => {
      const [task] = await tx
        .select({
          id: schema.chzSignerTasks.id,
          type: schema.chzSignerTasks.type,
          payload: schema.chzSignerTasks.payload,
        })
        .from(schema.chzSignerTasks)
        .where(
          and(
            eq(schema.chzSignerTasks.id, taskId),
            eq(schema.chzSignerTasks.tenantId, tenantId),
            eq(schema.chzSignerTasks.agentId, agentId),
            eq(schema.chzSignerTasks.status, "claimed"),
          ),
        )
        .for("update");
      if (!task) throw new NotFoundException();

      if (task.type === "true_api_auth") {
        if (!("token" in body)) throw new BadRequestException("token body required");
        return this.completeTrueApiAuth(tx, tenantId, agentId, taskId, task.payload, body);
      }
      if (task.type === "oms_auth") {
        if (!("token" in body)) throw new BadRequestException("token body required");
        return this.completeOmsAuth(tx, tenantId, agentId, taskId, task.payload, body);
      }
      if (task.type === "sign_detached") {
        if (!("signatureBase64" in body)) {
          throw new BadRequestException("signatureBase64 body required");
        }
        return this.completeSignDetached(tx, tenantId, taskId, task.payload, body);
      }
      throw new Error(`Unexpected chz_signer_tasks.type value: ${task.type}`);
    });
    // Post-commit side effect: the write has already been committed, so a
    // journal failure here must never throw and must never turn into a 500.
    await this.journal
      .append({
        tenantId,
        channelType: CHZ_CHANNEL_TYPE,
        sessionId: null,
        direction: "in",
        outcome: entry.outcome,
        grain: "item",
        message: entry.message,
        ...(entry.details ? { details: entry.details } : {}),
      })
      .catch((e) => this.logger.warn(`signer task complete journal append failed: ${e}`));
  }

  private async completeTrueApiAuth(
    tx: Tx,
    tenantId: string,
    agentId: string,
    taskId: string,
    rawPayload: Record<string, unknown>,
    body: ChzSignerTaskComplete,
  ): Promise<CompletionJournalEntry> {
    // `ChzCryptoService.encrypt` throws a plain `Error` when
    // `CHZ_TOKEN_ENCRYPTION_KEY` isn't configured -- left unmapped that was a
    // generic 500 here, which the agent retries into an eventual task expiry
    // and re-enqueue (final review, Finding A). Map it to a 503 instead so
    // the failure is legible and the agent can back off.
    let encrypted: EncryptedChzToken;
    try {
      encrypted = this.crypto.encrypt(tenantId, body.token);
    } catch {
      throw new ServiceUnavailableException("CHZ token encryption key is not configured");
    }
    const obtainedAt = new Date();
    const expiresAt = new Date(body.expiresAt);
    const payload = chzTrueApiAuthPayloadSchema.parse(rawPayload);
    const tokenType = payload.tokenFormat ?? "jwt";
    // Ensure even a previously absent channel has a row to lock. Channel
    // updates serialize here; an old in-flight task cannot relabel a bearer.
    await tx
      .insert(schema.integrationChannels)
      .values({ tenantId, type: CHZ_CHANNEL_TYPE })
      .onConflictDoNothing();
    const [channel] = await tx
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, CHZ_CHANNEL_TYPE),
        ),
      )
      .for("update");
    const settings = chzSignerSettingsSchema.parse(channel?.settings ?? {});
    if (payload.trueApiBaseUrl !== CHZ_TRUE_API_BASE_URLS[settings.environment]) {
      await tx
        .update(schema.chzSignerTasks)
        .set({
          status: "failed",
          errorCode: "CHZ_ENVIRONMENT_CHANGED",
          errorMessage: "Signer task environment no longer matches the channel",
          resultSummary: { reason: "CHZ_ENVIRONMENT_CHANGED" },
        })
        .where(
          and(eq(schema.chzSignerTasks.tenantId, tenantId), eq(schema.chzSignerTasks.id, taskId)),
        );
      await tx
        .insert(schema.chzSignerTasks)
        .values({
          tenantId,
          type: "true_api_auth",
          payload: buildChzTrueApiAuthPayload(settings),
        })
        .onConflictDoNothing();
      return {
        outcome: "warn",
        message: "Stale True API token discarded",
        details: { taskId, agentId, reason: "CHZ_ENVIRONMENT_CHANGED" },
      };
    }
    await tx
      .update(schema.chzSignerTasks)
      .set({
        status: "completed",
        completedAt: new Date(),
        resultSummary: { expiresAt: body.expiresAt, certThumbprint: body.certThumbprint },
      })
      .where(
        and(eq(schema.chzSignerTasks.tenantId, tenantId), eq(schema.chzSignerTasks.id, taskId)),
      );
    await tx
      .insert(schema.chzApiTokens)
      .values({
        tenantId,
        encryptedToken: encrypted.encryptedToken,
        tokenNonce: encrypted.tokenNonce,
        tokenTag: encrypted.tokenTag,
        tokenType,
        sourceTrueApiBaseUrl: payload.trueApiBaseUrl,
        obtainedAt,
        expiresAt,
        agentId,
        certThumbprint: body.certThumbprint,
      })
      .onConflictDoUpdate({
        target: schema.chzApiTokens.tenantId,
        set: {
          encryptedToken: encrypted.encryptedToken,
          tokenNonce: encrypted.tokenNonce,
          tokenTag: encrypted.tokenTag,
          tokenType,
          sourceTrueApiBaseUrl: payload.trueApiBaseUrl,
          obtainedAt,
          expiresAt,
          agentId,
          certThumbprint: body.certThumbprint,
          updatedAt: new Date(),
        },
      });
    await tx
      .update(schema.chzSignerAgents)
      .set({
        certThumbprint: body.certThumbprint,
        certSubject: body.certSubject ?? null,
        certInn: body.certInn ?? null,
        certNotAfter: body.certNotAfter ? new Date(body.certNotAfter) : null,
      })
      .where(
        and(eq(schema.chzSignerAgents.tenantId, tenantId), eq(schema.chzSignerAgents.id, agentId)),
      );
    return {
      outcome: "ok",
      message: "True API token refreshed",
      details: { expiresAt: body.expiresAt, certThumbprint: body.certThumbprint },
    };
  }

  private async completeOmsAuth(
    tx: Tx,
    tenantId: string,
    agentId: string,
    taskId: string,
    rawPayload: Record<string, unknown>,
    body: ChzSignerTaskComplete,
  ): Promise<CompletionJournalEntry> {
    const payload = chzOmsAuthPayloadSchema.parse(rawPayload);
    await tx
      .insert(schema.integrationChannels)
      .values({ tenantId, type: CHZ_CHANNEL_TYPE })
      .onConflictDoNothing();
    const [channel] = await tx
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, CHZ_CHANNEL_TYPE),
        ),
      )
      .for("update");
    const settings = chzSignerSettingsSchema.parse(channel?.settings ?? {});
    const expectedTrueApiBaseUrl = CHZ_TRUE_API_BASE_URLS[settings.environment];
    if (
      payload.omsConnection !== settings.omsConnection ||
      payload.trueApiBaseUrl !== expectedTrueApiBaseUrl
    ) {
      // Unlike the True API branch above, we deliberately do not re-enqueue a
      // fresh oms_auth task here: the scheduler's next tick already does that
      // from the channel's current settings once it sees no chz_oms_tokens
      // row (or a stale one). "Fail and stop" avoids racing that tick with a
      // second one-shot insert against the same open-task unique index.
      await tx
        .update(schema.chzSignerTasks)
        .set({
          status: "failed",
          errorCode: "CHZ_OMS_CONNECTION_CHANGED",
          errorMessage: "Signer task OMS connection no longer matches the channel",
          resultSummary: { reason: "CHZ_OMS_CONNECTION_CHANGED" },
        })
        .where(
          and(eq(schema.chzSignerTasks.tenantId, tenantId), eq(schema.chzSignerTasks.id, taskId)),
        );
      return {
        outcome: "warn",
        message: "Stale СУЗ token discarded",
        details: { taskId, agentId, reason: "CHZ_OMS_CONNECTION_CHANGED" },
      };
    }

    let encrypted: EncryptedChzToken;
    try {
      encrypted = this.crypto.encrypt(tenantId, body.token);
    } catch {
      throw new ServiceUnavailableException("CHZ token encryption key is not configured");
    }
    const obtainedAt = new Date();
    const requestedExpiresAt = new Date(body.expiresAt);
    const maxExpiresAt = new Date(obtainedAt.getTime() + CHZ_OMS_TOKEN_TTL_MS);
    const expiresAt = requestedExpiresAt < maxExpiresAt ? requestedExpiresAt : maxExpiresAt;

    await tx
      .update(schema.chzSignerTasks)
      .set({
        status: "completed",
        completedAt: new Date(),
        resultSummary: { expiresAt: expiresAt.toISOString(), certThumbprint: body.certThumbprint },
      })
      .where(
        and(eq(schema.chzSignerTasks.tenantId, tenantId), eq(schema.chzSignerTasks.id, taskId)),
      );
    await tx
      .insert(schema.chzOmsTokens)
      .values({
        tenantId,
        encryptedToken: encrypted.encryptedToken,
        tokenNonce: encrypted.tokenNonce,
        tokenTag: encrypted.tokenTag,
        sourceOmsConnection: payload.omsConnection,
        sourceTrueApiBaseUrl: payload.trueApiBaseUrl,
        obtainedAt,
        expiresAt,
        agentId,
        certThumbprint: body.certThumbprint,
      })
      .onConflictDoUpdate({
        target: schema.chzOmsTokens.tenantId,
        set: {
          encryptedToken: encrypted.encryptedToken,
          tokenNonce: encrypted.tokenNonce,
          tokenTag: encrypted.tokenTag,
          sourceOmsConnection: payload.omsConnection,
          sourceTrueApiBaseUrl: payload.trueApiBaseUrl,
          obtainedAt,
          expiresAt,
          agentId,
          certThumbprint: body.certThumbprint,
          updatedAt: new Date(),
        },
      });
    await tx
      .update(schema.chzSignerAgents)
      .set({
        certThumbprint: body.certThumbprint,
        certSubject: body.certSubject ?? null,
        certInn: body.certInn ?? null,
        certNotAfter: body.certNotAfter ? new Date(body.certNotAfter) : null,
      })
      .where(
        and(eq(schema.chzSignerAgents.tenantId, tenantId), eq(schema.chzSignerAgents.id, agentId)),
      );
    return {
      outcome: "ok",
      message: "СУЗ token refreshed",
      details: { expiresAt: expiresAt.toISOString(), certThumbprint: body.certThumbprint },
    };
  }

  private async completeSignDetached(
    tx: Tx,
    tenantId: string,
    taskId: string,
    rawPayload: Record<string, unknown>,
    body: ChzSignerSignatureComplete,
  ): Promise<CompletionJournalEntry> {
    const payload = chzSignDetachedPayloadSchema.parse(rawPayload);
    await tx
      .update(schema.chzSignerTasks)
      .set({
        status: "completed",
        completedAt: new Date(),
        // The signature is the deliverable a later job (the order runner)
        // reads back from this row -- storing it here is the point of the
        // task, unlike the journal message below, which must never carry it.
        resultSummary: {
          signatureBase64: body.signatureBase64,
          certThumbprint: body.certThumbprint,
        },
      })
      .where(
        and(eq(schema.chzSignerTasks.tenantId, tenantId), eq(schema.chzSignerTasks.id, taskId)),
      );
    return {
      outcome: "ok",
      message: "Detached signature delivered",
      details: { taskId, orderId: payload.orderId },
    };
  }

  async fail(
    tenantId: string,
    agentId: string,
    taskId: string,
    body: ChzSignerTaskFail,
  ): Promise<void> {
    const [task] = await this.db
      .update(schema.chzSignerTasks)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorCode: body.errorCode,
        errorMessage: body.message,
      })
      .where(
        and(
          eq(schema.chzSignerTasks.id, taskId),
          eq(schema.chzSignerTasks.tenantId, tenantId),
          eq(schema.chzSignerTasks.agentId, agentId),
          eq(schema.chzSignerTasks.status, "claimed"),
        ),
      )
      .returning({ id: schema.chzSignerTasks.id });
    if (!task) throw new NotFoundException();
    // Post-commit side effect: the failure has already been recorded, so a
    // journal failure here must never throw and must never turn into a 500.
    await this.journal
      .append({
        tenantId,
        channelType: CHZ_CHANNEL_TYPE,
        sessionId: null,
        direction: "in",
        outcome: "error",
        grain: "item",
        message: `Signer task failed: ${body.errorCode}`,
        details: { errorCode: body.errorCode, errorMessage: body.message },
      })
      .catch((e) => this.logger.warn(`signer task fail journal append failed: ${e}`));
  }
}
