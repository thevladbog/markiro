# И-1 «Каркас интеграций и приём цен» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать тенанту секцию «Интеграции» с единой анатомией канала и первым рабочим каналом: 1С приходит на `/1c_exchange`, привозит цены, а незнакомая номенклатура попадает в очередь кандидатов, откуда человек связывает её с каталогом.

**Architecture:** Реестр каналов живёт в коде (дескриптор: тип, схема настроек, адаптер), а в базе лежат только настройки тенанта, состояние и события. Журнал один на все каналы. Протокол «Обмен с сайтом» реализован как конечный автомат поверх сеанса, опознаваемого cookie; разбор CommerceML и применение цен — чистые функции за границей адаптера, тестируемые без HTTP.

**Tech Stack:** NestJS 11 + Drizzle 0.45 + Postgres; React 19 + Vite 8 + TanStack Query в админке; `fast-xml-parser` для разбора; vitest везде.

**Спека:** `docs/superpowers/specs/2026-07-29-commerceml-design.md` (§9 — этот план покрывает И-1).
**Бриф секции:** `docs/design-briefs/08-integrations.md`.

## Global Constraints

- Языки интерфейса: RU первичный + EN, наборы ключей i18n **обязаны совпадать** — это проверяется тестом лок-степа, а отсутствующий ключ бросает исключение в тестовом режиме.
- Мультитенантность: каждая новая таблица несёт `tenant_id`; кабинетные маршруты закрыты `TenantGuard` + `SessionOnlyGuard` (см. `docs/device-key-surface.md`), ключ станции или киоска до них не доходит.
- TDD: сначала падающий тест, потом реализация. Коммит после каждой задачи.
- **Форматировать только затронутые файлы.** `prettier --write .` уходит в соседние git-worktree и портит чужую работу.
- **Точные версии зависимостей.** `saveExact` в этом репозитории фактически не действует (лежит в `.npmrc` в kebab-case, pnpm 11 читает оттуда только registry), поэтому `pnpm add` пишет `^`-диапазон — версию править руками.
- **Миграции.** Генерировать `pnpm --filter @markiro/db db:generate`, читать полученный SQL перед коммитом: он обязан создавать ровно свои таблицы. Снапшоты drizzle кумулятивны, а «применено ли» решается по таймстампу журнала, а не по содержимому, поэтому коллизия индекса с параллельной веткой чинится удалением своих `.sql` + `meta/*_snapshot.json` + записи в `_journal.json` и перегенерацией поверх свежего `main`.
- **API e2e молча пропускаются** без `DATABASE_URL`/`BETTER_AUTH_*`: turbo объявляет их в `test.env`, но не подгружает из `.env`. Перед выводом «зелено» смотреть счётчик skipped. Новый e2e-файл обязан звать `listenOnLoopback(app)` из `apps/api/test/support/listen-loopback.ts`, иначе вернётся флейк с чужими портами.

---

## File Structure

**Сервер**

| Файл                                                           | Ответственность                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/db/src/schema/integrations.ts`                       | Таблицы каналов, сеансов, событий, кандидатов, кусков файла, счётчика попыток |
| `apps/api/src/modules/integrations/channel-registry.ts`        | Дескрипторы каналов — чистые данные, без побочных эффектов                    |
| `apps/api/src/modules/integrations/journal.service.ts`         | Открытие/закрытие сеанса, запись событий, ретенция                            |
| `apps/api/src/modules/integrations/integrations.service.ts`    | Кабинетное чтение каналов, журнала, кандидатов; связывание и разрыв           |
| `apps/api/src/modules/integrations/integrations.controller.ts` | `/integrations/*` под `SessionOnlyGuard`                                      |
| `apps/api/src/modules/integrations/dto.ts`                     | Схемы zod и типы ответов                                                      |
| `apps/api/src/modules/exchange/exchange-credentials.ts`        | Генерация, хэш, проверка учётных данных обмена + счётчик попыток              |
| `apps/api/src/modules/exchange/exchange-session.service.ts`    | Cookie-сеанс, приём кусков, TTL и уборка                                      |
| `apps/api/src/modules/exchange/commerceml/parse.ts`            | Чистый разбор `import.xml` / `offers.xml`, включая cp1251                     |
| `apps/api/src/modules/exchange/commerceml/apply.ts`            | Чистое решение «что применить, что в кандидаты»                               |
| `apps/api/src/modules/exchange/exchange.controller.ts`         | `/1c_exchange` — автомат протокола, без гвардов                               |
| `apps/api/src/modules/api-keys/api-keys.controller.ts`         | Ключи публичного API как канал                                                |

**Админка**

| Файл                                                    | Ответственность                            |
| ------------------------------------------------------- | ------------------------------------------ |
| `apps/admin/src/pages/integrations/api.ts`              | Фетчеры и хуки TanStack Query              |
| `apps/admin/src/pages/integrations/index.tsx`           | Секция: карточки каналов и их состояния    |
| `apps/admin/src/pages/integrations/ChannelPage.tsx`     | Страница канала: шапка, настройки, журнал  |
| `apps/admin/src/pages/integrations/JournalList.tsx`     | Сеансы и события, неуспешный сеанс наверху |
| `apps/admin/src/pages/integrations/CandidatesQueue.tsx` | Очередь: связать, создать, скрыть          |
| `apps/admin/src/pages/integrations/ApiKeysPanel.tsx`    | Список ключей, выпуск и отзыв              |

---

### Task 1: Схема интеграций и миграция

**Files:**

- Create: `packages/db/src/schema/integrations.ts`
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/test/integrations-schema.test.ts`

**Interfaces:**

- Produces: таблицы `integrationChannels`, `integrationSessions`, `integrationEvents`, `integrationCandidates`, `exchangeUploads`, `exchangeAttempts`; тип `IntegrationChannelRow = typeof integrationChannels.$inferSelect`.

- [ ] **Step 1: Написать падающий тест**

```ts
// packages/db/test/integrations-schema.test.ts
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("integrations schema", () => {
  it("ключует канал парой (тенант, тип) — одна интеграция каждого типа на организацию", () => {
    expect(schema.integrationChannels).toBeDefined();
    const columns = Object.keys(schema.integrationChannels);
    expect(columns).toEqual(
      expect.arrayContaining(["tenantId", "type", "settings", "silentAfterHours", "lastEventAt"]),
    );
  });

  it("держит кандидатов и куски файла отдельными таблицами", () => {
    expect(schema.integrationCandidates).toBeDefined();
    expect(schema.exchangeUploads).toBeDefined();
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pnpm --filter @markiro/db exec vitest run integrations-schema`
Expected: FAIL — `schema.integrationChannels` is undefined.

- [ ] **Step 3: Написать схему**

```ts
// packages/db/src/schema/integrations.ts
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

/** `bytea` — drizzle не экспортирует его готовым, а куски файла обмена
 * бинарные: перекодировать их в base64 значит раздуть хранение на треть
 * ради ничего. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const tenantId = () => text("tenant_id").notNull();

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

/** Счётчик неудачных `checkauth` — форма один в один с `kiosk_pair_attempts`. */
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
```

Добавить `import { sql } from "drizzle-orm";` в шапку файла и реэкспорт в `packages/db/src/schema.ts` рядом с существующими:

```ts
export * from "./schema/integrations.js";
```

- [ ] **Step 4: Запустить тест — проходит**

Run: `pnpm --filter @markiro/db exec vitest run integrations-schema`
Expected: PASS (2 теста).

- [ ] **Step 5: Сгенерировать и прочитать миграцию**

Run: `pnpm --filter @markiro/db db:generate`
Прочитать полученный `.sql`: он обязан создавать ровно шесть таблиц выше и ничего больше. Затем применить: `pnpm --filter @markiro/db db:migrate`.

- [ ] **Step 6: Коммит**

```bash
git add packages/db/src/schema/integrations.ts packages/db/src/schema.ts packages/db/test/integrations-schema.test.ts packages/db/migrations
git commit -m "feat(db): integrations channels, journal, candidates and exchange staging"
```

---

### Task 2: Реестр каналов

**Files:**

- Create: `apps/api/src/modules/integrations/channel-registry.ts`
- Test: `apps/api/test/channel-registry.test.ts`

**Interfaces:**

- Produces: `IntegrationChannelType`, `ChannelDescriptor`, `CHANNELS`, `describeChannel(type)`.

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/channel-registry.test.ts
import { describe, expect, it } from "vitest";
import { CHANNELS, describeChannel } from "../src/modules/integrations/channel-registry";

describe("channel registry", () => {
  it("объявляет каналы, которые секция должна показать с первого дня", () => {
    expect(CHANNELS.map((c) => c.type)).toEqual([
      "commerceml",
      "public_api",
      "gis_mt_files",
      "chestny_znak",
    ]);
  });

  it("канал без адаптера объявлен недоступным, а не спрятан", () => {
    expect(describeChannel("chestny_znak").available).toBe(false);
    expect(describeChannel("gis_mt_files").available).toBe(false);
    expect(describeChannel("commerceml").available).toBe(true);
  });

  it("валидирует настройки схемой своего дескриптора", () => {
    const ok = describeChannel("commerceml").settingsSchema.safeParse({
      priceType: "Розничная",
      splitWriteoffDocument: false,
    });
    expect(ok.success).toBe(true);

    const bad = describeChannel("commerceml").settingsSchema.safeParse({ priceType: 42 });
    expect(bad.success).toBe(false);
  });

  it("не знает неизвестного типа", () => {
    expect(() => describeChannel("nope" as never)).toThrow(/unknown channel/i);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pnpm --filter @markiro/api exec vitest run channel-registry`
