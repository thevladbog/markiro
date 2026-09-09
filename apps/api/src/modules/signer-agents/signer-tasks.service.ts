import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  chzTrueApiAuthPayloadSchema,
  type ChzSignerTask,
  type ChzSignerTaskComplete,
  type ChzSignerTaskFail,
} from "@markiro/platform-contracts";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import { JournalService } from "../integrations/journal.service";
import {
  buildChzTrueApiAuthPayload,
  CHZ_CHANNEL_TYPE,
  CHZ_TRUE_API_BASE_URLS,
} from "./chz-constants";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { ChzCryptoService, type EncryptedChzToken } from "./chz-crypto.service";

const CLAIM_POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    return {
      id: task.id,
      type: task.type as "true_api_auth",
      payload: chzTrueApiAuthPayloadSchema.parse(task.payload),
    };
  }

  async complete(
    tenantId: string,
    agentId: string,
    taskId: string,
    body: ChzSignerTaskComplete,
  ): Promise<void> {
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
    let staleEnvironment = false;
    await this.db.transaction(async (tx) => {
      const [task] = await tx
        .update(schema.chzSignerTasks)
        .set({
          status: "completed",
          completedAt: new Date(),
          resultSummary: { expiresAt: body.expiresAt, certThumbprint: body.certThumbprint },
        })
        .where(
          and(
            eq(schema.chzSignerTasks.id, taskId),
            eq(schema.chzSignerTasks.tenantId, tenantId),
            eq(schema.chzSignerTasks.agentId, agentId),
            eq(schema.chzSignerTasks.status, "claimed"),
          ),
        )
        .returning({ id: schema.chzSignerTasks.id, payload: schema.chzSignerTasks.payload });
      if (!task) throw new NotFoundException();
      const payload = chzTrueApiAuthPayloadSchema.parse(task.payload);
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
        staleEnvironment = true;
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
        return;
      }
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
          and(
            eq(schema.chzSignerAgents.tenantId, tenantId),
            eq(schema.chzSignerAgents.id, agentId),
          ),
        );
    });
    // Post-commit side effect: the token has already been committed, so a
    // journal failure here must never throw and must never turn into a 500.
    await this.journal
      .append({
        tenantId,
        channelType: CHZ_CHANNEL_TYPE,
        sessionId: null,
        direction: "in",
        outcome: staleEnvironment ? "warn" : "ok",
        grain: "item",
        message: staleEnvironment ? "Stale True API token discarded" : "True API token refreshed",
        details: staleEnvironment
          ? { taskId, agentId, reason: "CHZ_ENVIRONMENT_CHANGED" }
          : { expiresAt: body.expiresAt, certThumbprint: body.certThumbprint },
      })
      .catch((e) => this.logger.warn(`signer task complete journal append failed: ${e}`));
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
