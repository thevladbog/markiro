import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import { generateExchangeCredentials, hashExchangeSecret } from "../exchange/exchange-credentials";
import { CHANNELS, describeChannel, type IntegrationChannelType } from "./channel-registry";
import { silentAfterHoursSchema } from "./dto";
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

/**
 * Page size for `readJournal`. Sessions and orphan events are fetched from
 * two separate queries (real sessions vs. session-less events, see
 * `readJournal` below) and each is capped at this same limit -- but the two
 * are then merged into one combined, re-sorted feed. Without re-slicing
 * AFTER the merge, the route could return up to twice this many records
 * (50 sessions + 50 orphan events) instead of one page of this size; the
 * cap has to apply to the merged result, not to each source independently.
 */
const JOURNAL_PAGE_SIZE = 50;

/**
 * Review fix (PR #32, item 6): the events query below used to carry no
 * `.limit()` at all -- every `integration_events` row belonging to any of
 * this page's (up to `JOURNAL_PAGE_SIZE`) sessions, full stop. A single
 * `mode=import` round journals one `grain: "item"` event per skipped/
 * unmatched offer (`exchange.controller.ts`'s `import()`), so one big
 * catalog can leave a session with thousands of events -- fifty such
 * sessions turn one channel-page load into a tens-of-thousands-of-rows
 * fetch. This caps the events query itself; `JOURNAL_PAGE_SIZE * 20` is
 * generous per session (twenty is already more than a human reads on one
 * page) while keeping the worst case bounded regardless of import size.
 * Accepted limitation: the cap applies to the query as a whole, ordered by
 * recency, not evenly per session -- one very event-heavy recent session can
 * still crowd out an older session's events within this window. That is
 * still a fixed, bounded cost instead of an unbounded one, and the sessions
 * list itself (which is what a channel page actually starts from) is
 * unaffected either way.
 */
export const JOURNAL_EVENTS_LIMIT = JOURNAL_PAGE_SIZE * 20;

/**
 * Review fix (PR #32, item 7): `listCandidates`'s two queries (the queue
 * itself and the unlinked-products pool `suggestProductId` matches against)
 * used to carry no `.limit()` either -- after a first full import, both can
 * run into the thousands. Page-sized rather than unbounded; true
 * cursor/offset pagination for a queue this large is a separate, larger
 * contract change (new query params, an admin-side "load more") left for
 * when a real tenant's queue actually needs it.
 */