Expected: FAIL — модуль не резолвится.

- [ ] **Step 3: Написать реестр**

```ts
// apps/api/src/modules/integrations/channel-registry.ts
import { z } from "zod";

export type IntegrationChannelType = "commerceml" | "public_api" | "gis_mt_files" | "chestny_znak";

/**
 * Дескриптор канала. Реестр — КОД, конфигурация — данные: добавить интеграцию
 * значит добавить сюда запись и адаптер, а не миграцию, экран и свой журнал
 * (бриф 08, «How this grows»).
 */
export interface ChannelDescriptor {
  type: IntegrationChannelType;
  /** Ключ i18n названия; текст живёт в админке, не на сервере. */
  labelKey: string;
  /** false — карточка рисуется как все, но в состоянии «недоступно». */
  available: boolean;
  /** Приходит ли внешняя система сама (влияет на состояние «молчит»). */
  inbound: boolean;
  settingsSchema: z.ZodType<Record<string, unknown>>;
}

const commercemlSettings = z.object({
  /** Какой тип цены ложится в `products.unit_price`. Пусто — решаем по файлу. */
  priceType: z.string().min(1).optional(),
  /** Разделять ли списание в свой тип документа (используется в И-2). */
  splitWriteoffDocument: z.boolean().default(false),
});

const emptySettings = z.object({}).passthrough();

export const CHANNELS: readonly ChannelDescriptor[] = [
  {
    type: "commerceml",
    labelKey: "integrations.channel.commerceml",
    available: true,
    inbound: true,
    settingsSchema: commercemlSettings,
  },
  {
    type: "public_api",
    labelKey: "integrations.channel.publicApi",
    available: true,
    inbound: false,
    settingsSchema: emptySettings,
  },
  {
    type: "gis_mt_files",
    labelKey: "integrations.channel.gisMtFiles",
    available: false,
    inbound: false,
    settingsSchema: emptySettings,
  },
  {
    type: "chestny_znak",
    labelKey: "integrations.channel.chestnyZnak",
    available: false,
    inbound: true,
    settingsSchema: emptySettings,
  },
];

export function describeChannel(type: IntegrationChannelType): ChannelDescriptor {
  const found = CHANNELS.find((c) => c.type === type);
  if (!found) throw new Error(`unknown channel: ${type}`);
  return found;
}
```

- [ ] **Step 4: Запустить тест — проходит**

