import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { generateExchangeCredentials, hashExchangeSecret } from "../exchange/exchange-credentials";
import { CHANNELS, describeChannel, type IntegrationChannelType } from "./channel-registry";
import type {
  ChannelDetailDto,
  ChannelState,
  ChannelSummaryDto,
  CredentialsIssuedDto,
  JournalPageDto,
} from "./dto";

/**
 * Bounded retries so a login collision on `integration_channels_login_uq`
 * (global across every tenant and channel) can never fail the whole
 * issuance -- mirrors `MINT_ATTEMPTS` in `pairing.service.ts`'s `issueCode`.
 */
const ISSUE_ATTEMPTS = 5;

@Injectable()
export class IntegrationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listChannels(tenantId: string, now: Date): Promise<{ channels: ChannelSummaryDto[] }> {
    const rows = await this.db
      .select()
      .from(schema.integrationChannels)
      .where(eq(schema.integrationChannels.tenantId, tenantId));

    const channels = CHANNELS.map((descriptor) => {
      const row = rows.find((r) => r.type === descriptor.type);
      return {
        type: descriptor.type,
        labelKey: descriptor.labelKey,
        state: stateOf(descriptor.available, row, now),
        lastEventAt: row?.lastEventAt?.toISOString() ?? null,
      };
    });
    return { channels };
  }

  async getChannel(
    tenantId: string,
    type: IntegrationChannelType,
    now: Date,
  ): Promise<ChannelDetailDto> {
    const descriptor = safeDescribeChannel(type);
    const [row] = await this.db
      .select()
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, type),
        ),
      );

    return {
      type,
      labelKey: descriptor.labelKey,
      state: stateOf(descriptor.available, row, now),
      lastEventAt: row?.lastEventAt?.toISOString() ?? null,
      settings: row?.settings ?? {},
      silentAfterHours: row?.silentAfterHours ?? 48,
      credentialLogin: row?.credentialLogin ?? null,
    };
  }

  async updateChannel(
    tenantId: string,
    type: IntegrationChannelType,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const descriptor = safeDescribeChannel(type);
    if (!descriptor.available) {
      throw new ConflictException("Channel is not available yet");
    }
    const parsed = descriptor.settingsSchema.safeParse(patch);
    if (!parsed.success) {
      // 400, а не 409: настройки прислали неверной формы — это про запрос,
      // а не про состояние канала.
      throw new BadRequestException(parsed.error.message);
    }

    await this.db
      .insert(schema.integrationChannels)
      .values({ tenantId, type, settings: parsed.data })
      .onConflictDoUpdate({
        target: [schema.integrationChannels.tenantId, schema.integrationChannels.type],
        set: { settings: parsed.data },
      });
  }

  /**
   * Mints a fresh machine login+secret pair for `type` and persists the
   * login plus the secret's hash on `integration_channels`. The secret
   * itself is returned here and ONLY here -- `getChannel`/`ChannelDetailDto`
   * never carries it. Issuing again for the same channel overwrites both
   * the login and the hash, so the previous secret stops verifying the
   * instant a new one is issued -- there is only ever one live credential
   * per channel.
   *
   * `credentialLogin` is unique across every tenant and channel
   * (`integration_channels_login_uq`), but `generateExchangeCredentials`
   * mints only an 8 hex-char suffix, so a collision with some other row's
   * login is rare but real. Left unhandled, that collision would surface as
   * a raw 23505 -- an unhandled `Error`, not an `HttpException`, so Nest's
   * default filter would turn it into a 500 for an unlucky tenant instead of
   * simply minting a different login. Mirrors `issueCode` in
   * `pairing.service.ts`: catch the unique violation, mint a fresh pair, and
   * retry the insert a bounded number of times.
   */
  async issueCredentials(
    tenantId: string,
    type: IntegrationChannelType,
  ): Promise<CredentialsIssuedDto> {
    const descriptor = safeDescribeChannel(type);
    if (!descriptor.available) {
      throw new ConflictException("Channel is not available yet");
    }

    for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt++) {
      const { login, secret } = generateExchangeCredentials();
      const credentialHash = await hashExchangeSecret(secret);

      try {
        await this.db
          .insert(schema.integrationChannels)
          .values({ tenantId, type, credentialLogin: login, credentialHash })
          .onConflictDoUpdate({
            target: [schema.integrationChannels.tenantId, schema.integrationChannels.type],
            set: { credentialLogin: login, credentialHash },
          });
      } catch (error) {
        // Another row (any tenant, any channel) already has this login --
        // mint a different one rather than failing the whole issuance.
        if (isLoginCollision(error)) continue;
        throw error;
      }

      return { login, secret };
    }
    throw new Error("Could not mint a unique exchange login");
  }

  async readJournal(tenantId: string, type: IntegrationChannelType): Promise<JournalPageDto> {
    safeDescribeChannel(type);
    const sessions = await this.db
      .select()
      .from(schema.integrationSessions)
      .where(
        and(
          eq(schema.integrationSessions.tenantId, tenantId),
          eq(schema.integrationSessions.channelType, type),
        ),
      )
      .orderBy(desc(schema.integrationSessions.startedAt))
      .limit(50);

    const events = sessions.length
      ? await this.db
          .select()
          .from(schema.integrationEvents)
          .where(
            inArray(
              schema.integrationEvents.sessionId,
              sessions.map((s) => s.id),
            ),
          )
          .orderBy(desc(schema.integrationEvents.at))
      : [];

    // Неуспешный сеанс наверх: его ищут первым, когда обмен сломался
    // (бриф 08, «Channel page»).
    const ordered = [
      ...sessions.filter((s) => s.outcome === "error"),
      ...sessions.filter((s) => s.outcome !== "error"),
    ];

    return {
      sessions: ordered.map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
        outcome: s.outcome,
        summary: s.summary ?? null,
        events: events
          .filter((e) => e.sessionId === s.id)
          .map((e) => ({
            at: e.at.toISOString(),
            direction: e.direction,
            outcome: e.outcome,
            message: e.message,
            details: e.details ?? null,
          })),
      })),
    };
  }
}