export const CANDIDATES_PAGE_SIZE = 1000;
export const UNLINKED_PRODUCTS_LIMIT = 5000;

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

  /**
   * `silentAfterHours` is pulled out of `patch` before anything touches
   * `descriptor.settingsSchema`: it is its own top-level column
   * (`silent_after_hours`, see packages/db/src/schema/integrations.ts), not
   * a member of the channel's own JSONB `settings`. Every `settingsSchema`
   * in `channel-registry.ts` is a plain `z.object()` with no `.passthrough()`,
   * so left mixed in, `safeParse` would just silently strip the key --
   * `parsed.success` stays `true`, the request "succeeds", and the value
   * never reaches the database. That is the exact bug this method used to
   * have: the admin's "порог молчания" field saved with a success toast and
   * changed nothing.
   *
   * Both parts are validated and written independently, and each is only
   * included in the write when the caller actually sent it -- a patch
   * containing only `silentAfterHours` must not reset `settings` back to
   * schema defaults (most fields are optional/defaulted, so re-parsing `{}`
   * would silently blank them), and a patch containing only settings must
   * not reset `silentAfterHours` back to 48. The same "don't touch what
   * wasn't sent" rule applies one level deeper, inside `settings` itself --
   * see the comment right before it's built, below.
   */
  async updateChannel(
    tenantId: string,
    type: IntegrationChannelType,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const descriptor = safeDescribeChannel(type);
    if (!descriptor.available) {
      throw new ConflictException("Channel is not available yet");
    }

    const { silentAfterHours, ...settingsPatch } = patch;

    let settings: Record<string, unknown> | undefined;
    if (Object.keys(settingsPatch).length > 0) {
      const parsed = descriptor.settingsSchema.safeParse(settingsPatch);
      if (!parsed.success) {
        // 400, а не 409: настройки прислали неверной формы — это про запрос,
        // а не про состояние канала.
        throw new BadRequestException(parsed.error.message);
      }

      // Только ключи, которые реально пришли в `settingsPatch` (а не все
      // ключи `parsed.data`), уходят в запись. `parsed.data` несёт значение
      // для КАЖДОГО поля схемы, включая то, которого в запросе не было --
      // `.default()` в `commercemlSettings` (`splitWriteoffDocument`)
      // подставляет его прямо внутри `safeParse`, а поля без default
      // (`priceType`) `safeParse` тоже разворачивает по всей форме схемы.
      // Если бы ниже писался весь `parsed.data`, патч, несущий только
      // `priceType`, вернул бы уже сохранённый `splitWriteoffDocument: true`
      // назад к дефолтному `false` — то же "поменял одно, молча потерял
      // другое", от которого выше уже защищён `silentAfterHours`.
      //
      // Само слияние со старым значением — не отдельный SELECT, а один
      // атомарный `settings || <это>` в SQL при записи (см. ниже): вторая
      // конкурентная правка другого поля не потеряется из-за устаревшего
      // прочитанного состояния.
      //
      // Поле остаётся осознанно сбрасываемым, несмотря на слияние: патч
      // `{ splitWriteoffDocument: false }` всё равно перезапишет ранее
      // сохранённый `true`, потому что решает "пришёл ли этот ключ в
      // запросе", а не "отличается ли значение от дефолта".
      settings = {};
      for (const key of Object.keys(settingsPatch)) {
        settings[key] = parsed.data[key];
      }
    }

    let parsedSilentAfterHours: number | undefined;
    if (silentAfterHours !== undefined) {
      const parsed = silentAfterHoursSchema.safeParse(silentAfterHours);
      if (!parsed.success) {
        throw new BadRequestException(parsed.error.message);
      }
      parsedSilentAfterHours = parsed.data;
    }

    if (settings === undefined && parsedSilentAfterHours === undefined) {
      // Пустой патч: нечего писать, а вставка пустой строки создала бы канал
      // со значениями по умолчанию из воздуха -- канал, который никто не
      // настраивал, должен оставаться `not_configured`, а не обзавестись
      // строкой сам по себе.
      return;
    }

    await this.db
      .insert(schema.integrationChannels)
      .values({
        tenantId,
        type,
        ...(settings !== undefined ? { settings } : {}),
        ...(parsedSilentAfterHours !== undefined
          ? { silentAfterHours: parsedSilentAfterHours }
          : {}),
      })
      .onConflictDoUpdate({
        target: [schema.integrationChannels.tenantId, schema.integrationChannels.type],
        set: {
          // `integration_channels.settings` on the left of `||` is the row's
          // OLD value (Postgres resolves an unqualified/target-table column
          // reference inside `ON CONFLICT ... DO UPDATE SET` to the
          // pre-existing row, same as the `failures + 1` pattern in
          // `exchange-credentials.ts`), not the freshly-proposed `values()`
          // one -- the jsonb `||` merges the two objects, right side wins on
          // shared keys, so this ships only the keys this patch actually
          // sent while leaving every other saved key alone.
          ...(settings !== undefined
            ? {
                settings: sql`${schema.integrationChannels.settings} || ${JSON.stringify(settings)}::jsonb`,
              }
            : {}),
          ...(parsedSilentAfterHours !== undefined
            ? { silentAfterHours: parsedSilentAfterHours }
            : {}),
        },
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
    // `available` alone used to be the only gate here, so `public_api`
    // (available, but authenticated through its own `apikey` rows -- see
    // `api-keys.service.ts`) could mint and persist a REAL, checkable
    // `credentialLogin`/`credentialHash` pair that nothing on the verifying
    // side (`exchange.controller.ts`'s `POST /1c_exchange`) ever reads for
    // this channel: a working "issue" button producing a login+secret that
    // silently authenticates nothing. `usesExchangeCredentials` (see
    // `channel-registry.ts`) is the narrower flag this actually needs.
    if (!descriptor.usesExchangeCredentials) {
      throw new ConflictException("Channel does not use exchange credentials");
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

  /**
   * Полное отключение интеграции (тенант переходит на другую систему):
   * строка канала (настройки + логин/хэш секрета обмена), все сеансы с их
   * cookie, куски файлов, журнал и очередь несопоставленных удаляются одной
   * транзакцией. Удаление строки канала само по себе отзывает `checkauth`
   * (exchange.controller.ts ищет её по `credentialLogin`), но живая cookie
   * проверяется только по `integration_sessions` -- без удаления сеансов 1С
   * посреди обмена продолжила бы слать файлы уже "удалённой" интеграции.
   *
   * Сеансы именно УДАЛЯЮТСЯ, а не завершаются через `finishSession`:
   * предъявление cookie завершённого/просроченного сеанса журналируется
   * (`ExchangeSessionService.resolve`), а `JournalService.append` --
   * upsert по строке канала. Оставь мы строки сеансов, первый же повторный
   * вызов 1С со старой cookie ВОСКРЕСИЛ бы только что удалённый канал
   * (строка с lastOutcome: "error" -> карточка "Ошибка" у канала, которого
   * нет). Для несуществующей строки сеанса `resolve` молчит -- ровно та же
   * граница, что у `checkauth` с неизвестным логином.
   *
   * Итоговое событие пишется прямым insert'ом, НЕ `journal.append` -- по
   * той же причине: upsert внутри `append` создал бы строку канала заново,
   * и `stateOf` показал бы "working" вместо `not_configured`. Событие с
   * `sessionId: null` кабинетный журнал видит через ветку orphan-событий
   * (`readJournal`), так что после удаления журнал отвечает на "куда всё
   * делось" одной записью вместо пустоты.
   *
   * `products.external_ref` сознательно не трогается: как и ручной разрыв
   * связи (`unlinkProduct` -- "разрыв связи не трогает цену"), удаление
   * интеграции не должно молча менять каталог. Для точечного разрыва есть
   * `DELETE /products/:id/external-link`.
   *
   * 409, если строки канала нет: удалять нечего -- то же "отказ вместо
   * тихого no-op", что у `unlinkProduct`. И 409 каналу без учётных данных
   * обмена (`usesExchangeCredentials: false`): у `public_api` аутентификация
   * -- собственный список ключей (`api-keys.service.ts`), удаление строки
   * канала их бы НЕ отозвало, а выглядело бы как "интеграция удалена".
   */
  async deleteChannel(tenantId: string, type: IntegrationChannelType): Promise<void> {
    const descriptor = safeDescribeChannel(type);
    if (!descriptor.usesExchangeCredentials) {
      throw new ConflictException("Channel cannot be deleted this way");
    }

    await this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(schema.integrationChannels)
        .where(
          and(
            eq(schema.integrationChannels.tenantId, tenantId),
            eq(schema.integrationChannels.type, type),
          ),
        )
        .returning({ type: schema.integrationChannels.type });
      if (!deleted) {
        throw new ConflictException("Channel is not configured");
      }

      // Куски файлов не несут channelType -- собираем id сеансов ДО их
      // удаления и чистим по ним (tenantId в where -- страховка границы
      // тенанта, как везде в этом файле).
      const sessions = await tx
        .select({ id: schema.integrationSessions.id })
        .from(schema.integrationSessions)
        .where(
          and(
            eq(schema.integrationSessions.tenantId, tenantId),
            eq(schema.integrationSessions.channelType, type),
          ),
        );
      if (sessions.length > 0) {
        await tx.delete(schema.exchangeUploads).where(
          and(
            eq(schema.exchangeUploads.tenantId, tenantId),
            inArray(
              schema.exchangeUploads.sessionId,
              sessions.map((s) => s.id),
            ),
          ),
        );
      }

      await tx
        .delete(schema.integrationEvents)
        .where(
          and(
            eq(schema.integrationEvents.tenantId, tenantId),
            eq(schema.integrationEvents.channelType, type),
          ),
        );
      await tx
        .delete(schema.integrationSessions)
        .where(
          and(
            eq(schema.integrationSessions.tenantId, tenantId),
            eq(schema.integrationSessions.channelType, type),
          ),
        );
      await tx
        .delete(schema.integrationCandidates)
        .where(
          and(
            eq(schema.integrationCandidates.tenantId, tenantId),
            eq(schema.integrationCandidates.channelType, type),
          ),
        );

      await tx.insert(schema.integrationEvents).values({
        tenantId,
        channelType: type,
        sessionId: null,
        direction: "local",
        outcome: "ok",
        grain: "session",
        message: "Интеграция удалена: настройки, учётные данные и журнал очищены",
      });
    });
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
      .limit(JOURNAL_PAGE_SIZE);

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
          // Review fix (PR #32, item 6): see `JOURNAL_EVENTS_LIMIT`'s own
          // comment -- a large import can journal thousands of `grain: "item"`
          // events against one session; this bounds the query regardless.
          .limit(JOURNAL_EVENTS_LIMIT)
      : [];

    // Review fix (PR #32, item 6): grouped once, here, instead of each
    // session below re-`filter()`ing the whole `events` array
    // (O(sessions × events) -- fifty sessions against thousands of events
    // was fifty full passes over that array on every channel-page load).
    // One pass over `events` distributes every row into its session's own
    // bucket; each session then just reads its own bucket back out.
    const eventsBySessionId = new Map<string, (typeof schema.integrationEvents.$inferSelect)[]>();
    for (const event of events) {
      if (event.sessionId === null) continue;
      const bucket = eventsBySessionId.get(event.sessionId);
      if (bucket) {
        bucket.push(event);
      } else {
        eventsBySessionId.set(event.sessionId, [event]);
      }
    }

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
      .limit(JOURNAL_PAGE_SIZE);

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
      events: eventsBySessionId.get(s.id) ?? [],
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

    // Re-slice AFTER merging both sources (see JOURNAL_PAGE_SIZE above):
    // each query above is already capped at JOURNAL_PAGE_SIZE on its own, but
    // `ordered` combines both, so without this the route could hand back up
    // to twice one page.
    const page = ordered.slice(0, JOURNAL_PAGE_SIZE);

    return {
      sessions: page.map((s) => ({
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
      .orderBy(desc(schema.integrationCandidates.lastSeenAt))
      // Review fix (PR #32, item 7): see `CANDIDATES_PAGE_SIZE`'s own comment.
      .limit(CANDIDATES_PAGE_SIZE);

    if (rows.length === 0) return { candidates: [], truncated: false };

    // Пул для подсказки — только ещё НЕ связанные товары: предложить товар,
    // у которого уже есть чужой external_ref, значит подсунуть подсказку,
    // принятие которой немедленно упрётся в 409 (см. linkCandidate ниже).
    const unlinkedProducts = await this.db
      .select({ id: schema.products.id, name: schema.products.name })
      .from(schema.products)
      .where(
        and(
          eq(schema.products.tenantId, tenantId),
          isNull(schema.products.externalRef),
          // Архивный («не использовать») товар не предлагаем к связыванию.
          eq(schema.products.archived, false),
        ),
      )
      // Review fix (PR #32, item 7): see `UNLINKED_PRODUCTS_LIMIT`'s own comment.
      .limit(UNLINKED_PRODUCTS_LIMIT);

    // Review fix (PR #32, item 7): built ONCE, here, instead of
    // `suggestProductId` re-normalizing every one of `unlinkedProducts` for
    // EVERY row of `rows` (O(candidates × products) -- a few thousand of
    // each after a first full import is millions of `normalizeForMatch`
    // calls on one page load). Each product is normalized exactly once;
    // `suggestProductId` below is then an O(1) map lookup per candidate.
    const unlinkedProductsByNormalizedName =
      groupUnlinkedProductsByNormalizedName(unlinkedProducts);

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
        suggestedProductId: suggestProductId(row, unlinkedProductsByNormalizedName),
      })),
      // Rows hit the page cap -- there may be more beyond it that this page
      // is silently not showing. Not a guarantee there IS more (the (n+1)th
      // row could tie and lose ordering by chance), just that this page
      // alone can't rule it out.
      truncated: rows.length === CANDIDATES_PAGE_SIZE,
    };
  }

  /**
   * Проставляет `external_ref` товару из позиции очереди и убирает саму
   * позицию: она разрешена, очереди в ней больше нет места (бриф Task 10).
   * Товар с уже проставленным `external_ref` — 409: молча перезаписать связь
   * значит увести цены другого товара на этот. Проверка "ещё не связан" и
   * само связывание — один атомарный `UPDATE ... WHERE external_ref IS
   * NULL` внутри транзакции (см. комментарий там), а не отдельный select
   * до неё: `products.external_ref` не под уникальным индексом, так что
   * только атомарность самого запроса, не порядок операторов, не даёт двум
   * одновременным вызовам связать разных кандидатов с одним товаром.
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
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
    if (!product) throw new NotFoundException("Unknown product");

    await this.db.transaction(async (tx) => {
      // Conditional, atomic UPDATE ... WHERE external_ref IS NULL, not a
      // read-then-write: `products.external_ref` carries no unique index, so
      // a plain "read externalRef, then UPDATE if it was null" (the previous
      // shape) lets two concurrent linkCandidate calls both read `null`
      // before either writes. Both would then pass the check, both delete
      // their own candidate row in this same transaction, and only the last
      // UPDATE's value survives on the product -- a silent overwrite of the
      // other candidate's link, exactly what this 409 exists to prevent (a
      // queue worked by two people hits this, not just in theory). Folding
      // the "is it still unlinked" check into the UPDATE's WHERE clause makes
      // it one statement Postgres cannot interleave: whichever transaction's
      // UPDATE commits first wins the row, and the second's UPDATE matches
      // zero rows instead of silently clobbering the first.
      const [updated] = await tx
        .update(schema.products)
        .set({ externalRef: candidate.externalRef })
        .where(
          and(
            eq(schema.products.tenantId, tenantId),
            eq(schema.products.id, productId),
            isNull(schema.products.externalRef),
          ),
        )
        .returning({ id: schema.products.id });
      if (!updated) {
        throw new ConflictException("Product is already linked to an external item");
      }

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
   *
   * 409, если `external_ref` уже пуст: рвать нечего. Без этой проверки
   * update — пустой no-op, но событие журнала «Связь ... разорвана вручную»
   * пишется всё равно, и через недели именно оно отвечает на вопрос «почему
   * товар перестал получать цены» — неправдой, потому что связи не было и
   * разрывать было нечего. Отказ вместо тихого no-op, а не просто пропуск
   * записи журнала: так вызывающая сторона (и экран очереди) тоже видит
   * разницу между «уже не связан» и «только что разорвали».
   */
  async unlinkProduct(tenantId: string, productId: string): Promise<void> {
    const [product] = await this.db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
    if (!product) throw new NotFoundException("Unknown product");

    const [updated] = await this.db
      .update(schema.products)
      .set({ externalRef: null })
      .where(
        and(
          eq(schema.products.tenantId, tenantId),
          eq(schema.products.id, productId),
          isNotNull(schema.products.externalRef),
        ),
      )
      .returning({ id: schema.products.id });
    if (!updated) {
      throw new ConflictException("Product has no external link to remove");
    }

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
 * нормализованное имя кандидата с нормализованным именем каждого ещё не
 * связанного товара. Возвращает id, только если ровно ОДИН товар совпал —
 * двусмысленная подсказка хуже отсутствующей, её примут не глядя (бриф
 * Task 10).
 *
 * Кандидатов артикул (`candidate.article`) НЕ участвует в сравнении: у
 * `products` (packages/db/src/schema/platform.ts) нет ни артикула, ни SKU —
 * сравнивать артикул попросту не с чем. Раньше он подмешивался в тот же
 * набор ключей, что и имя, и сравнивался с ИМЕНЕМ товара — это было хуже,
 * чем бесполезно: артикул кандидата, случайно совпавший по буквам с
 * названием постороннего товара B, либо гасил верную подсказку по товару A
 * (стало два совпадения вместо одного), либо, если имя вообще ни с чем не
 * совпадало, выдавал B как единственную "однозначную" подсказку — уверенно
 * неверный товар. Принятие такой подсказки увело бы цены на чужой товар,
 * то есть ровно тот вред, от которого защищает 409 в linkCandidate, только
 * в обход него. Когда у товара появится собственное поле артикула —
 * сравнивать артикул с артикулом и имя с именем раздельно (каждое как
 * самостоятельный критерий совпадения), а не сваливать оба в один набор
 * ключей, как было здесь.
 */
/**
 * Review fix (PR #32, item 7): every unlinked product normalized exactly
 * ONCE, keyed by its normalized name, so `suggestProductId` below never has
 * to re-normalize the whole product pool per candidate row. Values are a
 * `Set` of ids (not a single id) so a normalized name shared by more than one
 * product is still distinguishable from a genuinely unique match --
 * `suggestProductId` treats `size !== 1` as "no suggestion", the same
 * ambiguity rule it always enforced, just without re-deriving it from a
 * fresh linear scan every time.
 */
function groupUnlinkedProductsByNormalizedName(
  products: { id: string; name: string }[],
): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const product of products) {
    const key = normalizeForMatch(product.name);
    const ids = byName.get(key);
    if (ids) {
      ids.add(product.id);
    } else {
      byName.set(key, new Set([product.id]));
    }
  }
  return byName;
}

function suggestProductId(
  candidate: { name: string },
  unlinkedProductsByNormalizedName: Map<string, Set<string>>,
): string | null {
  const matches = unlinkedProductsByNormalizedName.get(normalizeForMatch(candidate.name));
  return matches?.size === 1 ? [...matches][0]! : null;
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