Run: `pnpm --filter @markiro/api exec vitest run channel-registry`
Expected: PASS (4 теста).

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/integrations/channel-registry.ts apps/api/test/channel-registry.test.ts
git commit -m "feat(api): channel registry as code, configuration as data"
```

---

### Task 3: Журнал

**Files:**

- Create: `apps/api/src/modules/integrations/journal.service.ts`
- Test: `apps/api/test/integration-journal.e2e.test.ts`

**Interfaces:**

- Consumes: таблицы из Task 1, `IntegrationChannelType` из Task 2.
- Produces: `JournalService` с `openSession`, `append`, `finishSession`, `prune`; константы `SESSION_RETENTION_DAYS = 90`, `ITEM_GRAIN_RETENTION_DAYS = 14`.

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/integration-journal.e2e.test.ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { loadEnv } from "../src/env";
import { JournalService } from "../src/modules/integrations/journal.service";

const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);
const journal = new JournalService(db);
const tenantId = `t-${randomUUID()}`;

describe("journal", () => {
  it("открывает сеанс, копит события и закрывает его исходом", async () => {
    const session = await journal.openSession(tenantId, "commerceml", {
      cookieHash: `h-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    await journal.append({
      tenantId,
      channelType: "commerceml",
      sessionId: session.id,
      direction: "in",
      outcome: "ok",
      grain: "session",
      message: "Каталог принят",
    });

    await journal.finishSession(session.id, "ok", { updated: 12, candidates: 3 });

    const [row] = await db
      .select()
      .from(schema.integrationSessions)
      .where(eq(schema.integrationSessions.id, session.id));
    expect(row!.outcome).toBe("ok");
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.summary).toEqual({ updated: 12, candidates: 3 });
  });

  it("двигает состояние канала при каждом событии — карточка знает, когда он дышал", async () => {
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId, type: "commerceml" })
      .onConflictDoNothing();

    await journal.append({
      tenantId,
      channelType: "commerceml",
      sessionId: null,
      direction: "local",
      outcome: "error",
      grain: "session",
      message: "Связь товара разорвана",
    });

    const [channel] = await db
      .select()
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "commerceml"),
        ),
      );
    expect(channel!.lastOutcome).toBe("error");
    expect(channel!.lastEventAt).not.toBeNull();
  });

  it("чистит построчную детализацию раньше сводок — она растёт быстрее", async () => {
    const old = new Date(Date.now() - 30 * 24 * 3_600_000);
    await db.insert(schema.integrationEvents).values([
      {
        tenantId,
        channelType: "commerceml",
        at: old,
        direction: "in",
        outcome: "warn",
        grain: "item",
        message: "Позиция в чужой валюте",
      },
      {
        tenantId,
        channelType: "commerceml",
        at: old,
        direction: "in",
        outcome: "ok",
        grain: "session",
        message: "Сеанс завершён",
      },
    ]);

    await journal.prune(new Date());

    const rows = await db
      .select({ grain: schema.integrationEvents.grain })
      .from(schema.integrationEvents)
      .where(eq(schema.integrationEvents.tenantId, tenantId));
    expect(rows.some((r) => r.grain === "item")).toBe(false);
    expect(rows.some((r) => r.grain === "session")).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run integration-journal`
Expected: FAIL — `JournalService` не резолвится.

- [ ] **Step 3: Написать сервис**

```ts
// apps/api/src/modules/integrations/journal.service.ts
import { Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq, lt } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import type { IntegrationChannelType } from "./channel-registry";

/** Сводка по сеансу переживает спор с бухгалтерией. */
export const SESSION_RETENTION_DAYS = 90;
/** Построчный разбор растёт кратно быстрее и живёт меньше (спека §7). */
export const ITEM_GRAIN_RETENTION_DAYS = 14;

export interface AppendEventInput {
  tenantId: string;
  channelType: IntegrationChannelType;
  sessionId: string | null;
  direction: "in" | "out" | "local";
  outcome: "ok" | "warn" | "error";
  grain: "session" | "item";
  message: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class JournalService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async openSession(
    tenantId: string,
    channelType: IntegrationChannelType,
    opts: { cookieHash: string; expiresAt: Date },
  ): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(schema.integrationSessions)
      .values({ tenantId, channelType, cookieHash: opts.cookieHash, expiresAt: opts.expiresAt })
      .returning({ id: schema.integrationSessions.id });
    return row!;
  }

  /**
   * Записывает событие и ДВИГАЕТ состояние канала тем же вызовом.
   *
   * Одним вызовом намеренно: карточка канала показывает «последнее событие N
   * назад», и если состояние обновлять отдельно, найдётся ветка, которая
   * событие запишет, а состояние забудет — карточка соврёт ровно тогда, когда
   * на неё смотрят из-за поломки.
   */
  async append(input: AppendEventInput): Promise<void> {
    const at = new Date();
    await this.db.insert(schema.integrationEvents).values({ ...input, at });
    await this.db
      .update(schema.integrationChannels)
      .set({ lastEventAt: at, lastOutcome: input.outcome })
      .where(
        and(
          eq(schema.integrationChannels.tenantId, input.tenantId),
          eq(schema.integrationChannels.type, input.channelType),
        ),
      );
  }

  async finishSession(
    sessionId: string,
    outcome: "ok" | "error",
    summary: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .update(schema.integrationSessions)
      .set({ finishedAt: new Date(), outcome, summary })
      .where(eq(schema.integrationSessions.id, sessionId));
  }

  /** Ретенция по зерну. Вызывается плановой джобой (Task 16). */
  async prune(now: Date): Promise<void> {
    const itemsBefore = new Date(now.getTime() - ITEM_GRAIN_RETENTION_DAYS * 24 * 3_600_000);
    const sessionsBefore = new Date(now.getTime() - SESSION_RETENTION_DAYS * 24 * 3_600_000);

    await this.db
      .delete(schema.integrationEvents)
      .where(
        and(
          eq(schema.integrationEvents.grain, "item"),
          lt(schema.integrationEvents.at, itemsBefore),
        ),
      );
    await this.db
      .delete(schema.integrationEvents)
      .where(lt(schema.integrationEvents.at, sessionsBefore));
  }
}
```

- [ ] **Step 4: Запустить тест — проходит**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run integration-journal`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/integrations/journal.service.ts apps/api/test/integration-journal.e2e.test.ts
git commit -m "feat(api): one journal for every integration channel"
```

---

### Task 4: Кабинетное API каналов и журнала

**Files:**

- Create: `apps/api/src/modules/integrations/dto.ts`, `apps/api/src/modules/integrations/integrations.service.ts`, `apps/api/src/modules/integrations/integrations.controller.ts`, `apps/api/src/modules/integrations/integrations.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/integrations.e2e.test.ts`

**Interfaces:**

- Consumes: `CHANNELS`/`describeChannel` (Task 2), `JournalService` (Task 3).
- Produces: `GET /integrations`, `GET /integrations/:type`, `PATCH /integrations/:type`, `GET /integrations/:type/journal`; типы `ChannelSummaryDto`, `ChannelDetailDto`, `JournalPageDto`.

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/integrations.e2e.test.ts
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/env";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

describe("integrations (cabinet)", () => {
  let app: INestApplication | undefined;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const env = loadEnv();
    const setup: AuthSetup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    agent = request.agent(app.getHttpServer());
    await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("показывает все каналы реестра, включая ещё не построенные", async () => {
    const res = await agent.get("/integrations").expect(200);
    const types = res.body.channels.map((c: { type: string }) => c.type);
    expect(types).toEqual(["commerceml", "public_api", "gis_mt_files", "chestny_znak"]);
    const chz = res.body.channels.find((c: { type: string }) => c.type === "chestny_znak");
    expect(chz.state).toBe("unavailable");
  });

  it("ненастроенный канал — это состояние, а не отсутствие записи", async () => {
    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.state).toBe("not_configured");
    expect(res.body.settings).toEqual({});
  });

  it("сохраняет настройки по схеме дескриптора и отвергает чужие", async () => {
    await agent.patch("/integrations/commerceml").send({ priceType: "Розничная" }).expect(200);
    const res = await agent.get("/integrations/commerceml").expect(200);
    expect(res.body.settings.priceType).toBe("Розничная");

    await agent.patch("/integrations/commerceml").send({ priceType: 42 }).expect(400);
  });

  it("отказывает в настройке недоступного канала", async () => {
    await agent.patch("/integrations/chestny_znak").send({}).expect(409);
  });

  it("отдаёт журнал сеансами, неуспешный — первым", async () => {
    const res = await agent.get("/integrations/commerceml/journal").expect(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it("не пускает ключ станции в кабинетный маршрут", async () => {
    await request(app!.getHttpServer())
      .get("/integrations")
      .set("x-api-key", `mk_${randomUUID()}`)
      .expect(401);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run integrations.e2e`
Expected: FAIL — 404 на `/integrations`.

- [ ] **Step 3: Написать DTO, сервис, контроллер и модуль**

```ts
// apps/api/src/modules/integrations/dto.ts
import { z } from "zod";
import type { IntegrationChannelType } from "./channel-registry";

export type ChannelState = "not_configured" | "working" | "error" | "silent" | "unavailable";

export interface ChannelSummaryDto {
  type: IntegrationChannelType;
  labelKey: string;
  state: ChannelState;
  lastEventAt: string | null;
}

export interface ChannelDetailDto extends ChannelSummaryDto {
  settings: Record<string, unknown>;
  silentAfterHours: number;
  /** Логин обмена; пароль не отдаётся никогда — он показан один раз при выпуске. */
  credentialLogin: string | null;
}

export interface JournalEventDto {
  at: string;
  direction: string;
  outcome: string;
  message: string;
  details: Record<string, unknown> | null;
}

export interface JournalSessionDto {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  summary: Record<string, unknown> | null;
  events: JournalEventDto[];
}

export interface JournalPageDto {
  sessions: JournalSessionDto[];
}

export const updateChannelSchema = z.record(z.unknown());
export type UpdateChannelDto = z.infer<typeof updateChannelSchema>;
```

```ts
// apps/api/src/modules/integrations/integrations.service.ts
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
import { CHANNELS, describeChannel, type IntegrationChannelType } from "./channel-registry";
import type { ChannelDetailDto, ChannelState, ChannelSummaryDto, JournalPageDto } from "./dto";

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
    const descriptor = describeChannel(type);
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
    const descriptor = describeChannel(type);
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

  async readJournal(tenantId: string, type: IntegrationChannelType): Promise<JournalPageDto> {
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
 */
function stateOf(
  available: boolean,
  row: typeof schema.integrationChannels.$inferSelect | undefined,
  now: Date,
): ChannelState {
  if (!available) return "unavailable";
  if (!row) return "not_configured";
  if (row.lastOutcome === "error") return "error";
  if (!row.lastEventAt) return "not_configured";
  const silentAfterMs = row.silentAfterHours * 3_600_000;
  if (now.getTime() - row.lastEventAt.getTime() > silentAfterMs) return "silent";
  return "working";
}
```

Контроллер повторяет форму `pickup-reasons.controller.ts` — те же гварды и пайп:

```ts
// apps/api/src/modules/integrations/integrations.controller.ts
import { Body, Controller, Get, Param, Patch, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import type { IntegrationChannelType } from "./channel-registry";
import type { ChannelDetailDto, ChannelSummaryDto, JournalPageDto } from "./dto";
import { IntegrationsService } from "./integrations.service";

// Кабинетный раздел: ключ станции или киоска сюда не доходит
// (docs/device-key-surface.md).
@ApiTags("integrations")
@Controller("integrations")
@UseGuards(TenantGuard, SessionOnlyGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  async list(@Req() req: RequestWithTenant): Promise<{ channels: ChannelSummaryDto[] }> {
    return this.integrations.listChannels(req.tenantId!, new Date());
  }

  @Get(":type")
  async detail(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
  ): Promise<ChannelDetailDto> {
    return this.integrations.getChannel(req.tenantId!, type, new Date());
  }

  @Patch(":type")
  async update(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
    @Body() body: Record<string, unknown>,
  ): Promise<ChannelDetailDto> {
    await this.integrations.updateChannel(req.tenantId!, type, body);
    return this.integrations.getChannel(req.tenantId!, type, new Date());
  }

  @Get(":type/journal")
  async journal(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
  ): Promise<JournalPageDto> {
    return this.integrations.readJournal(req.tenantId!, type);
  }
}
```

Модуль и регистрация в `app.module.ts` — по образцу `PickupReasonsModule`. Неизвестный тип канала в пути должен давать 404, а не 500: обернуть `describeChannel` в контроллере так, чтобы `Error` превращался в `NotFoundException`.

Настройки, не прошедшие схему, дают **400** (`BadRequestException`), а недоступный канал — **409**: первое про форму запроса, второе про состояние канала.

- [ ] **Step 4: Запустить тест — проходит**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run integrations.e2e`
Expected: PASS (6 тестов).

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/integrations apps/api/src/app.module.ts apps/api/test/integrations.e2e.test.ts
git commit -m "feat(api): cabinet endpoints for channels and their journal"
```

---

### Task 5: Учётные данные обмена и счётчик попыток

**Files:**

- Create: `apps/api/src/modules/exchange/exchange-credentials.ts`
- Modify: `apps/api/src/modules/integrations/integrations.controller.ts`, `apps/api/src/modules/integrations/integrations.service.ts`
- Test: `apps/api/test/exchange-credentials.e2e.test.ts`

**Interfaces:**

- Produces: `generateExchangeCredentials()`, `hashExchangeSecret(secret)`, `verifyExchangeSecret(secret, hash)`, `assertUnderCheckauthLimit(db, source, windowStart)`; константы `CHECKAUTH_BUDGET = 10`, `CHECKAUTH_WINDOW_MS = 15 * 60_000`; маршрут `POST /integrations/:type/credentials`.

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/exchange-credentials.e2e.test.ts
import { describe, expect, it } from "vitest";
import {
  generateExchangeCredentials,
  hashExchangeSecret,
  verifyExchangeSecret,
} from "../src/modules/exchange/exchange-credentials";

describe("exchange credentials", () => {
  it("выдаёт логин и секрет, и секрет не выводится из логина", () => {
    const a = generateExchangeCredentials();
    const b = generateExchangeCredentials();
    expect(a.login).not.toBe(b.login);
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret.length).toBeGreaterThanOrEqual(24);
  });

  it("хранит только хэш и узнаёт по нему правильный секрет", async () => {
    const { secret } = generateExchangeCredentials();
    const hash = await hashExchangeSecret(secret);
    expect(hash).not.toContain(secret);
    expect(await verifyExchangeSecret(secret, hash)).toBe(true);
    expect(await verifyExchangeSecret(`${secret}x`, hash)).toBe(false);
  });

  it("не падает на мусорном хэше, а отвечает отказом", async () => {
    expect(await verifyExchangeSecret("whatever", "not-a-phc-string")).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pnpm --filter @markiro/api exec vitest run exchange-credentials`
Expected: FAIL — модуль не резолвится.

- [ ] **Step 3: Реализовать**

```ts
// apps/api/src/modules/exchange/exchange-credentials.ts
import { randomBytes, randomUUID } from "node:crypto";
import { formatPhc, deriveDigestB64, parsePhc, PHC_ITERATIONS } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { UnauthorizedException } from "@nestjs/common";

/** Тот же бюджет и то же окно, что у привязки киоска: одна и та же угроза. */
export const CHECKAUTH_BUDGET = 10;
export const CHECKAUTH_WINDOW_MS = 15 * 60_000;

export interface ExchangeCredentials {
  login: string;
  /** Показывается один раз при выпуске; в базе только хэш. */
  secret: string;
}

export function generateExchangeCredentials(): ExchangeCredentials {
  return {
    login: `mk-1c-${randomUUID().slice(0, 8)}`,
    secret: randomBytes(24).toString("base64url"),
  };
}

export async function hashExchangeSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("base64");
  return formatPhc(PHC_ITERATIONS, salt, await deriveDigestB64(secret, salt, PHC_ITERATIONS));
}

export async function verifyExchangeSecret(secret: string, phc: string): Promise<boolean> {
  const parsed = parsePhc(phc);
  if (!parsed) return false;
  const digest = await deriveDigestB64(secret, parsed.saltB64, parsed.iterations);
  return digest === parsed.digestB64;
}

/**
 * Счётчик неудачных `checkauth`, атомарный апсерт — форма один в один с
 * `assertUnderPairRateLimit` в `pairing.service.ts`.
 *
 * Считаются ПОПЫТКИ, а не промахи по строке: неверный логин не совпадает ни с
 * одним каналом, поэтому счётчик, инкрементируемый только при найденной
 * строке, не сработал бы вообще — ровно эта ошибка уже была допущена в
 * привязке киоска и стоила трёх раундов правок.
 */
export async function assertUnderCheckauthLimit(
  db: Db,
  source: string,
  windowStart: Date,
): Promise<void> {
  const [row] = await db
    .insert(schema.exchangeAttempts)
    .values({ source, windowStartedAt: windowStart, failures: 1 })
    .onConflictDoUpdate({
      target: [schema.exchangeAttempts.source, schema.exchangeAttempts.windowStartedAt],
      set: { failures: sql`${schema.exchangeAttempts.failures} + 1` },
    })
    .returning({ failures: schema.exchangeAttempts.failures });

  if ((row?.failures ?? 0) > CHECKAUTH_BUDGET) {
    throw new UnauthorizedException();
  }
}

/** Успешный вход возвращает потраченную попытку — иначе рабочий обмен сам себя запрёт. */
export async function refundCheckauthAttempt(
  db: Db,
  source: string,
  windowStart: Date,
): Promise<void> {
  await db
    .update(schema.exchangeAttempts)
    .set({ failures: sql`greatest(${schema.exchangeAttempts.failures} - 1, 0)` })
    .where(
      and(
        eq(schema.exchangeAttempts.source, source),
        eq(schema.exchangeAttempts.windowStartedAt, windowStart),
      ),
    );
}
```

Добавить кабинетный маршрут `POST /integrations/:type/credentials`, который выпускает пару, пишет логин и хэш в `integration_channels` и **возвращает секрет ровно один раз**; повторный выпуск затирает прежний хэш. В `ChannelDetailDto` секрет не попадает никогда.

- [ ] **Step 4: Запустить тест — проходит**

Run: `pnpm --filter @markiro/api exec vitest run exchange-credentials`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/exchange/exchange-credentials.ts apps/api/src/modules/integrations apps/api/test/exchange-credentials.e2e.test.ts
git commit -m "feat(api): machine credentials for the 1C exchange, rate-limited"
```

---

### Task 6: Транспорт — checkauth, init, file

**Files:**

- Create: `apps/api/src/modules/exchange/exchange-session.service.ts`, `apps/api/src/modules/exchange/exchange.controller.ts`, `apps/api/src/modules/exchange/exchange.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/exchange-protocol.e2e.test.ts`

**Interfaces:**

- Consumes: Task 5 (учётные данные, лимит), Task 3 (журнал).
- Produces: `GET/POST /1c_exchange`; `ExchangeSessionService` с `open`, `resolve`, `appendChunk`, `assemble`, `sweepExpired`; константы `SESSION_TTL_MS = 3_600_000`, `FILE_CHUNK_LIMIT = 512 * 1024`.

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/exchange-protocol.e2e.test.ts
// (обвязка beforeAll/afterAll — как в integrations.e2e.test.ts: setupAuth,
// mountAuth, listenOnLoopback, signUpAndActivate; повторить дословно.)
import request from "supertest";
import { describe, expect, it } from "vitest";

describe("1c_exchange", () => {
  let login: string;
  let secret: string;

  it("выдаёт cookie на верные учётные данные", async () => {
    const issued = await agent.post("/integrations/commerceml/credentials").send({}).expect(201);
    login = issued.body.login;
    secret = issued.body.secret;

    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(login, secret)
      .expect(200);

    const lines = res.text.split("\n");
    expect(lines[0]).toBe("success");
    expect(lines[1]).toBeTruthy();
    expect(lines[2]).toBeTruthy();
  });

  it("отвечает failure на неверный пароль и не выдаёт cookie", async () => {
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=checkauth")
      .auth(login, "wrong")
      .expect(200);
    expect(res.text.startsWith("failure")).toBe(true);
  });

  it("сообщает параметры сеанса и отказывается от zip", async () => {
    const auth = await checkauth();
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=init")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(res.text).toContain("zip=no");
    expect(res.text).toMatch(/file_limit=\d+/);
  });

  it("принимает файл кусками и собирает их в исходный порядок", async () => {
    const auth = await checkauth();
    await request(app!.getHttpServer())
      .post("/1c_exchange?type=catalog&mode=file&filename=import.xml")
      .set("Cookie", auth.cookie)
      .send(Buffer.from("<?xml version=", "utf8"))
      .expect(200);
    const res = await request(app!.getHttpServer())
      .post("/1c_exchange?type=catalog&mode=file&filename=import.xml")
      .set("Cookie", auth.cookie)
      .send(Buffer.from('"1.0"?><КоммерческаяИнформация/>', "utf8"))
      .expect(200);
    expect(res.text).toBe("success");
  });

  it("не пускает без cookie сеанса", async () => {
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=init")
      .expect(200);
    expect(res.text.startsWith("failure")).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run exchange-protocol`
Expected: FAIL — 404 на `/1c_exchange`.

- [ ] **Step 3: Реализовать**

Ключевые требования к реализации, каждое обязательно:

**Ответы протокола — plain text, не JSON.** `checkauth` отдаёт три строки: `success`, имя cookie, значение cookie. Всё, что пошло не так, отдаётся как `failure\n<сообщение>` со статусом **200**: 1С разбирает тело, а не код, и 4xx она покажет пользователю как «ошибка сети», спрятав настоящую причину.

**Тенант выводится из логина**, не из пути и не из тела (спека §3). Логин уникален частичным индексом `integration_channels_login_uq`.

**Тело `mode=file` — сырые байты.** Глобальный `express.json()` их сломает: подключить `express.raw({ type: "*/*", limit: FILE_CHUNK_LIMIT })` только на этот маршрут.

**Сеанс живёт час** (`SESSION_TTL_MS`), `sweepExpired` удаляет просроченные сеансы вместе с их кусками — брошенный на середине обмен не должен оставлять мусор навсегда.

**`file_limit` объявляем сами** — `FILE_CHUNK_LIMIT = 512 * 1024`. Это же и потолок `express.raw`.

**Каждый шаг пишет событие** через `JournalService`: неверные учётные данные, неизвестный режим, превышенный кусок. Ни одна ветка не завершается молча.

- [ ] **Step 4: Запустить тест — проходит**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run exchange-protocol`
Expected: PASS (5 тестов).

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/exchange apps/api/src/app.module.ts apps/api/test/exchange-protocol.e2e.test.ts
git commit -m "feat(api): 1c_exchange transport — checkauth, init, chunked file"
```

---

### Task 7: Разбор CommerceML

**Files:**

- Create: `apps/api/src/modules/exchange/commerceml/parse.ts`
- Create: `apps/api/test/fixtures/commerceml/import-cp1251.xml`, `apps/api/test/fixtures/commerceml/offers.xml`
- Modify: `apps/api/package.json`
- Test: `apps/api/test/commerceml-parse.test.ts`

**Interfaces:**

- Produces: `parseCatalog(bytes: Buffer): ParsedCatalog`, `parseOffers(bytes: Buffer): ParsedOffers`; типы `ParsedItem { externalRef, name, article, unit }`, `ParsedOffer { externalRef, prices: { type: string; value: string; currency: string }[] }`.

- [ ] **Step 1: Добавить парсер XML**

Run: `pnpm --filter @markiro/api add fast-xml-parser`
Затем **вручную убрать `^`** из `apps/api/package.json` — `saveExact` в этом репозитории не действует (см. Global Constraints) — и переустановить.

- [ ] **Step 2: Написать падающий тест**

```ts
// apps/api/test/commerceml-parse.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCatalog, parseOffers } from "../src/modules/exchange/commerceml/parse";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/commerceml", name));

describe("commerceml parse", () => {
  it("читает windows-1251 — 1С выгружает в ней по умолчанию, и utf-8 превратил бы кириллицу в мусор", () => {
    const catalog = parseCatalog(fixture("import-cp1251.xml"));
    expect(catalog.items[0]!.name).toBe("Жигулёвское 0,5");
  });

  it("берёт Ид как внешний идентификатор, а не наименование", () => {
    const catalog = parseCatalog(fixture("import-cp1251.xml"));
    expect(catalog.items[0]!.externalRef).toBe("a1b2c3d4-0000-0000-0000-000000000001");
  });

  it("отдаёт все типы цен, а не первый попавшийся — выбор делает вызывающий", () => {
    const offers = parseOffers(fixture("offers.xml"));
    expect(offers.offers[0]!.prices).toEqual([
      { type: "Розничная", value: "89.90", currency: "руб" },
      { type: "Закупочная", value: "54.10", currency: "руб" },
    ]);
  });

  it("не падает на файле без товаров", () => {
    const empty = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><КоммерческаяИнформация/>',
      "utf8",
    );
    expect(parseCatalog(empty).items).toEqual([]);
    expect(parseOffers(empty).offers).toEqual([]);
  });

  it("сообщает о неразобранном XML, а не возвращает пустоту", () => {
    expect(() => parseCatalog(Buffer.from("<не xml", "utf8"))).toThrow(/CommerceML/);
  });
});
```

Фикстура `import-cp1251.xml` создаётся скриптом, чтобы байты действительно были в cp1251:

```bash
node -e '
const { writeFileSync } = require("node:fs");
const xml = `<?xml version="1.0" encoding="windows-1251"?>
<КоммерческаяИнформация ВерсияСхемы="2.05">
 <Каталог><Товары>
  <Товар>
   <Ид>a1b2c3d4-0000-0000-0000-000000000001</Ид>
   <Наименование>Жигулёвское 0,5</Наименование>
   <Артикул>ZHG-05</Артикул>
   <БазоваяЕдиница>шт</БазоваяЕдиница>
  </Товар>
 </Товары></Каталог>
</КоммерческаяИнформация>`;
// Node не кодирует В cp1251, только ИЗ неё — собираем побайтово.
const map = new Map();
const dec = new TextDecoder("windows-1251");
for (let b = 0; b < 256; b++) map.set(dec.decode(Buffer.from([b])), b);
writeFileSync("apps/api/test/fixtures/commerceml/import-cp1251.xml",
  Buffer.from([...xml].map((ch) => map.get(ch) ?? 0x3f)));
'
```

- [ ] **Step 3: Запустить, убедиться что падает**

Run: `pnpm --filter @markiro/api exec vitest run commerceml-parse`
Expected: FAIL — модуль не резолвится.

- [ ] **Step 4: Реализовать разбор**

Кодировку определять **по декларации XML**, а не угадывать: прочитать первые 200 байт как latin1, найти `encoding="..."`, декодировать всё через `new TextDecoder(encoding)`. Node 24 идёт с полным ICU, поэтому `windows-1251` поддерживается штатно и отдельная зависимость не нужна.

Неразобранный XML обязан бросать ошибку с текстом, содержащим `CommerceML` и позицию — этот текст уедет в журнал и его будет читать специалист по 1С.

- [ ] **Step 5: Запустить тест — проходит**

Run: `pnpm --filter @markiro/api exec vitest run commerceml-parse`
Expected: PASS (5 тестов).

- [ ] **Step 6: Коммит**

```bash
git add apps/api/src/modules/exchange/commerceml apps/api/test/commerceml-parse.test.ts apps/api/test/fixtures apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): CommerceML parser with windows-1251 support"
```

---

### Task 8: Применение цен и кандидаты

**Files:**

- Create: `apps/api/src/modules/exchange/commerceml/apply.ts`
- Test: `apps/api/test/commerceml-apply.test.ts`

**Interfaces:**

- Consumes: `ParsedItem`, `ParsedOffer` (Task 7).
- Produces: чистая `decideApplication(input): ApplicationPlan` с полями `priceUpdates: { productId, unitPrice }[]`, `candidates: ParsedItem[]`, `skipped: { externalRef, reason }[]`.

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/commerceml-apply.test.ts
import { describe, expect, it } from "vitest";
import { decideApplication } from "../src/modules/exchange/commerceml/apply";

const known = [{ id: "p-1", externalRef: "guid-1" }];

describe("decideApplication", () => {
  it("применяет цену сопоставленному товару", () => {
    const plan = decideApplication({
      known,
      items: [{ externalRef: "guid-1", name: "Жигулёвское", article: null, unit: "шт" }],
      offers: [
        { externalRef: "guid-1", prices: [{ type: "Розничная", value: "89.90", currency: "руб" }] },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([{ productId: "p-1", unitPrice: "89.90" }]);
    expect(plan.candidates).toEqual([]);
  });

  it("несопоставленное уходит в кандидаты, а не создаёт товар", () => {
    const plan = decideApplication({
      known,
      items: [{ externalRef: "guid-9", name: "Новинка", article: "N-1", unit: "шт" }],
      offers: [],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.candidates.map((c) => c.externalRef)).toEqual(["guid-9"]);
  });

  it("при нескольких типах цен и ненастроенном выборе НЕ применяет ничего", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        {
          externalRef: "guid-1",
          prices: [
            { type: "Розничная", value: "89.90", currency: "руб" },
            { type: "Закупочная", value: "54.10", currency: "руб" },
          ],
        },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.skipped).toEqual([{ externalRef: "guid-1", reason: "ambiguous_price_type" }]);
  });

  it("настроенный тип цены выбирает свою из нескольких", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        {
          externalRef: "guid-1",
          prices: [
            { type: "Розничная", value: "89.90", currency: "руб" },
            { type: "Закупочная", value: "54.10", currency: "руб" },
          ],
        },
      ],
      configuredPriceType: "Закупочная",
    });
    expect(plan.priceUpdates).toEqual([{ productId: "p-1", unitPrice: "54.10" }]);
  });

  it("не применяет цену в чужой валюте", () => {
    const plan = decideApplication({
      known,
      items: [],
      offers: [
        { externalRef: "guid-1", prices: [{ type: "Розничная", value: "1.20", currency: "USD" }] },
      ],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
    expect(plan.skipped).toEqual([{ externalRef: "guid-1", reason: "foreign_currency" }]);
  });

  it("отсутствие цены не обнуляет прежнюю", () => {
    const plan = decideApplication({
      known,
      items: [{ externalRef: "guid-1", name: "Жигулёвское", article: null, unit: "шт" }],
      offers: [],
      configuredPriceType: undefined,
    });
    expect(plan.priceUpdates).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pnpm --filter @markiro/api exec vitest run commerceml-apply`
Expected: FAIL — модуль не резолвится.

- [ ] **Step 3: Реализовать**

Функция чистая: никакого доступа к базе, только вход и решение. Правило неоднозначной цены — из спеки §4.3: один тип берём, несколько без настройки не берём вовсе, потому что угадывание однажды проставит киоску закупочную.

- [ ] **Step 4: Запустить тест — проходит**

Run: `pnpm --filter @markiro/api exec vitest run commerceml-apply`
Expected: PASS (6 тестов).

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/exchange/commerceml/apply.ts apps/api/test/commerceml-apply.test.ts
git commit -m "feat(api): decide what an exchange applies and what becomes a candidate"
```

---

### Task 9: Транспорт — import пошагово

**Files:**

- Modify: `apps/api/src/modules/exchange/exchange.controller.ts`, `apps/api/src/modules/exchange/exchange-session.service.ts`
- Test: `apps/api/test/exchange-import.e2e.test.ts`

**Interfaces:**

- Consumes: Task 6 (сеанс, куски), Task 7 (разбор), Task 8 (решение).
- Produces: `mode=import`, отвечающий `progress` или `success`; запись цен и кандидатов; сводка сеанса.

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/exchange-import.e2e.test.ts
// Обвязка — как в exchange-protocol.e2e.test.ts.
describe("mode=import", () => {
  it("применяет цены сопоставленным товарам и отвечает success", async () => {
    // товар с external_ref = guid-1 создан в beforeAll
    const auth = await checkauth();
    await uploadFile(auth, "offers.xml", offersXmlFor("guid-1", "77.50"));
    const res = await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=offers.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    expect(res.text.trim()).toBe("success");

    const [product] = await db
      .select({ unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product!.unitPrice).toBe("77.50");
  });

  it("незнакомую номенклатуру кладёт в кандидаты, а каталог не трогает", async () => {
    const auth = await checkauth();
    await uploadFile(auth, "import.xml", catalogXmlFor("guid-new", "Новинка"));
    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=import.xml")
      .set("Cookie", auth.cookie)
      .expect(200);

    const rows = await db
      .select()
      .from(schema.integrationCandidates)
      .where(eq(schema.integrationCandidates.externalRef, "guid-new"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Новинка");
  });

  it("повторный import не размножает кандидатов", async () => {
    const auth = await checkauth();
    await uploadFile(auth, "import.xml", catalogXmlFor("guid-new", "Новинка"));
    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=import.xml")
      .set("Cookie", auth.cookie)
      .expect(200);

    const rows = await db
      .select()
      .from(schema.integrationCandidates)
      .where(eq(schema.integrationCandidates.externalRef, "guid-new"));
    expect(rows).toHaveLength(1);
  });

  it("обмен не меняет ни имя, ни GTIN сопоставленного товара", async () => {
    const before = await db
      .select({ name: schema.products.name, gtin14: schema.products.gtin14 })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    const auth = await checkauth();
    await uploadFile(auth, "import.xml", catalogXmlFor("guid-1", "ДРУГОЕ ИМЯ"));
    await request(app!.getHttpServer())
      .get("/1c_exchange?type=catalog&mode=import&filename=import.xml")
      .set("Cookie", auth.cookie)
      .expect(200);
    const after = await db
      .select({ name: schema.products.name, gtin14: schema.products.gtin14 })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(after).toEqual(before);
  });

  it("пишет сводку сеанса в журнал", async () => {
    const res = await agent.get("/integrations/commerceml/journal").expect(200);
    const finished = res.body.sessions.find((s: { outcome: string | null }) => s.outcome === "ok");
    expect(finished.summary).toMatchObject({ updated: expect.any(Number) });
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run exchange-import`
Expected: FAIL — `mode=import` не реализован.

- [ ] **Step 3: Реализовать**

Собрать куски по `chunk`, декодировать и разобрать (Task 7), решить (Task 8), применить в базе. Кандидаты писать апсертом по `(tenantId, channelType, externalRef)` с обновлением `lastSeenAt` — повтор не размножает очередь.

Большой каталог обрабатывать партиями и отвечать `progress`, пока остались непрошедшие позиции; 1С придёт снова с тем же `filename`. Прогресс держать в сеансе.

Правило «только цена» реализовать буквально: запрос обновления касается **исключительно** `products.unit_price`. Тест выше это проверяет.

- [ ] **Step 4: Запустить тест — проходит**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run exchange-import`
Expected: PASS (5 тестов).

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/exchange apps/api/test/exchange-import.e2e.test.ts
git commit -m "feat(api): apply an exchange batch by batch, prices only"
```

---

### Task 10: Кабинетное API кандидатов

**Files:**

- Modify: `apps/api/src/modules/integrations/integrations.service.ts`, `apps/api/src/modules/integrations/integrations.controller.ts`, `apps/api/src/modules/integrations/dto.ts`
- Test: `apps/api/test/integration-candidates.e2e.test.ts`

**Interfaces:**

- Produces: `GET /integrations/:type/candidates?hidden=`, `POST /integrations/:type/candidates/:id/link` (тело `{ productId }`), `POST /integrations/:type/candidates/:id/hide`, `POST /integrations/:type/candidates/:id/unhide`, `DELETE /products/:id/external-link`; поле `suggestedProductId` в `CandidateDto`.

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/integration-candidates.e2e.test.ts
describe("candidates", () => {
  it("подсказывает совпадение по наименованию — иначе первый обмен это сотни ручных сопоставлений", async () => {
    const res = await agent.get("/integrations/commerceml/candidates").expect(200);
    const candidate = res.body.candidates.find(
      (c: { name: string }) => c.name === "Жигулёвское 0,5",
    );
    expect(candidate.suggestedProductId).toBe(productId);
  });

  it("связывание проставляет external_ref и убирает позицию из очереди", async () => {
    await agent
      .post(`/integrations/commerceml/candidates/${candidateId}/link`)
      .send({ productId })
      .expect(200);

    const [product] = await db
      .select({ externalRef: schema.products.externalRef })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product!.externalRef).toBe("guid-new");

    const res = await agent.get("/integrations/commerceml/candidates").expect(200);
    expect(res.body.candidates.map((c: { id: string }) => c.id)).not.toContain(candidateId);
  });

  it("не даёт связать двух кандидатов с одним товаром", async () => {
    await agent
      .post(`/integrations/commerceml/candidates/${otherCandidateId}/link`)
      .send({ productId })
      .expect(409);
  });

  it("скрытое не всплывает в обычном списке, но доступно под фильтром", async () => {
    await agent.post(`/integrations/commerceml/candidates/${hiddenId}/hide`).expect(200);
    const plain = await agent.get("/integrations/commerceml/candidates").expect(200);
    expect(plain.body.candidates.map((c: { id: string }) => c.id)).not.toContain(hiddenId);
    const withHidden = await agent
      .get("/integrations/commerceml/candidates?hidden=true")
      .expect(200);
    expect(withHidden.body.candidates.map((c: { id: string }) => c.id)).toContain(hiddenId);
  });

  it("разрыв связи оставляет цену и пишет событие", async () => {
    await agent.delete(`/products/${productId}/external-link`).expect(200);
    const [product] = await db
      .select({ externalRef: schema.products.externalRef, unitPrice: schema.products.unitPrice })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product!.externalRef).toBeNull();
    expect(product!.unitPrice).not.toBeNull();

    const journal = await agent.get("/integrations/commerceml/journal").expect(200);
    const messages = journal.body.sessions.flatMap((s: { events: { message: string }[] }) =>
      s.events.map((e) => e.message),
    );
    expect(messages.join(" ")).toMatch(/связь/i);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run integration-candidates`
Expected: FAIL — 404 на `/integrations/commerceml/candidates`.

- [ ] **Step 3: Реализовать**

Подсказка совпадения — нормализованное сравнение наименования и артикула; вернуть `suggestedProductId` только при однозначном совпадении, иначе `null`. Двусмысленная подсказка хуже отсутствующей: её примут не глядя.

Связывание проверяет, что у товара ещё нет `external_ref`, иначе **409**: молча перезаписать связь значит увести цены другого товара.

Разрыв связи чистит `external_ref`, **не трогает цену** и пишет событие журнала с `grain: "session"`, `direction: "local"` — вопрос «почему товар перестал получать цены» задают через недели, и построчная ретенция его не переживёт.

- [ ] **Step 4: Запустить тест — проходит**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run integration-candidates`
Expected: PASS (5 тестов).

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/integrations apps/api/test/integration-candidates.e2e.test.ts
git commit -m "feat(api): candidates queue with linking, hiding and unlinking"
```

---

### Task 11: Ключи публичного API

**Files:**

- Modify: `packages/db/src/auth-config.ts`
- Create: `apps/api/src/modules/api-keys/api-keys.controller.ts`, `apps/api/src/modules/api-keys/api-keys.service.ts`, `apps/api/src/modules/api-keys/api-keys.module.ts`
- Test: `apps/api/test/api-keys.e2e.test.ts`

**Interfaces:**

- Produces: `GET /integrations/public_api/keys`, `POST /integrations/public_api/keys` (тело `{ name }`), `DELETE /integrations/public_api/keys/:id`; конфиг `configId: "public"` у плагина apiKey.

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/api-keys.e2e.test.ts
describe("public api keys", () => {
  it("показывает секрет ровно один раз при выпуске", async () => {
    const created = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "Интеграция склада" })
      .expect(201);
    expect(created.body.key).toMatch(/^mk_/);

    const list = await agent.get("/integrations/public_api/keys").expect(200);
    const found = list.body.keys.find((k: { id: string }) => k.id === created.body.id);
    expect(found).toBeDefined();
    expect(found.key).toBeUndefined();
  });

  it("отзыв убирает ключ из списка и пишет событие", async () => {
    const created = await agent
      .post("/integrations/public_api/keys")
      .send({ name: "X" })
      .expect(201);
    await agent.delete(`/integrations/public_api/keys/${created.body.id}`).expect(200);

    const list = await agent.get("/integrations/public_api/keys").expect(200);
    expect(list.body.keys.map((k: { id: string }) => k.id)).not.toContain(created.body.id);

    const journal = await agent.get("/integrations/public_api/journal").expect(200);
    expect(JSON.stringify(journal.body)).toMatch(/отозв/i);
  });

  it("не показывает ключи чужой организации", async () => {
    const stranger = request.agent(app!.getHttpServer());
    await signUpAndActivate(stranger);
    const list = await stranger.get("/integrations/public_api/keys").expect(200);
    expect(list.body.keys).toEqual([]);
  });

  it("ключ станции не виден среди публичных", async () => {
    const list = await agent.get("/integrations/public_api/keys").expect(200);
    expect(list.body.keys.every((k: { kind: string }) => k.kind === "public")).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run api-keys.e2e`
Expected: FAIL — 404 на `/integrations/public_api/keys`.

- [ ] **Step 3: Реализовать**

Добавить в `packages/db/src/auth-config.ts` второй конфиг плагина рядом со `station`:

```ts
{
  configId: "public",
  defaultPrefix: "mk_",
  references: "organization",
  enableMetadata: true,
  // Публичный ключ не обслуживает сканирующую линию, поэтому потолок
  // станции (600/мин) здесь не нужен; оставляем плагинный дефолт, а жёстким
  // выключателем остаётся отзыв.
  rateLimit: { enabled: true, maxRequests: 60, timeWindow: 1000 * 60 },
},
```

Ключи помечать `metadata: { kind: "public" }` и **фильтровать список по этому признаку**: станционные ключи живут в той же таблице и в публичном списке им не место — иначе администратор отзовёт станцию, думая, что отзывает интеграцию.

Выпуск и отзыв писать в журнал канала `public_api`.

- [ ] **Step 4: Запустить тест — проходит**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run api-keys.e2e`
Expected: PASS (4 теста).

- [ ] **Step 5: Коммит**

```bash
git add packages/db/src/auth-config.ts apps/api/src/modules/api-keys apps/api/test/api-keys.e2e.test.ts
git commit -m "feat(api): public API keys as an integration channel"
```

---

### Task 12: Админка — секция и карточки каналов

**Files:**

- Create: `apps/admin/src/pages/integrations/api.ts`, `apps/admin/src/pages/integrations/index.tsx`
- Modify: `apps/admin/src/App.tsx`, `apps/admin/src/layout/AppShell.tsx`, `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/integrations.test.tsx`

**Interfaces:**

- Consumes: `GET /integrations` (Task 4).
- Produces: маршрут `/integrations`, хук `useChannels()`, компонент `IntegrationsPage`.

- [ ] **Step 1: Написать падающий тест**

```tsx
// apps/admin/test/integrations.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsPage } from "../src/pages/integrations/index.js";

// Общего рендер-хелпера в этом репозитории НЕТ: каждый админ-тест объявляет
// свой `renderPage` и глушит `fetch` — см. `apps/admin/test/counterparties.test.tsx`
// строки 15-30. Повторить тот же приём здесь, а не заводить `test/support/`.
function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntegrationsPage />
    </QueryClientProvider>,
  );
}

/** Глушит `GET /integrations` ответом с переданными каналами. */
function stubChannels(channels: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ channels }),
    })),
  );
}