/**
 * Состояние канала выводится, а не хранится: хранимое состояние рассинхронится
 * с событиями при первом же пропущенном обновлении, а «молчит» вообще нельзя
 * записать — оно наступает от того, что НИЧЕГО не произошло.
 *
 * Давность проверяется РАНЬШЕ исхода: канал, однажды ошибившийся и с тех пор
 * молчащий, обязан со временем показать «молчит», а не «ошибка» навечно.
 * Ошибка — то, что видно в журнале и так; «с нами никто не разговаривает» —
 * то, что чинят прямо сейчас, и именно это состояние важнее.
 */
function stateOf(
  available: boolean,
  row: typeof schema.integrationChannels.$inferSelect | undefined,
  now: Date,
): ChannelState {
  if (!available) return "unavailable";
  if (!row) return "not_configured";
  if (!row.lastEventAt) return "not_configured";
  const silentAfterMs = row.silentAfterHours * 3_600_000;
  if (now.getTime() - row.lastEventAt.getTime() > silentAfterMs) return "silent";
  if (row.lastOutcome === "error") return "error";
  return "working";
}

/**
 * `describeChannel` throws a plain `Error` for a type not in the registry —
 * fine for code that only ever passes a literal from `IntegrationChannelType`,
 * but here `type` comes straight off the URL path, so it can be anything.
 * Left unwrapped, that `Error` isn't a `HttpException`, so Nest's default
 * filter turns it into a 500. A channel type that simply doesn't exist is a
 * 404, not a server failure.
 */
function safeDescribeChannel(type: IntegrationChannelType) {
  try {
    return describeChannel(type);
  } catch {
    throw new NotFoundException(`Unknown channel type: ${type}`);
  }
}

/**
 * 23505 on `integration_channels_login_uq` -- the freshly minted login in
 * `issueCredentials` already belongs to some other row (any tenant, any
 * channel). Bounded by the same `ISSUE_ATTEMPTS` loop there, never surfaced
 * to the caller -- a login collision must re-mint, not fail the whole
 * issuance.
 */
function isLoginCollision(error: unknown): boolean {
  const err = error as Error & { code?: string; constraint?: string; cause?: unknown };
  const cause = err?.cause as { code?: string; constraint?: string } | undefined;
  const errorCode = err?.code || cause?.code;
  const constraint = err?.constraint || cause?.constraint;
  return errorCode === "23505" && constraint === "integration_channels_login_uq";
}
