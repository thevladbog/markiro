import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { generateExchangeCredentials, hashExchangeSecret } from "../exchange/exchange-credentials";
import { CHANNELS, describeChannel, type IntegrationChannelType } from "./channel-registry";
import type {
  CandidateDto,
  CandidatesPageDto,
  ChannelDetailDto,
  ChannelState,
  ChannelSummaryDto,
  CredentialsIssuedDto,
  JournalPageDto,
} from "./dto";
import { JournalService } from "./journal.service";

/**
 * Bounded retries so a login collision on `integration_channels_login_uq`
 * (global across every tenant and channel) can never fail the whole
 * issuance -- mirrors `MINT_ATTEMPTS` in `pairing.service.ts`'s `issueCode`.
 */
const ISSUE_ATTEMPTS = 5;

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly journal: JournalService,
  ) {}

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

    // Действия человека вне обмена (разрыв связи — Task 10; "checkauth:
    // неверный пароль" до открытия сеанса — see exchange.controller.ts)
    // пишутся с `sessionId: null`, потому что сеанса на этот момент попросту
    // нет. Без этого блока такое событие осело бы в базе, но было бы
    // невидимо в кабинетном журнале: `events` выше собирает только то, что
    // привязано к одному из уже найденных `sessions`. Каждое такое событие
    // становится собственной записью-сеансом из одного события.
    const orphanEvents = await this.db
      .select()
      .from(schema.integrationEvents)
      .where(
        and(
          eq(schema.integrationEvents.tenantId, tenantId),
          eq(schema.integrationEvents.channelType, type),
          isNull(schema.integrationEvents.sessionId),
        ),
      )
      .orderBy(desc(schema.integrationEvents.at))
      .limit(50);

    type SessionLike = {
      id: string;
      startedAt: Date;
      finishedAt: Date | null;
      outcome: string | null;
      summary: Record<string, unknown> | null;
      events: (typeof schema.integrationEvents.$inferSelect)[];
    };

    const realSessions: SessionLike[] = sessions.map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      outcome: s.outcome,
      summary: s.summary ?? null,
      events: events.filter((e) => e.sessionId === s.id),
    }));

    const orphanSessions: SessionLike[] = orphanEvents.map((e) => ({
      id: e.id,
      startedAt: e.at,
      finishedAt: e.at,
      outcome: e.outcome,
      summary: null,
      events: [e],
    }));

    // Сначала — по давности через оба источника вместе, иначе сеансы и
    // одиночные события легли бы двумя раздельными, не перемешанными
    // блоками вместо одной ленты по времени.
    const merged = [...realSessions, ...orphanSessions].sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    );

    // Неуспешный сеанс наверх: его ищут первым, когда обмен сломался
    // (бриф 08, «Channel page»).
    const ordered = [
      ...merged.filter((s) => s.outcome === "error"),
      ...merged.filter((s) => s.outcome !== "error"),
    ];

    return {
      sessions: ordered.map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
        outcome: s.outcome,
        summary: s.summary,
        events: s.events.map((e) => ({
          at: e.at.toISOString(),
          direction: e.direction,
          outcome: e.outcome,
          message: e.message,
          details: e.details ?? null,
        })),
      })),
    };
  }

  /**
   * Очередь несопоставленной номенклатуры (Task 9). `hidden` переключает
   * между двумя непересекающимися видами: по умолчанию (`false`) — рабочая
   * очередь, `hiddenAt IS NULL`; `hidden=true` — то, что убрали с глаз,
   * `hiddenAt IS NOT NULL`. Не объединение: скрытое не должно всплывать в
   * обычном списке КАЖДЫЙ обмен, а отдельный вид "скрытые" — это то самое
   * "остаётся под фильтром и восстанавливается" из брифа Task 10.
   */
  async listCandidates(
    tenantId: string,
    type: IntegrationChannelType,
    hidden: boolean,
  ): Promise<CandidatesPageDto> {
    safeDescribeChannel(type);

    const rows = await this.db
      .select()
      .from(schema.integrationCandidates)
      .where(
        and(
          eq(schema.integrationCandidates.tenantId, tenantId),
          eq(schema.integrationCandidates.channelType, type),
          hidden
            ? isNotNull(schema.integrationCandidates.hiddenAt)
            : isNull(schema.integrationCandidates.hiddenAt),
        ),
      )
      .orderBy(desc(schema.integrationCandidates.lastSeenAt));

    if (rows.length === 0) return { candidates: [] };

    // Пул для подсказки — только ещё НЕ связанные товары: предложить товар,
    // у которого уже есть чужой external_ref, значит подсунуть подсказку,
    // принятие которой немедленно упрётся в 409 (см. linkCandidate ниже).
    const unlinkedProducts = await this.db
      .select({ id: schema.products.id, name: schema.products.name })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), isNull(schema.products.externalRef)));

    return {
      candidates: rows.map((row): CandidateDto => ({
        id: row.id,
        externalRef: row.externalRef,
        name: row.name,
        article: row.article,
        unit: row.unit,
        price: row.price,
        priceType: row.priceType,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        hidden: row.hiddenAt !== null,
        suggestedProductId: suggestProductId(row, unlinkedProducts),
      })),
    };
  }

  /**
   * Проставляет `external_ref` товару из позиции очереди и убирает саму
   * позицию: она разрешена, очереди в ней больше нет места (бриф Task 10).
   * Товар с уже проставленным `external_ref` — 409: молча перезаписать связь
   * значит увести цены другого товара на этот.
   */
  async linkCandidate(
    tenantId: string,
    type: IntegrationChannelType,
    candidateId: string,
    productId: string,
  ): Promise<void> {
    safeDescribeChannel(type);

    const [candidate] = await this.db
      .select()
      .from(schema.integrationCandidates)
      .where(
        and(
          eq(schema.integrationCandidates.tenantId, tenantId),
          eq(schema.integrationCandidates.channelType, type),
          eq(schema.integrationCandidates.id, candidateId),
        ),
      );
    if (!candidate) throw new NotFoundException("Unknown candidate");

    const [product] = await this.db
      .select({ id: schema.products.id, externalRef: schema.products.externalRef })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
    if (!product) throw new NotFoundException("Unknown product");
    if (product.externalRef !== null) {
      throw new ConflictException("Product is already linked to an external item");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.products)
        .set({ externalRef: candidate.externalRef })
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
      await tx
        .delete(schema.integrationCandidates)
        .where(
          and(
            eq(schema.integrationCandidates.tenantId, tenantId),
            eq(schema.integrationCandidates.id, candidateId),
          ),
        );
    });
  }

  async hideCandidate(
    tenantId: string,
    type: IntegrationChannelType,
    candidateId: string,
  ): Promise<void> {
    await this.setHidden(tenantId, type, candidateId, new Date());
  }

  /** Восстанавливает скрытую позицию обратно в рабочую очередь. */
  async unhideCandidate(
    tenantId: string,
    type: IntegrationChannelType,
    candidateId: string,
  ): Promise<void> {
    await this.setHidden(tenantId, type, candidateId, null);
  }

  private async setHidden(
    tenantId: string,
    type: IntegrationChannelType,
    candidateId: string,
    hiddenAt: Date | null,
  ): Promise<void> {
    safeDescribeChannel(type);
    const [row] = await this.db
      .update(schema.integrationCandidates)
      .set({ hiddenAt })
      .where(
        and(
          eq(schema.integrationCandidates.tenantId, tenantId),
          eq(schema.integrationCandidates.channelType, type),
          eq(schema.integrationCandidates.id, candidateId),
        ),
      )
      .returning({ id: schema.integrationCandidates.id });
    if (!row) throw new NotFoundException("Unknown candidate");
  }

  /**
   * Разрыв связи с внешней системой: чистит `external_ref` и только его —
   * цена остаётся как есть (бриф Task 10: «разрыв связи не трогает цену»).
   * Пишется отдельным событием журнала ВНЕ сеанса (`sessionId: null`,
   * `grain: "session"`): вопрос «почему товар перестал получать цены»
   * задают через недели, а построчная (`item`) ретенция живёт четырнадцать
   * дней и его не переживёт.
   *
   * Канал жёстко "commerceml": в отличие от `integration_candidates`,
   * `products.external_ref` не хранит, через какой канал он был проставлен,
   * а сегодня единственный канал, который вообще умеет его проставлять, —
   * `commerceml`.
   */
  async unlinkProduct(tenantId: string, productId: string): Promise<void> {
    const [product] = await this.db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
    if (!product) throw new NotFoundException("Unknown product");

    await this.db
      .update(schema.products)
      .set({ externalRef: null })
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));

    await this.journal.append({
      tenantId,
      channelType: "commerceml",
      sessionId: null,
      direction: "local",
      outcome: "ok",
      grain: "session",
      message: `Связь товара с внешней номенклатурой разорвана вручную (${productId})`,
    });
  }
}

/** Trim/lowercase/collapse-whitespace so "  Жигулёвское  0,5" и "жигулёвское 0,5" совпадают. */
function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Подсказка `suggestedProductId` для одной позиции очереди: сравнивает
 * нормализованное имя (и, если есть, артикул) кандидата с нормализованным
 * именем каждого ещё не связанного товара. Возвращает id, только если
 * ровно ОДИН товар совпал — двусмысленная подсказка хуже отсутствующей,
 * её примут не глядя (бриф Task 10).
 */
function suggestProductId(
  candidate: { name: string; article: string | null },
  products: { id: string; name: string }[],
): string | null {
  const keys = [normalizeForMatch(candidate.name)];
  if (candidate.article) keys.push(normalizeForMatch(candidate.article));

  const matches = new Set(
    products.filter((product) => keys.includes(normalizeForMatch(product.name))).map((p) => p.id),
  );
  return matches.size === 1 ? [...matches][0]! : null;
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