describe("IntegrationsPage", () => {
  it("рисует недоступный канал как все остальные, а не прячет его", async () => {
    stubChannels([
      {
        type: "commerceml",
        labelKey: "integrations.channel.commerceml",
        state: "working",
        lastEventAt: new Date().toISOString(),
      },
      {
        type: "chestny_znak",
        labelKey: "integrations.channel.chestnyZnak",
        state: "unavailable",
        lastEventAt: null,
      },
    ]);
    renderPage();
    expect(await screen.findByText("Обмен с 1С")).toBeDefined();
    expect(screen.getByText("Честный ЗНАК")).toBeDefined();
    expect(screen.getByText("Недоступно")).toBeDefined();
  });

  it("показывает, когда канал последний раз дышал", async () => {
    stubChannels([
      {
        type: "commerceml",
        labelKey: "integrations.channel.commerceml",
        state: "working",
        lastEventAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      },
    ]);
    renderPage();
    expect(await screen.findByText(/2 ч назад/)).toBeDefined();
  });

  it("молчащий канал отличается от работающего", async () => {
    stubChannels([
      {
        type: "commerceml",
        labelKey: "integrations.channel.commerceml",
        state: "silent",
        lastEventAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
      },
    ]);
    renderPage();
    expect(await screen.findByText(/нет обмена/i)).toBeDefined();
  });

  it("показывает пустое состояние, когда ничего не настроено", async () => {
    stubChannels([
      {
        type: "commerceml",
        labelKey: "integrations.channel.commerceml",
        state: "not_configured",
        lastEventAt: null,
      },
    ]);
    renderPage();
    expect(await screen.findByText(/не настроен/i)).toBeDefined();
  });
});
```

Хелпер `stubChannels` мокает `apiFetch` — повторить приём из `apps/admin/test/kiosks-pairing-placeholder.test.tsx`.

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pnpm --filter @markiro/admin exec vitest run integrations`
Expected: FAIL — модуль страницы не резолвится.

