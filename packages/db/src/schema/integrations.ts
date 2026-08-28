import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/** `bytea` — drizzle не экспортирует его готовым, а куски файла обмена
 * бинарные: перекодировать их в base64 значит раздуть хранение на треть
 * ради ничего. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

/**
 * Настройки и состояние одного канала у одного тенанта.
 *
 * Реестр каналов живёт в КОДЕ (`channel-registry.ts`), поэтому строки тут
 * появляются только когда тенант канал настроил. Отсутствие строки — это
 * состояние `not_configured`, а не поломка.
 */
export const integrationChannels = pgTable(
  "integration_channels",
  {
    tenantId: tenantId(),
    /** Совпадает с `IntegrationChannelType` из реестра. */
    type: text("type").notNull(),
    /** Своя форма у каждого канала, валидируется схемой дескриптора. */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    credentialLogin: text("credential_login"),
    credentialHash: text("credential_hash"),
    /** Порог состояния «молчит». 48 часов — значение по умолчанию из спеки §7. */
    silentAfterHours: integer("silent_after_hours").notNull().default(48),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastOutcome: text("last_outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.type] }),
    uniqueIndex("integration_channels_login_uq")
      .on(t.credentialLogin)
      .where(sql`credential_login is not null`),
  ],
);

/** Один разговор с внешней системой: от `checkauth` до конца обмена. */
export const integrationSessions = pgTable(
  "integration_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    channelType: text("channel_type").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** null пока сеанс идёт. */
    outcome: text("outcome"),
    /** Хэш cookie, а не сама cookie: на время сеанса она предъявительский ключ. */
    cookieHash: text("cookie_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("integration_sessions_cookie_uq").on(t.cookieHash),
    index("integration_sessions_tenant_started_idx").on(t.tenantId, t.startedAt),
  ],
);

/**
 * Событие журнала. `grain` разделяет ретенцию: сводка по сеансу живёт долго,
 * построчный разбор растёт быстрее и чистится раньше (спека §7).
 */
export const integrationEvents = pgTable(
  "integration_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    channelType: text("channel_type").notNull(),
    /** null для событий вне сеанса — например, разрыва связи руками. */
    sessionId: uuid("session_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    direction: text("direction").notNull(),
    outcome: text("outcome").notNull(),
    grain: text("grain").notNull(),
    message: text("message").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("integration_events_tenant_at_idx").on(t.tenantId, t.at)],
);

/** Позиция внешней системы, не сопоставленная с каталогом. */
export const integrationCandidates = pgTable(
  "integration_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    channelType: text("channel_type").notNull(),
    /** `<Ид>` из CommerceML. */
    externalRef: text("external_ref").notNull(),
    name: text("name").notNull(),
    article: text("article"),
    unit: text("unit"),
    /** Нормализованный GTIN-14 из штрихкода файла — для экрана связки и
     *  автосвязи следующим обменом, когда карточка появится позже позиции.
     *  Нормализация и контрольная цифра проверены на стороне API
     *  (@markiro/domain) до записи; NULL — штрихкода не было или он кривой. */
    gtin: text("gtin"),
    price: numeric("price", { precision: 12, scale: 2 }),
    priceType: text("price_type"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Скрытое не всплывает каждый обмен, но остаётся под фильтром. */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (t) => [
    unique("integration_candidates_ref_uq").on(t.tenantId, t.channelType, t.externalRef),
    index("integration_candidates_tenant_hidden_idx").on(t.tenantId, t.hiddenAt),
  ],
);

/** Кусок файла обмена. Собирается в целое на `mode=import`. */
export const exchangeUploads = pgTable(
  "exchange_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    sessionId: uuid("session_id").notNull(),
    filename: text("filename").notNull(),
    chunk: integer("chunk").notNull(),
    body: bytea("body").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("exchange_uploads_part_uq").on(t.sessionId, t.filename, t.chunk)],
);

/**
 * Счётчик неудачных `checkauth` — форма один в один с `kiosk_pair_attempts`
 * (`pickup.ts:344-353`). Сознательно БЕЗ `tenant_id`: попытка считается ДО
 * того, как тенант известен — логин ещё не проверен, — так что тенанта на
 * момент записи попросту нет. Это осознанное исключение из общего правила
 * «у каждой новой таблицы есть tenant_id», а не недосмотр.
 */
export const exchangeAttempts = pgTable(
  "exchange_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    failures: integer("failures").notNull().default(0),
  },
  (t) => [unique("exchange_attempts_source_window_uq").on(t.source, t.windowStartedAt)],
);

export type IntegrationChannelRow = typeof integrationChannels.$inferSelect;