- [ ] **Step 3: Реализовать**

Карточки рисуются одинаково независимо от вида канала — эта одинаковость и есть то, что позволяет секции расти (бриф 08). Пункт навигации добавить в `NAV_ITEMS` в `AppShell.tsx` между `kiosks` и `labels`, маршрут — в `App.tsx`.

Ключи i18n добавить **в оба файла**: `nav.integrations`, `integrations.channel.*`, `integrations.state.*`, `integrations.lastEvent`.

- [ ] **Step 4: Запустить тест — проходит**

Run: `pnpm --filter @markiro/admin exec vitest run integrations`
Expected: PASS (4 теста).

- [ ] **Step 5: Коммит**

```bash
git add apps/admin/src/pages/integrations apps/admin/src/App.tsx apps/admin/src/layout/AppShell.tsx apps/admin/src/i18n apps/admin/test/integrations.test.tsx
git commit -m "feat(admin): integrations section with uniform channel cards"
```

---

### Task 13: Админка — страница канала

**Files:**

- Create: `apps/admin/src/pages/integrations/ChannelPage.tsx`, `apps/admin/src/pages/integrations/JournalList.tsx`
- Modify: `apps/admin/src/App.tsx`, `apps/admin/src/pages/integrations/api.ts`, i18n
- Test: `apps/admin/test/integrations-channel.test.tsx`

**Interfaces:**

- Consumes: `GET/PATCH /integrations/:type`, `GET /integrations/:type/journal`, `POST /integrations/:type/credentials`.
- Produces: маршрут `/integrations/:type`.

- [ ] **Step 1: Написать падающий тест**

```tsx
// apps/admin/test/integrations-channel.test.tsx
describe("ChannelPage", () => {
  it("показывает секрет обмена один раз и больше никогда", async () => {
    renderChannel("commerceml");
    await userEvent.click(await screen.findByRole("button", { name: /выпустить/i }));
    expect(await screen.findByText(/mk-1c-/)).toBeDefined();
    expect(screen.getByText(/больше он показан не будет/i)).toBeDefined();
  });

  it("поднимает неуспешный сеанс наверх журнала", async () => {
    stubJournal([
      { id: "s2", startedAt: iso(-1), finishedAt: iso(-1), outcome: "ok", summary: {}, events: [] },
      {
        id: "s1",
        startedAt: iso(-2),
        finishedAt: iso(-2),
        outcome: "error",
        summary: {},
        events: [],
      },
    ]);
    renderChannel("commerceml");
    const sessions = await screen.findAllByTestId("journal-session");
    expect(sessions[0]).toHaveAttribute("data-outcome", "error");
  });

  it("показывает ответ протокола дословно — его читает специалист по 1С", async () => {
    stubJournal([
      {
        id: "s1",
        startedAt: iso(-1),
        finishedAt: iso(-1),
        outcome: "error",
        summary: {},
        events: [
          {
            at: iso(-1),
            direction: "in",
            outcome: "error",
            message: "Файл не разобран",
            details: { raw: "failure\nCommerceML: unexpected token at 12" },
          },
        ],
      },
    ]);
    renderChannel("commerceml");
    await userEvent.click(await screen.findByTestId("journal-session"));
    expect(await screen.findByText(/unexpected token at 12/)).toBeDefined();
  });

  it("сохраняет тип цены", async () => {
    renderChannel("commerceml");
    await userEvent.type(await screen.findByLabelText(/тип цены/i), "Розничная");
    await userEvent.click(screen.getByRole("button", { name: /сохранить/i }));
    expect(patchSpy).toHaveBeenCalledWith(
      "/integrations/commerceml",
      expect.objectContaining({ priceType: "Розничная" }),
    );
  });
});
```

`renderChannel(type)`, `stubJournal(sessions)` и `patchSpy` — локальные хелперы этого файла, их надо написать самому по образцу `apps/admin/test/counterparties.test.tsx` (строки 15-30): свой `QueryClient` с выключенными ретраями, `render` в `QueryClientProvider`, `vi.stubGlobal("fetch", ...)` с разбором пути и метода. Общего `test/support/` в репозитории нет и заводить его не надо.

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pnpm --filter @markiro/admin exec vitest run integrations-channel`
Expected: FAIL — компонент не резолвится.

- [ ] **Step 3: Реализовать**

Три области по брифу: шапка, настройки, журнал. Детали события — моноширинный блок, свёрнутый по умолчанию. Секрет обмена показывается ровно один раз с явным предупреждением.

- [ ] **Step 4: Запустить тест — проходит**

Run: `pnpm --filter @markiro/admin exec vitest run integrations-channel`
Expected: PASS (4 теста).

- [ ] **Step 5: Коммит**

```bash
git add apps/admin/src/pages/integrations apps/admin/src/App.tsx apps/admin/src/i18n apps/admin/test/integrations-channel.test.tsx
git commit -m "feat(admin): channel page with settings and journal"
```

---

### Task 14: Админка — очередь кандидатов и каталог

**Files:**

- Create: `apps/admin/src/pages/integrations/CandidatesQueue.tsx`
- Modify: `apps/admin/src/pages/catalog/index.tsx`, `apps/admin/src/pages/integrations/api.ts`, i18n
- Test: `apps/admin/test/integrations-candidates.test.tsx`

**Interfaces:**

- Consumes: маршруты кандидатов (Task 10).
- Produces: компонент `CandidatesQueue`, плашка в каталоге, разрыв связи в карточке товара.

- [ ] **Step 1: Написать падающий тест**

```tsx
// apps/admin/test/integrations-candidates.test.tsx
describe("CandidatesQueue", () => {
  it("предлагает три действия, а не только создание", async () => {
    stubCandidates([
      {
        id: "c1",
        externalRef: "guid-9",
        name: "Новинка",
        article: "N-1",
        suggestedProductId: null,
      },
    ]);
    renderQueue();
    expect(await screen.findByRole("button", { name: /связать/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /создать/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /скрыть/i })).toBeDefined();
  });

  it("даёт подтвердить подсказки пачкой — первый обмен приносит весь каталог", async () => {
    stubCandidates([
      {
        id: "c1",
        externalRef: "g1",
        name: "Жигулёвское 0,5",
        article: null,
        suggestedProductId: "p-1",
      },
      { id: "c2", externalRef: "g2", name: "Вода 1,0", article: null, suggestedProductId: "p-2" },
    ]);
    renderQueue();
    await userEvent.click(
      await screen.findByRole("button", { name: /подтвердить все подсказки/i }),
    );
    expect(linkSpy).toHaveBeenCalledTimes(2);
  });

  it("скрытые доступны под фильтром", async () => {
    renderQueue();
    await userEvent.click(await screen.findByRole("checkbox", { name: /показать скрытые/i }));
    expect(listSpy).toHaveBeenLastCalledWith(expect.stringContaining("hidden=true"));
  });

  it("каталог зовёт в очередь, когда там что-то есть", async () => {
    stubCandidateCount(3);
    renderCatalog();
    expect(await screen.findByText(/в обмене появились новые товары/i)).toBeDefined();
  });

  it("карточка товара показывает связь и даёт её разорвать", async () => {
    renderProductCard({ externalRef: "guid-1", externalName: "Жигулёвское 0,5" });
    await userEvent.click(await screen.findByRole("button", { name: /разорвать связь/i }));
    expect(unlinkSpy).toHaveBeenCalledWith("p-1");
  });
});
```

`renderQueue`, `renderCatalog`, `renderProductCard`, `stubCandidates`, `stubCandidateCount`, `linkSpy`, `listSpy`, `unlinkSpy` — локальные хелперы этого файла, писать по образцу `apps/admin/test/counterparties.test.tsx` (строки 15-30). Общего `test/support/` в репозитории нет.

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pnpm --filter @markiro/admin exec vitest run integrations-candidates`
Expected: FAIL — компонент не резолвится.

- [ ] **Step 3: Реализовать**

Групповое подтверждение подсказок обязательно: без него первый обмен превращается в сотни ручных операций (бриф 08). Плашка в каталоге ненавязчивая и ведёт в очередь; сама очередь живёт рядом с журналом, который объясняет, откуда позиции взялись.

- [ ] **Step 4: Запустить тест — проходит**

Run: `pnpm --filter @markiro/admin exec vitest run integrations-candidates`
Expected: PASS (5 тестов).

- [ ] **Step 5: Коммит**

```bash
git add apps/admin/src/pages/integrations apps/admin/src/pages/catalog apps/admin/src/i18n apps/admin/test/integrations-candidates.test.tsx
git commit -m "feat(admin): candidates queue, catalogue plaque and unlink"
```

---

### Task 15: Админка — панель ключей API

**Files:**

- Create: `apps/admin/src/pages/integrations/ApiKeysPanel.tsx`
- Modify: `apps/admin/src/pages/integrations/ChannelPage.tsx`, `apps/admin/src/pages/integrations/api.ts`, i18n
- Test: `apps/admin/test/integrations-api-keys.test.tsx`

**Interfaces:**

- Consumes: маршруты ключей (Task 11).
- Produces: `ApiKeysPanel`, встраиваемая в `ChannelPage` для канала `public_api`.

- [ ] **Step 1: Написать падающий тест**

```tsx
// apps/admin/test/integrations-api-keys.test.tsx
describe("ApiKeysPanel", () => {
  it("показывает выпущенный ключ один раз и предупреждает об этом", async () => {
    renderPanel();
    await userEvent.type(await screen.findByLabelText(/название/i), "Склад");
    await userEvent.click(screen.getByRole("button", { name: /выпустить/i }));
    expect(await screen.findByText(/mk_/)).toBeDefined();
    expect(screen.getByText(/больше он показан не будет/i)).toBeDefined();
  });

  it("отзыв требует подтверждения — ключ живой и его отзыв необратим", async () => {
    stubKeys([{ id: "k1", name: "Склад", createdAt: iso(-1) }]);
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: /отозвать/i }));
    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it("пустое состояние объясняет, зачем ключ нужен", async () => {
    stubKeys([]);
    renderPanel();
    expect(await screen.findByText(/ключей пока нет/i)).toBeDefined();
  });
});
```

`renderPanel`, `stubKeys`, `revokeSpy`, `iso(hoursAgo)` — локальные хелперы этого файла, писать по образцу `apps/admin/test/counterparties.test.tsx` (строки 15-30). Общего `test/support/` в репозитории нет.

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `pnpm --filter @markiro/admin exec vitest run integrations-api-keys`
Expected: FAIL — компонент не резолвится.

- [ ] **Step 3: Реализовать**

Отзыв — необратимое действие, поэтому идёт через подтверждение по паттерну `Modal` из `@markiro/ui`, как и прочие деструктивные операции в кабинете.

- [ ] **Step 4: Запустить тест — проходит**

Run: `pnpm --filter @markiro/admin exec vitest run integrations-api-keys`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
git add apps/admin/src/pages/integrations apps/admin/src/i18n apps/admin/test/integrations-api-keys.test.tsx
git commit -m "feat(admin): public API keys panel"
```

---

### Task 16: Уборка, документы и полный гейт

**Files:**

- Modify: `apps/api/src/jobs/jobs.module.ts`, `docs/design-briefs/03-admin-panel.md`, `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`, `docs/architecture.md`
- Test: `apps/api/test/integration-retention.e2e.test.ts`

**Interfaces:**

- Consumes: `JournalService.prune` (Task 3), `ExchangeSessionService.sweepExpired` (Task 6).

- [ ] **Step 1: Написать падающий тест**

```ts
// apps/api/test/integration-retention.e2e.test.ts
describe("retention job", () => {
  it("подметает просроченные сеансы вместе с их кусками — брошенный обмен не оставляет мусора", async () => {
    const stale = await journal.openSession(tenantId, "commerceml", {
      cookieHash: `h-${randomUUID()}`,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await db.insert(schema.exchangeUploads).values({
      tenantId,
      sessionId: stale.id,
      filename: "import.xml",
      chunk: 0,
      body: Buffer.from("x"),
    });

    await sessions.sweepExpired(new Date());

    const left = await db
      .select()
      .from(schema.exchangeUploads)
      .where(eq(schema.exchangeUploads.sessionId, stale.id));
    expect(left).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run integration-retention`
Expected: FAIL — куски остались.

- [ ] **Step 3: Подключить джобу**

Зарегистрировать в `JobsModule` рядом с существующей уборкой `kiosk_pair_attempts`: раз в час `sweepExpired`, раз в сутки `prune`.

- [ ] **Step 4: Запустить тест — проходит**

Run: `set -a; . ./.env; set +a; pnpm --filter @markiro/api exec vitest run integration-retention`
Expected: PASS.

- [ ] **Step 5: Поправить документы**

- `docs/design-briefs/03-admin-panel.md`: строка про «API keys for external integrations» в разделе Settings — заменить указанием, что ключи живут в «Интеграциях» (бриф 08).
- `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`: у плана 07 отметить, что адаптеры файловых выгрузок остаются там, а их интерфейс — в «Интеграциях»; добавить строки И-1 и И-2 в таблицу.
- `docs/architecture.md` §5: добавить обмен с 1С в перечень адаптеров формата.

- [ ] **Step 6: Полный гейт**

```bash
set -a; . ./.env; set +a
pnpm turbo lint typecheck test build --concurrency=1
pnpm format:check
```

Оба чистые. Проверить счётчик skipped в API-наборе: он обязан быть нулевым, иначе e2e прошли вхолостую.

- [ ] **Step 7: Коммит**

```bash
git add apps/api/src/jobs docs apps/api/test/integration-retention.e2e.test.ts
git commit -m "chore(integrations): retention job and documentation catch-up"
```

---

## Приёмка на живой 1С

Не закрывается тестами и уезжает в чек-лист по образцу `docs/hardware-acceptance-checklist.md`:

- Настроить в типовой 1С обмен с сайтом на выданный адрес и учётные данные, выполнить обмен, убедиться что цены доехали.
- Проверить, что выгрузка в windows-1251 разбирается (типовая настройка) и что каталог с несколькими типами цен требует выбора в настройках канала.
- Зафиксировать, как в конфигурации клиента называется реквизит статуса заказа и каков словарь его значений — это вход для И-2.

## Self-Review

**Покрытие спеки.** §3 транспорт — задачи 5, 6, 9; §4 входящий поток и кандидаты — 7, 8, 9, 10, 14; §7 наблюдаемость — 3, 4, 13, 16; §9 состав И-1 — все задачи; ключи API — 11, 15; анатомия канала из брифа — 2, 4, 12, 13. §5 и §6 (исходящий поток и статусы) сознательно не покрыты: это И-2.

**Заглушки.** Не осталось: каждый шаг несёт код теста и требования к реализации. Два места намеренно описаны требованиями, а не листингом, — реализация `mode=file`/`mode=import` и разбор XML: там объём кода превышает пользу от дословного листинга, но все инварианты (текстовые ответы со статусом 200, сырое тело, потолок куска, только цена, апсерт кандидатов) перечислены поимённо и проверяются тестами шага 1.

**Согласованность типов.** `IntegrationChannelType` из Task 2 используется в задачах 3, 4, 10; `ParsedItem`/`ParsedOffer` из Task 7 — вход `decideApplication` в Task 8; `CandidateDto.suggestedProductId` из Task 10 — вход `CandidatesQueue` в Task 14; `ChannelDetailDto.credentialLogin` из Task 4 — вход `ChannelPage` в Task 13.

**Коды ответов.** Неверная форма настроек — 400, недоступный канал — 409, неизвестный тип канала в пути — 404, связывание с уже связанным товаром — 409. Каждый закреплён тестом в своей задаче.
