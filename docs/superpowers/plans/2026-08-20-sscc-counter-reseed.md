# SSCC Counter Reseed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать так, чтобы сохранение «Начального серийного номера» в админке действительно меняло номер на следующей напечатанной этикетке.

**Architecture:** Выданный устройству блок серийников получает признак отзыва (`sscc_blocks.revoked_at`). Сохранение счётчика (`SsccService.seedCounter`, общий для настроек организации и карточки контрагента) одной транзакцией проверяет отсутствие активных смен и несинхронизированных станций, опускает нижнюю границу до фактически напечатанного (`MAX(consumed_through_serial) + 1`), пишет счётчик и отзывает живые блоки. Следующий bundle смены нарезает свежий блок с заданного номера и приносит станции список `ssccRevokedFrom`, по которому та удаляет устаревшие строки локального пула.

**Tech Stack:** NestJS + Drizzle ORM (Postgres) в `apps/api`, Drizzle-схема в `packages/db`, React + TanStack Query в `apps/admin`, Tauri + `node:sqlite`/`tauri-plugin-sql` в `apps/station`, Vitest везде.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-08-20-sscc-counter-reseed-design.md`. Расхождения с ней — ошибка реализации, а не улучшение.
- Отозванный блок **никогда не удаляется** из `sscc_blocks` и остаётся видимым для `SsccService.recordConsumedSerial`: поздно доехавшее закрытие короба обязано записать потребление.
- `allocateForBundle` для **неотозванных** блоков менять нельзя — она защищает от выдачи двум устройствам пересекающихся диапазонов.
- Проверка нижней границы обязана оставаться внутри того же одного SQL-стейтмента, что и запись (`atomicSeedSscc`'s `setWhere`), — иначе возвращается гонка «прочитали границу → пока писали, устройство получило блок».
- Extension digit 0 — короба; минимальный серийник для него 1, для остальных 0 (`BOX_EXTENSION_DIGIT`, `firstSerial` в `sscc.service.ts`).
- Ошибки API отдаются в принятом в репозитории виде: `throw new ConflictException({ code: "..." })` — admin-клиент читает `code` из тела (`apiErrorFromResponse` в `apps/admin/src/api/client.ts`).
- Любой пользовательский текст добавляется в **оба** файла: `apps/admin/src/i18n/ru.json` и `apps/admin/src/i18n/en.json`.
- e2e-тесты `apps/api/test/*.e2e.test.ts` молча скипаются без `DATABASE_URL` / `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`. Запускать их только так (из корня репозитория):
  ```bash
  set -a && . ./.env && set +a && pnpm --filter @markiro/api test test/<file>
  ```
  Если в выводе `skipped` вместо `passed` — тест **не прогонялся**, это не зелёный результат.

---

### Task 1: Колонка `sscc_blocks.revoked_at`

**Files:**

- Modify: `packages/db/src/schema/platform.ts:647-700` (таблица `ssccBlocks`)
- Create: `packages/db/migrations/00NN_<generated>.sql` (генерируется drizzle-kit)
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**

- Consumes: ничего.
- Produces: `schema.ssccBlocks.revokedAt` — Drizzle-колонка `revoked_at timestamptz NULL`.

- [ ] **Step 1: Написать падающий тест**

В `packages/db/test/schema.test.ts`, рядом с тестом `"keys the sscc counter by tenant, issuer prefix and extension digit"` (строка ~57), добавить. `ssccBlocks` уже импортирован в шапке файла (строка 18):

```ts
it("lets an sscc block be revoked without being deleted", () => {
  const cols = Object.keys(ssccBlocks);
  expect(cols).toEqual(expect.arrayContaining(["revokedAt"]));
  // Nullable: null IS the live state, and a revoked block must survive as
  // the only record of where a gap in the numbering came from.
  expect(ssccBlocks.revokedAt.notNull).toBe(false);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
pnpm --filter @markiro/db test test/schema.test.ts
```

Ожидаемо: FAIL — `expected [ ... ] to deep equal ArrayContaining ["revokedAt"]`.

- [ ] **Step 3: Добавить колонку в схему**

В `packages/db/src/schema/platform.ts`, в таблице `ssccBlocks`, сразу после `consumedThroughSerial` и перед `issuedAt`:

```ts
    /**
     * When an admin reseeding the counter (`SsccService.seedCounter`)
     * invalidated this block, or null while it is still live.
     *
     * A revoked block is invisible to `allocateForBundle` -- the next bundle
     * cuts a fresh block from the newly seeded counter instead of handing
     * this one back, which is the entire point: without it, a device holding
     * an unexhausted 2000-serial block would keep printing from it and the
     * setting would appear to do nothing.
     *
     * It stays visible to `recordConsumedSerial`, deliberately: a box closure
     * can arrive long after the block it drew from was revoked (an offline
     * device syncing late), and the server must still record which serials
     * really got printed. The row is never deleted for the same reason -- it
     * is the only record of where a gap in the numbering came from.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
pnpm --filter @markiro/db test test/schema.test.ts
```

Ожидаемо: PASS.

- [ ] **Step 5: Сгенерировать миграцию**

```bash
pnpm --filter @markiro/db db:generate
```

Проверить, что появился ровно один новый файл `packages/db/migrations/00NN_*.sql` и его содержимое — единственный оператор:

```sql
ALTER TABLE "sscc_blocks" ADD COLUMN "revoked_at" timestamp with time zone;
```

Если drizzle-kit нагенерил что-то ещё (посторонние `ALTER`/`CREATE` из накопившегося дрейфа снапшота) — **не коммитить**, остановиться и доложить: это отдельная проблема состояния миграций, её нельзя чинить попутно.

- [ ] **Step 6: Применить миграцию к локальной БД**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/db db:migrate
```

Ожидаемо: drizzle-kit сообщает о применённой миграции без ошибок.

- [ ] **Step 7: Коммит**

```bash
git add packages/db/src/schema/platform.ts packages/db/migrations packages/db/test/schema.test.ts
git commit -m "feat(db): add sscc_blocks.revoked_at"
```

---

### Task 2: Нижняя граница по фактически напечатанному

**Files:**

- Modify: `apps/api/src/modules/sscc/sscc.service.ts:95-171` (`seedFloor`, `atomicSeedSscc`)
- Test: `apps/api/test/sscc-settings.e2e.test.ts:253-320` (блок `describe("putSscc floor ...")`)

**Interfaces:**

- Consumes: `schema.ssccBlocks.consumedThroughSerial`.
- Produces: `seedFloor(db, tenantId, issuerPrefix, extensionDigit): Promise<number>` — сигнатура не меняется, меняется смысл: «на один выше самого высокого НАПЕЧАТАННОГО серийника», минимум `firstSerial`. `atomicSeedSscc(db, tenantId, issuerPrefix, extensionDigit, nextSerial): Promise<boolean>` — сигнатура не меняется.

- [ ] **Step 1: Написать падающий тест**

В `apps/api/test/sscc-settings.e2e.test.ts`, внутри `describe("putSscc floor (final review, finding 2)")`, добавить новым тестом:

```ts
it("floors on what was printed, not on what was handed out", async () => {
  const gln = freshGln();
  await agent.put("/org/profile").send({ gln }).expect(200);
  const prefix = gln.slice(0, 9);
  const service = app!.get(SsccService);

  // A block of 50 serials is handed to the device, but only serial 10 is
  // ever reported as actually printed. The old floor (toSerial + 1 = 51)
  // made every unprinted serial in the block permanently unusable; the
  // floor is now one past what was really printed.
  await service.allocate(tenantId, prefix, 0, deviceId, 50);
  await service.recordConsumedSerial(tenantId, buildSscc(0, prefix, 10));

  await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 10 }).expect(400);
  await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 11 }).expect(200);
  expect((await agent.get("/org/profile/sscc").expect(200)).body.nextSerial).toBe(11);
});

it("floors at the box minimum when nothing was ever printed", async () => {
  const gln = freshGln();
  await agent.put("/org/profile").send({ gln }).expect(200);
  const prefix = gln.slice(0, 9);
  await app!.get(SsccService).allocate(tenantId, prefix, 0, deviceId, 50);

  // Handed out but never printed -- serial 1 is still free.
  expect(await seedFloor(db, tenantId, prefix, 0)).toBe(1);
  await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 1 }).expect(200);
});
```

В шапке файла дополнить импорт домена (строка 6) до:

```ts
import { buildSscc, gs1CheckDigit } from "@markiro/domain";
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/api test test/sscc-settings.e2e.test.ts
```

Ожидаемо: FAIL — `expected 400 "Bad Request", got 200` / `expected 200 "OK", got 400` в двух новых тестах (старая граница = `toSerial + 1` = 51).

- [ ] **Step 3: Переписать `seedFloor`**

В `apps/api/src/modules/sscc/sscc.service.ts` заменить тело и доккоммент `seedFloor` (строки 77-112) на:

```ts
/**
 * The lowest `nextSerial` an admin may legally seed for (tenant, issuer
 * prefix, extension digit): one past the highest serial ever actually
 * PRINTED under that triple, or the extension digit's own first serial when
 * nothing has been.
 *
 * "Printed", not "handed out" (2026-08-20 reseed design): reseeding now
 * revokes the blocks a device holds (`SsccService.seedCounter`), so a serial
 * that was merely allocated is not a reason to burn the whole rest of the
 * space -- the device is told to drop that range and will never emit it.
 * What must never be reissued is a serial already on a physical box, and
 * `consumedThroughSerial` -- advanced only by `recordConsumedSerial`, only
 * when a box closure names a real SSCC -- is exactly that set.
 *
 * Deliberately scans REVOKED blocks too: revocation invalidates a range's
 * unprinted remainder, never the record of what was printed from it.
 *
 * Exported as a plain function (rather than a method requiring
 * `SsccService` as an injected dependency) so `seedCounter` can call it on a
 * transaction handle, and so the e2e suite can assert the floor directly.
 */
export async function seedFloor(
  db: Pick<Db, "select">,
  tenantId: string,
  issuerPrefix: string,
  extensionDigit: number,
): Promise<number> {
  const [row] = await db
    .select({ printed: max(schema.ssccBlocks.consumedThroughSerial) })
    .from(schema.ssccBlocks)
    .where(
      and(
        eq(schema.ssccBlocks.tenantId, tenantId),
        eq(schema.ssccBlocks.issuerPrefix, issuerPrefix),
        eq(schema.ssccBlocks.extensionDigit, extensionDigit),
      ),
    );
  const firstSerial = extensionDigit === 0 ? 1 : 0;
  return row?.printed == null ? firstSerial : Math.max(Number(row.printed) + 1, firstSerial);
}
```

- [ ] **Step 4: Синхронно переписать guard внутри `atomicSeedSscc`**

Там же заменить `setWhere` (строки 162-167) на:

```ts
      setWhere: sql`${nextSerial} >= COALESCE((
        SELECT MAX(${schema.ssccBlocks.consumedThroughSerial}) + 1 FROM ${schema.ssccBlocks}
        WHERE ${schema.ssccBlocks.tenantId} = ${tenantId}
          AND ${schema.ssccBlocks.issuerPrefix} = ${issuerPrefix}
          AND ${schema.ssccBlocks.extensionDigit} = ${extensionDigit}
      ), ${extensionDigit === 0 ? 1 : 0})`,
```

И в доккомменте `atomicSeedSscc` (строки 114-144) заменить фразу «re-validates `seedFloor`'s condition live against `sscc_blocks`» на:

```
 * `nextSerial`, in ONE statement that re-validates `seedFloor`'s condition
 * live against `sscc_blocks` at write time -- the highest serial actually
 * PRINTED under this key, matching `seedFloor`'s own definition above. The
 * two expressions must always say the same thing: if they drift, the
 * pre-check and the write disagree and one of them is decorative.
```

- [ ] **Step 5: Поправить существующий тест границы**

В том же файле тест `"rejects seeding below the floor once a block has been issued, but allows seeding at or above it"` строится на старом определении (`floor = block.toSerial + 1`). Он проверяет реальное поведение и должен остаться зелёным — переписать его тело так, чтобы граница создавалась печатью, а не выдачей:

```ts
it("rejects seeding below the floor once a serial has been printed, but allows seeding at or above it", async () => {
  const gln = freshGln();
  await agent.put("/org/profile").send({ gln }).expect(200);
  const prefix = gln.slice(0, 9);

  // Cuts a real sscc_blocks row under this prefix, the same one-statement
  // path a shift bundle uses -- no HTTP route exposes raw allocation, so
  // SsccService is called directly, same as sscc.e2e.test.ts does. The
  // floor comes from the PRINTED serial recorded below, not from the
  // block's bounds (2026-08-20 reseed design).
  const service = app!.get(SsccService);
  const block = await service.allocate(tenantId, prefix, 0, deviceId, 50);
  await service.recordConsumedSerial(tenantId, buildSscc(0, prefix, block.fromSerial + 9));
  const floor = block.fromSerial + 10;

  await agent
    .put("/org/profile/sscc")
    .send({ extensionDigit: 0, nextSerial: floor - 1 })
    .expect(400);

  await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: floor }).expect(200);
  expect((await agent.get("/org/profile/sscc").expect(200)).body.nextSerial).toBe(floor);
});
```

- [ ] **Step 6: Прогнать весь файл + смежный e2e SSCC**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/api test test/sscc-settings.e2e.test.ts test/sscc.e2e.test.ts
```

Ожидаемо: PASS, ноль skipped.

- [ ] **Step 7: Коммит**

```bash
git add apps/api/src/modules/sscc/sscc.service.ts apps/api/test/sscc-settings.e2e.test.ts
git commit -m "fix(sscc): floor the counter seed on printed serials, not issued blocks"
```

---

### Task 3: `allocateForBundle` не выдаёт отозванный блок

**Files:**

- Modify: `apps/api/src/modules/sscc/sscc.service.ts:397-452` (`allocateForBundle`)
- Test: `apps/api/test/sscc.e2e.test.ts`

**Interfaces:**

- Consumes: `schema.ssccBlocks.revokedAt` (Task 1).
- Produces: поведение — `allocateForBundle` нарезает свежий блок, если все блоки устройства отозваны.

- [ ] **Step 1: Написать падающий тест**

В `apps/api/test/sscc.e2e.test.ts` добавить тест внутрь существующего верхнего `describe`. `schema`, `and`, `eq`, `SsccService`, `db`, `tenantId` и хелпер `registerDevice(name)` (строка ~129) там уже есть; дополнить импорт drizzle до `import { and, eq, isNull } from "drizzle-orm";` не нужно — `isNull` в этом тесте не используется:

```ts
it("cuts a fresh block instead of handing back a revoked one", async () => {
  const service = app!.get(SsccService);
  const deviceId = await registerDevice("Revoked block device");
  const prefix = freshPrefix();

  const first = await service.allocateForBundle(tenantId, prefix, 0, deviceId, 50);
  // A repeat fetch must still hand back the SAME block -- that invariant is
  // what keeps a station from burning through the number space on every
  // shift entry, and this test must not silently relax it.
  const repeat = await service.allocateForBundle(tenantId, prefix, 0, deviceId, 50);
  expect(repeat.fromSerial).toBe(first.fromSerial);

  await db
    .update(schema.ssccBlocks)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.ssccBlocks.tenantId, tenantId),
        eq(schema.ssccBlocks.issuerPrefix, prefix),
        eq(schema.ssccBlocks.extensionDigit, 0),
      ),
    );

  const afterRevoke = await service.allocateForBundle(tenantId, prefix, 0, deviceId, 50);
  expect(afterRevoke.fromSerial).toBe(first.toSerial + 1);
});
```

`freshPrefix()` — если в файле уже есть хелпер, дающий неиспользованный 9-значный префикс, использовать его; иначе добавить рядом с остальными фикстурами файла:

```ts
// A 9-digit issuer prefix unused by any other test in this file: these
// tests cut REAL sscc_blocks rows, and sharing a prefix would make one
// test's blocks shift another's expected serials.
let prefixCounter = 0;
function freshPrefix(): string {
  prefixCounter += 1;
  return `47${String(prefixCounter).padStart(7, "0")}`;
}
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/api test test/sscc.e2e.test.ts
```

Ожидаемо: FAIL — `expected 1 to be 51`: отозванный блок всё ещё возвращается как есть.

- [ ] **Step 3: Отфильтровать отозванные блоки**

В `apps/api/src/modules/sscc/sscc.service.ts` в импорте drizzle (строка 8) добавить `isNull`:

```ts
import { and, desc, eq, gte, isNull, lte, max, sql } from "drizzle-orm";
```

В `allocateForBundle`'s SELECT добавить последним предикатом в `and(...)` (после `eq(schema.ssccBlocks.deviceId, deviceId)`):

```ts
            // A revoked block is not this device's block any more: the admin
            // reseeded the counter and the device is being told (via the
            // bundle's `ssccRevokedFrom`) to drop this range entirely. Handing
            // it back here would make the whole reseed a no-op.
            isNull(schema.ssccBlocks.revokedAt),
```

- [ ] **Step 4: Убедиться, что тест проходит**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/api test test/sscc.e2e.test.ts
```

Ожидаемо: PASS, ноль skipped.

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/modules/sscc/sscc.service.ts apps/api/test/sscc.e2e.test.ts
git commit -m "feat(sscc): skip revoked blocks when serving a shift bundle"
```

---

### Task 4: `SsccService.seedCounter` — гуард, запись, отзыв

**Files:**

- Create: `apps/api/src/modules/sscc/dto.ts`
- Modify: `apps/api/src/modules/sscc/sscc.service.ts` (новые экспорты)
- Modify: `apps/api/src/modules/org-profile/org-profile.service.ts:485-552` (`getSscc`, `putSscc`)
- Modify: `apps/api/src/modules/org-profile/org-profile.module.ts`
- Modify: `apps/api/src/modules/org-profile/org-profile.controller.ts:115-127`
- Modify: `apps/api/src/modules/counterparties/counterparties.service.ts:134-182` (`getSscc`, `putSscc`)
- Modify: `apps/api/src/modules/counterparties/counterparties.module.ts`
- Modify: `apps/api/src/modules/counterparties/counterparties.controller.ts` (тип ответа GET)
- Test: `apps/api/test/sscc-settings.e2e.test.ts`

**Interfaces:**

- Consumes: `seedFloor`, `atomicSeedSscc` (Task 2), `schema.ssccBlocks.revokedAt` (Task 1).
- Produces:

  ```ts
  export type SsccSeedBlocker =
    | { kind: "active_shift"; shiftId: string; shiftNumber: string }
    | { kind: "device_out_of_sync"; deviceId: string; deviceName: string };

  export interface SsccCounterStateDto {
    extensionDigit: number;
    nextSerial: number;
    minSerial: number;
    blockedBy: SsccSeedBlocker | null;
  }
  ```

  `SsccService.seedCounter(tenantId: string, issuerPrefix: string, dto: SsccCounterDto): Promise<SsccCounterDto>`
  `SsccService.counterState(tenantId: string, issuerPrefix: string, extensionDigit: number): Promise<SsccCounterStateDto>`

- [ ] **Step 1: Написать падающие тесты**

В `apps/api/test/sscc-settings.e2e.test.ts` добавить новый `describe` на верхнем уровне файла (внутри корневого `describe`):

```ts
describe("seed guards and block revocation (2026-08-20 reseed design)", () => {
  it("refuses to seed while a shift is active, and says which one", async () => {
    const gln = freshGln();
    await agent.put("/org/profile").send({ gln }).expect(200);
    const shift = await openAggregationShift();

    const res = await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: 0, nextSerial: 900 })
      .expect(409);
    expect(res.body.code).toBe("sscc_seed_active_shift");

    const state = await agent.get("/org/profile/sscc").expect(200);
    expect(state.body.blockedBy).toEqual({
      kind: "active_shift",
      shiftId: shift.id,
      shiftNumber: shift.number,
    });

    await closeShift(shift.id);
    await agent.put("/org/profile/sscc").send({ extensionDigit: 0, nextSerial: 900 }).expect(200);
  });

  it("reports the current floor as minSerial", async () => {
    const gln = freshGln();
    await agent.put("/org/profile").send({ gln }).expect(200);
    const prefix = gln.slice(0, 9);
    const service = app!.get(SsccService);
    await service.allocate(tenantId, prefix, 0, deviceId, 50);
    await service.recordConsumedSerial(tenantId, buildSscc(0, prefix, 7));

    const res = await agent.get("/org/profile/sscc").expect(200);
    expect(res.body.minSerial).toBe(8);
    expect(res.body.blockedBy).toBeNull();
  });

  it("revokes the device's live block when the value changes, and leaves it when it does not", async () => {
    const gln = freshGln();
    await agent.put("/org/profile").send({ gln }).expect(200);
    const prefix = gln.slice(0, 9);
    const service = app!.get(SsccService);
    const block = await service.allocate(tenantId, prefix, 0, deviceId, 50);

    const liveBlocks = async () =>
      db
        .select({ id: schema.ssccBlocks.id })
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, tenantId),
            eq(schema.ssccBlocks.issuerPrefix, prefix),
            isNull(schema.ssccBlocks.revokedAt),
          ),
        );

    // Re-saving the value the counter already holds must NOT revoke: every
    // redundant "Save" would otherwise burn a whole block and tear a
    // 2000-serial hole in the numbering.
    const unchanged = (await agent.get("/org/profile/sscc").expect(200)).body.nextSerial;
    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: 0, nextSerial: unchanged })
      .expect(200);
    expect(await liveBlocks()).toHaveLength(1);

    await agent
      .put("/org/profile/sscc")
      .send({ extensionDigit: 0, nextSerial: block.toSerial + 500 })
      .expect(200);
    expect(await liveBlocks()).toHaveLength(0);
  });
});
```

Хелперы в файле отсутствуют — добавить их внутрь этого же `describe`, рядом с существующим `freshGln()` (порядок вызовов скопирован из `apps/api/test/shifts-bundle.e2e.test.ts`, где та же последовательность уже работает):

```ts
/** Direct-DB product seed: product validation is not what these tests exercise. */
async function seedProduct(): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.products).values({
    id,
    tenantId,
    gtin14: `${Math.floor(Math.random() * 1e13)}`.padStart(14, "0"),
    name: "Seed Product",
    status: "active",
  });
  return id;
}

/** Creates + opens an aggregation shift, returning its id and display number. */
async function openAggregationShift(): Promise<{ id: string; number: string }> {
  const productId = await seedProduct();
  const created = await agent.post("/shifts").send({ productId, mode: "aggregation" }).expect(201);
  const id = created.body.id as string;
  const opened = await agent.post(`/shifts/${id}/open`).expect(200);
  return { id, number: opened.body.number as string };
}

/** Closes a shift so the counter guard stops reporting it (`reason` is min 3 chars). */
async function closeShift(id: string): Promise<void> {
  await agent.post(`/shifts/${id}/close`).send({ reason: "counter reseed test" }).expect(200);
}
```

В шапке файла дополнить импорт drizzle до `import { and, eq, isNull } from "drizzle-orm";` и добавить `import { randomUUID } from "node:crypto";`.

- [ ] **Step 2: Убедиться, что тесты падают**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/api test test/sscc-settings.e2e.test.ts
```

Ожидаемо: FAIL — `expected 409 "Conflict", got 200` и `expected undefined to be 8` (`minSerial` в ответе нет).

- [ ] **Step 3: Завести DTO модуля sscc**

Создать `apps/api/src/modules/sscc/dto.ts`:

```ts
/**
 * Why an admin currently cannot reseed this counter, or null when nothing
 * stands in the way.
 *
 * Reseeding revokes the serial blocks devices hold, and a device that is
 * still printing (or that has printed boxes it hasn't uploaded yet) would
 * emit serials from a range the server has already handed to someone else --
 * two physical boxes under one SSCC, surfacing only at ingest as a
 * `boxes_tenant_sscc_uq` violation that fails the whole batch. Both blockers
 * below are the cheap, checkable proxies for "no device is mid-print".
 */
export type SsccSeedBlocker =
  /** A shift is open, so a station may be printing right now. */
  | { kind: "active_shift"; shiftId: string; shiftNumber: string }
  /**
   * A device holding a live block has not checked in since the last shift
   * closed, so it may be sitting offline with closed boxes it hasn't sent.
   */
  | { kind: "device_out_of_sync"; deviceId: string; deviceName: string };

/** `GET /org/profile/sscc` and `GET /counterparties/:id/sscc` response. */
export interface SsccCounterStateDto {
  extensionDigit: number;
  /** The serial the next printed label will carry. */
  nextSerial: number;
  /** The lowest value `PUT` will accept right now (`seedFloor`). */
  minSerial: number;
  blockedBy: SsccSeedBlocker | null;
}
```

- [ ] **Step 4: Реализовать `findSeedBlocker`, `counterState`, `seedCounter`**

В `apps/api/src/modules/sscc/sscc.service.ts` дополнить импорты:

```ts
import { and, desc, eq, gte, isNull, lt, lte, max, or, sql } from "drizzle-orm";
import { formatShiftNumber, parseSscc, ssccSerialCapacity } from "@markiro/domain";
import type { SsccCounterStateDto, SsccSeedBlocker } from "./dto";
```

Добавить перед классом `SsccService`:

```ts
/**
 * The reason an admin may not reseed this counter right now, or null.
 *
 * Two independent checks, in order of how likely they are to be the answer:
 *
 * 1. Any shift of this tenant is `active`. Deliberately tenant-wide rather
 *    than scoped to shifts using THIS issuer prefix: the rule an admin has to
 *    hold in their head is "close the shifts, then change the number", and a
 *    prefix-scoped version would let a reseed land while the plant is
 *    running, on the strength of a `resolveIssuerPrefix` result that a shift
 *    edit can change a second later.
 * 2. A device still holding a live block under this prefix has not been seen
 *    since the last shift closed (`last_seen_at` null or older than
 *    `MAX(shifts.closed_at)`). That device may hold closed boxes it never
 *    uploaded, whose SSCCs sit in the range about to be revoked. Revoked
 *    station devices are skipped -- a decommissioned terminal would otherwise
 *    block the setting forever.
 */
export async function findSeedBlocker(
  db: Pick<Db, "select">,
  tenantId: string,
  issuerPrefix: string,
  extensionDigit: number,
): Promise<SsccSeedBlocker | null> {
  const [active] = await db
    .select({
      id: schema.shifts.id,
      monthKey: schema.shifts.numberMonthKey,
      seq: schema.shifts.numberSeq,
      createdFrom: schema.shifts.createdFrom,
    })
    .from(schema.shifts)
    .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.status, "active")))
    .limit(1);
  if (active) {
    return {
      kind: "active_shift",
      shiftId: active.id,
      shiftNumber: formatShiftNumber({
        monthKey: active.monthKey,
        seq: active.seq,
        createdFrom: active.createdFrom,
      }),
    };
  }

  const [lastClose] = await db
    .select({ at: max(schema.shifts.closedAt) })
    .from(schema.shifts)
    .where(eq(schema.shifts.tenantId, tenantId));
  const closedAt = lastClose?.at ?? null;
  // No shift has ever closed here: no device can be holding boxes from one.
  if (!closedAt) return null;

  const [stale] = await db
    .select({ id: schema.stationDevices.id, name: schema.stationDevices.name })
    .from(schema.ssccBlocks)
    .innerJoin(
      schema.stationDevices,
      and(
        eq(schema.stationDevices.tenantId, schema.ssccBlocks.tenantId),
        eq(schema.stationDevices.id, schema.ssccBlocks.deviceId),
      ),
    )
    .where(
      and(
        eq(schema.ssccBlocks.tenantId, tenantId),
        eq(schema.ssccBlocks.issuerPrefix, issuerPrefix),
        eq(schema.ssccBlocks.extensionDigit, extensionDigit),
        isNull(schema.ssccBlocks.revokedAt),
        isNull(schema.stationDevices.revokedAt),
        or(
          isNull(schema.stationDevices.lastSeenAt),
          lt(schema.stationDevices.lastSeenAt, closedAt),
        ),
      ),
    )
    .limit(1);
  return stale ? { kind: "device_out_of_sync", deviceId: stale.id, deviceName: stale.name } : null;
}
```

Внутри класса `SsccService` добавить два метода (после `resolveIssuerPrefix`):

```ts
  /**
   * Everything the settings form needs in one read: the counter itself, the
   * floor it may not go below, and why it is currently locked (if it is).
   * The floor and the blocker are computed here rather than in the UI so the
   * form can never disagree with what `seedCounter` will actually enforce.
   */
  async counterState(
    tenantId: string,
    issuerPrefix: string,
    extensionDigit: number,
  ): Promise<SsccCounterStateDto> {
    const [row] = await this.db
      .select({ nextSerial: schema.ssccCounters.nextSerial })
      .from(schema.ssccCounters)
      .where(
        and(
          eq(schema.ssccCounters.tenantId, tenantId),
          eq(schema.ssccCounters.issuerPrefix, issuerPrefix),
          eq(schema.ssccCounters.extensionDigit, extensionDigit),
        ),
      );
    const firstSerial = extensionDigit === 0 ? 1 : 0;
    return {
      extensionDigit,
      nextSerial: row ? Number(row.nextSerial) : firstSerial,
      minSerial: await seedFloor(this.db, tenantId, issuerPrefix, extensionDigit),
      blockedBy: await findSeedBlocker(this.db, tenantId, issuerPrefix, extensionDigit),
    };
  }

  /**
   * Seeds (or reseeds) a counter AND revokes the serial blocks devices hold
   * under it, so the new value reaches the next printed label instead of
   * waiting out a 2000-serial block already in a station's hands (the bug
   * this whole path exists to fix -- see the 2026-08-20 reseed design doc).
   *
   * One transaction, in this order, because each step's correctness depends
   * on the previous one still holding at commit time:
   *
   * 1. `findSeedBlocker` -- refuse outright while a station could be
   *    printing. This is the ONLY thing standing between a reseed and two
   *    physical boxes sharing an SSCC, since the floor no longer covers
   *    merely-allocated serials.
   * 2. `seedFloor` -- refuse to reissue a serial already printed.
   * 3. `atomicSeedSscc` -- the write, re-validating (2) inside its own
   *    statement against live data.
   * 4. Revoke live blocks, but ONLY when the value actually moved. Revoking
   *    on a no-op save would burn the device's block and tear a hole the
   *    size of `BOX_BLOCK_SIZE` into the numbering for nothing.
   */
  async seedCounter(
    tenantId: string,
    issuerPrefix: string,
    dto: { extensionDigit: number; nextSerial: number },
  ): Promise<{ extensionDigit: number; nextSerial: number }> {
    return this.db.transaction(async (tx) => {
      const blocker = await findSeedBlocker(tx, tenantId, issuerPrefix, dto.extensionDigit);
      if (blocker) {
        throw new ConflictException({
          code:
            blocker.kind === "active_shift"
              ? "sscc_seed_active_shift"
              : "sscc_seed_device_out_of_sync",
          blockedBy: blocker,
        });
      }

      const floor = await seedFloor(tx, tenantId, issuerPrefix, dto.extensionDigit);
      if (dto.nextSerial < floor) {
        throw new BadRequestException({ code: "sscc_seed_below_floor", minSerial: floor });
      }

      const [current] = await tx
        .select({ nextSerial: schema.ssccCounters.nextSerial })
        .from(schema.ssccCounters)
        .where(
          and(
            eq(schema.ssccCounters.tenantId, tenantId),
            eq(schema.ssccCounters.issuerPrefix, issuerPrefix),
            eq(schema.ssccCounters.extensionDigit, dto.extensionDigit),
          ),
        );

      const applied = await atomicSeedSscc(
        tx,
        tenantId,
        issuerPrefix,
        dto.extensionDigit,
        dto.nextSerial,
      );
      if (!applied) throw new ConflictException({ code: "sscc_seed_floor_moved" });

      if (current == null || Number(current.nextSerial) !== dto.nextSerial) {
        await tx
          .update(schema.ssccBlocks)
          .set({ revokedAt: sql`now()` })
          .where(
            and(
              eq(schema.ssccBlocks.tenantId, tenantId),
              eq(schema.ssccBlocks.issuerPrefix, issuerPrefix),
              eq(schema.ssccBlocks.extensionDigit, dto.extensionDigit),
              isNull(schema.ssccBlocks.revokedAt),
            ),
          );
      }

      return { extensionDigit: dto.extensionDigit, nextSerial: dto.nextSerial };
    });
  }
```

- [ ] **Step 5: Перевести оба вызывающих модуля на общий сервис**

`apps/api/src/modules/org-profile/org-profile.service.ts` — заменить тела `getSscc` (строки 489-501) и `putSscc` (строки 532-551), сохранив доккомменты в сокращённом виде:

```ts
  /**
   * The tenant's own box SSCC counter plus everything the settings form needs
   * to render its rules (floor, current blocker) -- see
   * `SsccService.counterState`. Always reads `BOX_EXTENSION_DIGIT`: 06c only
   * has boxes; 06d's pallets will need their own read path.
   */
  async getSscc(tenantId: string): Promise<SsccCounterStateDto> {
    const issuerPrefix = await this.ownIssuerPrefix(tenantId);
    return this.sscc.counterState(tenantId, issuerPrefix, BOX_EXTENSION_DIGIT);
  }

  /**
   * Seeds the tenant's own box counter. All of the rules -- the active-shift
   * and out-of-sync-device guards, the printed-serial floor, the atomic
   * write, the revocation of blocks devices still hold -- live in
   * `SsccService.seedCounter`, shared verbatim with the counterparties
   * module: this method's only job is naming WHOSE prefix is being seeded.
   */
  async putSscc(tenantId: string, dto: SsccCounterDto): Promise<SsccCounterDto> {
    const issuerPrefix = await this.ownIssuerPrefix(tenantId);
    return this.sscc.seedCounter(tenantId, issuerPrefix, dto);
  }
```

Инжектировать сервис в конструктор `OrgProfileService` (добавить параметр `private readonly sscc: SsccService`), импортировать `SsccService` и `SsccCounterStateDto` из `../sscc/sscc.service` и `../sscc/dto`, убрать ставшие неиспользуемыми импорты `seedFloor` / `atomicSeedSscc` / `ConflictException` (если больше нигде в файле не нужны — проверить `pnpm --filter @markiro/api lint`).

В `org-profile.module.ts` добавить `imports: [SsccModule]`.

Ровно те же четыре правки — в `counterparties.service.ts` (`getSscc`/`putSscc`, конструктор) и `counterparties.module.ts`. В `counterparties.service.ts` префикс резолвится через существующий `this.counterpartyIssuerPrefix(tenantId, id)`, порядок сохранить: сначала он (он же 404-ит чужой id), потом `seedCounter`.

Обновить типы ответа `@Get("sscc")` в обоих контроллерах на `Promise<SsccCounterStateDto>`.

- [ ] **Step 6: Прогнать тесты и типы**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/api test test/sscc-settings.e2e.test.ts test/sscc.e2e.test.ts test/shifts-bundle.e2e.test.ts
pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint
```

Ожидаемо: PASS, ноль skipped; typecheck и lint без ошибок.

- [ ] **Step 7: Коммит**

```bash
git add apps/api/src/modules apps/api/test/sscc-settings.e2e.test.ts
git commit -m "feat(sscc): guard and revoke on counter reseed via shared seedCounter"
```

---

### Task 5: Bundle отдаёт `ssccRevokedFrom`

**Files:**

- Modify: `apps/api/src/modules/shifts/dto.ts:175-188`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts:575-582` (`getBundle`), `:668-672` (`getReferenceBundle` return), `:722-777` (`bundleSscc`)
- Modify: `apps/api/src/modules/sscc/sscc.service.ts` (новый метод)
- Test: `apps/api/test/shifts-bundle.e2e.test.ts`

**Interfaces:**

- Consumes: `schema.ssccBlocks.revokedAt` (Task 1), `SsccService.allocateForBundle` (Task 3).
- Produces: `ShiftBundleDto.ssccRevokedFrom: number[]`; `SsccService.revokedFromSerials(tenantId, issuerPrefix, extensionDigit, deviceId, executor?): Promise<number[]>`.

- [ ] **Step 1: Написать падающий тест**

В `apps/api/test/shifts-bundle.e2e.test.ts` добавить тест внутрь уже существующего `describe("box serial block on the bundle (Task 7)")` (строка ~363) — там уже подготовлены `agent`, `orgId`, `stationKey`, `stationDeviceId`, `shiftId`:

```ts
it("tells the device which of its blocks were revoked", async () => {
  const server = app!.getHttpServer();
  const fetchBundle = () =>
    request(server).get(`/shifts/${shiftId}/bundle`).set("x-api-key", stationKey).expect(200);

  const bundle = await fetchBundle();
  expect(bundle.body.ssccRevokedFrom).toEqual([]);
  const held = bundle.body.sscc.fromSerial as number;

  await db
    .update(schema.ssccBlocks)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(schema.ssccBlocks.tenantId, orgId), eq(schema.ssccBlocks.deviceId, stationDeviceId)),
    );

  const after = await fetchBundle();
  // A fresh block, plus the old one named so the device drops it -- without
  // that list the station's burnSerial would keep draining the lower range
  // (ORDER BY from_serial) and the reseed would never reach a label.
  expect(after.body.sscc.fromSerial).toBeGreaterThan(held);
  expect(after.body.ssccRevokedFrom).toEqual([held]);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/api test test/shifts-bundle.e2e.test.ts
```

Ожидаемо: FAIL — `expected undefined to deep equal []`.

- [ ] **Step 3: Добавить чтение отозванных блоков**

В `apps/api/src/modules/sscc/sscc.service.ts`, в классе `SsccService`, после `allocateForBundle`:

```ts
  /**
   * The `fromSerial` of every block this device holds that has since been
   * revoked, oldest first.
   *
   * The device cannot work this out on its own: `burnSerial` drains ranges
   * by `ORDER BY from_serial`, so a revoked low range keeps winning over the
   * fresh high one until it is deleted locally. An explicit list -- rather
   * than "delete anything the bundle didn't name" -- is what keeps this
   * correct on the day a device legitimately holds two live blocks (the
   * station's ingest-response top-up path in sync.ts is already written,
   * just not yet served).
   *
   * Sent on every bundle, not just the first after a revocation: the station
   * may miss any single fetch, and re-sending is idempotent -- the rows are
   * already gone.
   */
  async revokedFromSerials(
    tenantId: string,
    issuerPrefix: string,
    extensionDigit: number,
    deviceId: string,
    executor: Pick<Db, "select"> = this.db,
  ): Promise<number[]> {
    const rows = await executor
      .select({ fromSerial: schema.ssccBlocks.fromSerial })
      .from(schema.ssccBlocks)
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.issuerPrefix, issuerPrefix),
          eq(schema.ssccBlocks.extensionDigit, extensionDigit),
          eq(schema.ssccBlocks.deviceId, deviceId),
          isNotNull(schema.ssccBlocks.revokedAt),
        ),
      )
      .orderBy(schema.ssccBlocks.fromSerial);
    return rows.map((row) => Number(row.fromSerial));
  }
```

Дополнить импорт drizzle: `isNotNull`.

- [ ] **Step 4: Провести поле через DTO и сборку bundle**

В `apps/api/src/modules/shifts/dto.ts`, сразу после поля `sscc` в `ShiftBundleDto`:

```ts
  /**
   * `fromSerial` of every block this device was handed and that has since
   * been revoked by an admin reseeding the counter. The station deletes the
   * matching `sscc_pool` rows (`dropRanges`) before applying `sscc` above --
   * without that, its `burnSerial` would keep draining the revoked lower
   * range and the reseeded number would never reach a label.
   *
   * Always present, `[]` when there is nothing to drop (including every
   * reference-only bundle, which never touches allocation state at all).
   */
  ssccRevokedFrom: number[];
```

В `shifts.service.ts`:

```ts
  async getBundle(tenantId: string, id: string, deviceId: string | null): Promise<ShiftBundleDto> {
    const referenceBundle = await this.getReferenceBundle(tenantId, id);
    const allocation =
      referenceBundle.shift.mode === "aggregation" && deviceId
        ? await this.bundleSscc(tenantId, referenceBundle.shift.id, deviceId)
        : { sscc: null, ssccRevokedFrom: [] };
    return { ...referenceBundle, ...allocation };
  }
```

В `getReferenceBundle`'s return-объекте рядом с `sscc: null` добавить `ssccRevokedFrom: [],`.

Переписать хвост `bundleSscc` — тип возврата и оба `return null` внутри транзакции. Сигнатура:

```ts
  private async bundleSscc(
    tenantId: string,
    shiftId: string,
    deviceId: string,
  ): Promise<Pick<ShiftBundleDto, "sscc" | "ssccRevokedFrom">> {
```

- ранние выходы (`!shift || shift.status !== "active" || ...`, read-only подписка, неразрешённый префикс, `SsccCapacityExhaustedException`) возвращают `{ sscc: null, ssccRevokedFrom: [] }` вместо `null`;
- успешная ветка:

```ts
      try {
        const sscc = await this.sscc.allocateForBundle(
          tenantId,
          issuerPrefix,
          BOX_EXTENSION_DIGIT,
          deviceId,
          BOX_BLOCK_SIZE,
          tx,
        );
        // Read AFTER allocation, in the same transaction: allocation is what
        // may have just cut the replacement for a revoked block, and the two
        // must describe one consistent moment.
        const ssccRevokedFrom = await this.sscc.revokedFromSerials(
          tenantId,
          issuerPrefix,
          BOX_EXTENSION_DIGIT,
          deviceId,
          tx,
        );
        return { sscc, ssccRevokedFrom };
      } catch (error) {
```

- [ ] **Step 5: Убедиться, что тест проходит**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/api test test/shifts-bundle.e2e.test.ts
pnpm --filter @markiro/api typecheck
```

Ожидаемо: PASS, ноль skipped; typecheck чистый.

- [ ] **Step 6: Коммит**

```bash
git add apps/api/src/modules apps/api/test/shifts-bundle.e2e.test.ts
git commit -m "feat(shifts): carry revoked serial blocks in the station bundle"
```

---

### Task 6: Станция удаляет отозванные диапазоны

**Files:**

- Modify: `apps/station/src/lib/sscc-pool.ts`
- Modify: `apps/station/src/lib/mirror.ts:60-78` (`StationBundle.sscc` рядом)
- Modify: `apps/station/src/lib/shift-bundle.ts:70-102`
- Test: `apps/station/test/sscc-pool.test.ts`, `apps/station/test/shift-bundle.test.ts`

**Interfaces:**

- Consumes: `ShiftBundleDto.ssccRevokedFrom` (Task 5).
- Produces: `dropRanges(exec: SqlExecutor, issuerPrefix: string, extensionDigit: number, fromSerials: number[]): Promise<void>`.

- [ ] **Step 1: Написать падающий тест пула**

В `apps/station/test/sscc-pool.test.ts` дописать в `describe("sscc pool")`:

```ts
it("drops a revoked range so burning moves to the replacement block", async () => {
  await addRange(exec, {
    issuerPrefix: ISSUER_PREFIX,
    extensionDigit: 0,
    fromSerial: 1,
    toSerial: 2000,
    consumedThroughSerial: 10,
  });
  await addRange(exec, {
    issuerPrefix: ISSUER_PREFIX,
    extensionDigit: 0,
    fromSerial: 5000,
    toSerial: 6999,
    consumedThroughSerial: null,
  });
  // burnSerial takes the LOWEST from_serial, so the revoked block wins
  // until it is actually deleted -- this is the whole reason dropRanges
  // exists rather than just adding the new range.
  expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(11);

  await dropRanges(exec, ISSUER_PREFIX, 0, [1]);
  expect(await burnSerial(exec, ISSUER_PREFIX, 0)).toBe(5000);
});

it("ignores an empty revocation list and a range it does not hold", async () => {
  await addRange(exec, {
    issuerPrefix: ISSUER_PREFIX,
    extensionDigit: 0,
    fromSerial: 1,
    toSerial: 9,
    consumedThroughSerial: null,
  });
  await dropRanges(exec, ISSUER_PREFIX, 0, []);
  await dropRanges(exec, ISSUER_PREFIX, 0, [12345]);
  expect(await remaining(exec, ISSUER_PREFIX, 0)).toBe(9);
});

it("does not drop the same from_serial under another extension digit", async () => {
  await addRange(exec, {
    issuerPrefix: ISSUER_PREFIX,
    extensionDigit: 1,
    fromSerial: 1,
    toSerial: 9,
    consumedThroughSerial: null,
  });
  await dropRanges(exec, ISSUER_PREFIX, 0, [1]);
  expect(await remaining(exec, ISSUER_PREFIX, 1)).toBe(9);
});
```

Дополнить импорт файла: `import { addRange, burnSerial, dropRanges, remaining } from "../src/lib/sscc-pool.js";`

- [ ] **Step 2: Убедиться, что тест падает**

```bash
pnpm --filter @markiro/station test test/sscc-pool.test.ts
```

Ожидаемо: FAIL — `dropRanges is not a function` / ошибка импорта.

- [ ] **Step 3: Реализовать `dropRanges`**

В `apps/station/src/lib/sscc-pool.ts`, после `addRange`:

```ts
/**
 * Deletes ranges the server has revoked (`ShiftBundleDto.ssccRevokedFrom`).
 *
 * Deleting, not exhausting: `burnSerial` picks the lowest `from_serial` that
 * still has room, so a revoked block left in place keeps winning over the
 * replacement the server just cut, and an admin's reseeded number never
 * reaches a label -- the exact bug this whole path fixes.
 *
 * Keyed on the pool's own primary key `(issuer_prefix, extension_digit,
 * from_serial)`, so a `from_serial` the device does not hold, or holds under
 * a different extension digit, is simply not matched. Idempotent: a replayed
 * bundle deletes rows that are already gone.
 */
export async function dropRanges(
  exec: SqlExecutor,
  issuerPrefix: string,
  extensionDigit: number,
  fromSerials: number[],
): Promise<void> {
  if (fromSerials.length === 0) return;
  const placeholders = fromSerials.map(() => "?").join(",");
  await exec.run(
    `DELETE FROM sscc_pool
     WHERE issuer_prefix = ? AND extension_digit = ? AND from_serial IN (${placeholders})`,
    [issuerPrefix, extensionDigit, ...fromSerials],
  );
}
```

- [ ] **Step 4: Убедиться, что тесты пула проходят**

```bash
pnpm --filter @markiro/station test test/sscc-pool.test.ts
```

Ожидаемо: PASS.

- [ ] **Step 5: Написать падающий тест bundle-пути**

В `apps/station/test/shift-bundle.test.ts` добавить тест по образцу уже имеющихся там (мок `client.get`, `node:sqlite`-executor):

```ts
it("drops revoked ranges before adding the replacement block", async () => {
  await addRange(exec, {
    issuerPrefix: "460123456",
    extensionDigit: 0,
    fromSerial: 1,
    toSerial: 2000,
    consumedThroughSerial: 10,
  });

  const client = {
    get: vi.fn().mockResolvedValue({
      ...BUNDLE,
      sscc: {
        issuerPrefix: "460123456",
        extensionDigit: 0,
        fromSerial: 5000,
        toSerial: 6999,
        consumedThroughSerial: null,
      },
      ssccRevokedFrom: [1],
    }),
  };

  await mirrorShiftBundle(client, exec, SHIFT_ID);
  expect(await burnSerial(exec, "460123456", 0)).toBe(5000);
});

it("drops nothing when the bundle carries no block", async () => {
  await addRange(exec, {
    issuerPrefix: "460123456",
    extensionDigit: 0,
    fromSerial: 1,
    toSerial: 2000,
    consumedThroughSerial: 10,
  });
  const client = {
    get: vi.fn().mockResolvedValue({ ...BUNDLE, sscc: null, ssccRevokedFrom: [1] }),
  };

  // A degraded bundle (no GLN, exhausted prefix) names no prefix to scope
  // the delete to, and must never cost the device serials it can still use.
  await mirrorShiftBundle(client, exec, SHIFT_ID);
  expect(await burnSerial(exec, "460123456", 0)).toBe(11);
});
```

`BUNDLE` / `SHIFT_ID` — существующие фикстуры файла; если они называются иначе, использовать местные имена, не переименовывая их.

- [ ] **Step 6: Убедиться, что тест падает**

```bash
pnpm --filter @markiro/station test test/shift-bundle.test.ts
```

Ожидаемо: FAIL — `expected 11 to be 5000` в первом тесте.

- [ ] **Step 7: Провести поле и вызвать `dropRanges`**

В `apps/station/src/lib/mirror.ts`, в интерфейсе `StationBundle`, сразу после поля `sscc`:

```ts
  /**
   * `fromSerial` of blocks the server has revoked for this device (an admin
   * reseeded the counter). `shift-bundle.ts` deletes the matching pool rows
   * BEFORE applying `sscc` above.
   *
   * Optional: a server older than this field, and every test fixture written
   * before it, simply revokes nothing.
   */
  ssccRevokedFrom?: number[];
```

В `apps/station/src/lib/shift-bundle.ts` дополнить импорт до `import { addRange, dropRanges } from "./sscc-pool.js";` и заменить блок применения диапазона в `mirrorShiftBundleBody`:

```ts
if (mirrorSsccRange && bundle.sscc) {
  // Revocations first: `addRange` inserts the replacement block, and
  // `burnSerial` would keep preferring a revoked LOWER range left behind
  // (it drains by `ORDER BY from_serial`). Scoped to the prefix/digit the
  // bundle itself names -- a degraded bundle (`sscc: null`) names none, so
  // it deletes nothing rather than guessing.
  if (bundle.ssccRevokedFrom?.length) {
    await dropRanges(
      exec,
      bundle.sscc.issuerPrefix,
      bundle.sscc.extensionDigit,
      bundle.ssccRevokedFrom,
    );
  }
  await addRange(exec, bundle.sscc);
}
```

Порядок относительно `upsertBundle` не менять — обоснование в доккомменте файла (CodeRabbit PR33, Finding 10) остаётся в силе: пул целиком приводится в актуальное состояние до публикации `shift_mirror.issuer_prefix`.

- [ ] **Step 8: Прогнать станционные тесты**

```bash
pnpm --filter @markiro/station test test/sscc-pool.test.ts test/shift-bundle.test.ts test/close-box.test.ts test/sync.test.ts
pnpm --filter @markiro/station typecheck
```

Ожидаемо: PASS; typecheck чистый.

- [ ] **Step 9: Коммит**

```bash
git add apps/station/src/lib apps/station/test
git commit -m "feat(station): drop revoked serial ranges from the local pool"
```

---

### Task 7: Админка — граница, блокировка и локализованные ошибки

**Files:**

- Create: `apps/admin/src/lib/sscc-counter.ts`
- Modify: `apps/admin/src/pages/settings/api.ts:36-64`
- Modify: `apps/admin/src/pages/settings/OrgProfilePage.tsx:75-95, 443-530`
- Modify: `apps/admin/src/pages/counterparties/api.ts:34-38`
- Modify: `apps/admin/src/pages/counterparties/CounterpartyForm.tsx:60-90, 211-300`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/org-profile.test.tsx`, `apps/admin/test/counterparties.test.tsx`

**Interfaces:**

- Consumes: `SsccCounterStateDto`, `SsccSeedBlocker`, коды ошибок `sscc_seed_active_shift` / `sscc_seed_device_out_of_sync` / `sscc_seed_below_floor` / `sscc_seed_floor_moved` (Task 4).
- Produces: в `apps/admin/src/lib/sscc-counter.ts` — типы `SsccSeedBlocker` / `SsccCounterStateDto` и функции `describeSsccBlocker(t: TFunction, blockedBy: SsccSeedBlocker | null): string | null` и `describeSsccSeedError(t: TFunction, error: unknown, minSerial: number): string | null`; обе формы используют их без дублирования.

- [ ] **Step 1: Написать падающий тест**

В `apps/admin/test/org-profile.test.tsx` обновить фикстуру и добавить тесты:

```ts
const COUNTER = { extensionDigit: 0, nextSerial: 45_000, minSerial: 40_000, blockedBy: null };
const COUNTER_BLOCKED = {
  ...COUNTER,
  blockedBy: { kind: "active_shift", shiftId: "s-1", shiftNumber: "AUG26-003" },
};
```

```ts
it("locks the sscc counter while a shift is active and names the shift", async () => {
  vi.stubGlobal("fetch", routeFetch({ sscc: () => jsonResponse(200, COUNTER_BLOCKED) }));
  renderPage();

  const card = await cardOf("Счётчик SSCC для коробов");
  const input = within(card).getByLabelText("Начальный серийный номер");
  await waitFor(() => expect(input).toBeDisabled());
  expect(within(card).getByText(/AUG26-003/)).toBeDefined();
  expect(within(card).getByRole("button", { name: "Сохранить" })).toBeDisabled();
});

it("shows the floor the server reported rather than a hardcoded one", async () => {
  vi.stubGlobal("fetch", routeFetch({}));
  renderPage();

  const card = await cardOf("Счётчик SSCC для коробов");
  // 45 000 is the counter (the next label's serial), 40 000 the floor --
  // both come from the server; the form must not invent either.
  await waitFor(() => expect(within(card).getByText(/40\s?000/)).toBeDefined());
  expect(within(card).getByRole("button", { name: "Сохранить" })).not.toBeDisabled();
});
```

`routeFetch`, `jsonResponse`, `cardOf` и `COUNTER` уже определены в этом файле (строки 13-90); добавляется только фикстура `COUNTER_BLOCKED` выше. Тесты этого файла ходят по русским строкам — брать их из `ru.json` дословно.

- [ ] **Step 2: Убедиться, что тест падает**

```bash
pnpm --filter @markiro/admin test test/org-profile.test.tsx
```

Ожидаемо: FAIL — поле не заблокировано, текста с номером смены нет.

- [ ] **Step 3: Добавить строки локализации**

В `apps/admin/src/i18n/ru.json` добавить секцию `common.sscc` (общая для обеих форм — тексты идентичны, дублировать их в двух ветках дерева нельзя):

```json
    "sscc": {
      "nextLabelHint": "Уже напечатано до {{printed}}. Сохранённый номер получит первая этикетка следующей смены; минимально допустимо {{min}}.",
      "blocked": {
        "activeShift": "Пока открыта смена {{number}}, счётчик менять нельзя: станция может печатать прямо сейчас. Закройте смену и повторите.",
        "deviceOutOfSync": "Станция «{{device}}» не выходила на связь после закрытия последней смены. Дождитесь синхронизации: иначе её короба получат номера, уже выданные заново."
      },
      "errors": {
        "belowFloor": "Номер должен быть не меньше {{min}}: меньшие уже напечатаны на коробах.",
        "floorMoved": "Счётчик изменился, пока форма была открыта. Обновите страницу и повторите.",
        "activeShift": "Смена открылась, пока форма была открыта. Закройте её и повторите.",
        "deviceOutOfSync": "Появилась несинхронизированная станция. Обновите страницу и повторите."
      }
    }
```

В `apps/admin/src/i18n/en.json` — те же ключи:

```json
    "sscc": {
      "nextLabelHint": "Printed through {{printed}}. The value you save is what the next shift's first label will carry; the lowest allowed value is {{min}}.",
      "blocked": {
        "activeShift": "Shift {{number}} is open, so a station may be printing right now. Close it before changing the counter.",
        "deviceOutOfSync": "Station \"{{device}}\" has not checked in since the last shift closed. Wait for it to sync, or its boxes will take serials that were handed out again."
      },
      "errors": {
        "belowFloor": "The serial must be at least {{min}}: lower ones are already printed on boxes.",
        "floorMoved": "The counter changed while this form was open. Reload and try again.",
        "activeShift": "A shift opened while this form was open. Close it and try again.",
        "deviceOutOfSync": "A station fell out of sync. Reload and try again."
      }
    }
```

- [ ] **Step 4: Завести общий модуль**

Создать `apps/admin/src/lib/sscc-counter.ts`:

```ts
import type { TFunction } from "i18next";
import { ApiRequestError } from "../api/client";

/** Mirrors `apps/api/src/modules/sscc/dto.ts`'s `SsccSeedBlocker`. */
export type SsccSeedBlocker =
  | { kind: "active_shift"; shiftId: string; shiftNumber: string }
  | { kind: "device_out_of_sync"; deviceId: string; deviceName: string };

/** Mirrors `apps/api/src/modules/sscc/dto.ts`'s `SsccCounterStateDto`. */
export interface SsccCounterStateDto {
  extensionDigit: number;
  nextSerial: number;
  minSerial: number;
  blockedBy: SsccSeedBlocker | null;
}

/**
 * The sentence explaining why the counter is locked, or null when it isn't.
 * Shared by the organisation settings card and the counterparty panel: the
 * rule is one rule, and two copies of this text would drift.
 */
export function describeSsccBlocker(
  t: TFunction,
  blockedBy: SsccSeedBlocker | null,
): string | null {
  if (!blockedBy) return null;
  return blockedBy.kind === "active_shift"
    ? t("common.sscc.blocked.activeShift", { number: blockedBy.shiftNumber })
    : t("common.sscc.blocked.deviceOutOfSync", { device: blockedBy.deviceName });
}

/**
 * A save rejection, as a localized sentence. The server's own message is
 * English-only prose meant for logs; what reaches the operator is keyed off
 * the machine-readable `code` instead. Anything unrecognised falls back to
 * the caller's generic error text.
 */
export function describeSsccSeedError(
  t: TFunction,
  error: unknown,
  minSerial: number,
): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  switch (error.code) {
    case "sscc_seed_below_floor":
      return t("common.sscc.errors.belowFloor", { min: minSerial });
    case "sscc_seed_floor_moved":
      return t("common.sscc.errors.floorMoved");
    case "sscc_seed_active_shift":
      return t("common.sscc.errors.activeShift");
    case "sscc_seed_device_out_of_sync":
      return t("common.sscc.errors.deviceOutOfSync");
    default:
      return null;
  }
}
```

- [ ] **Step 5: Подключить в обе формы**

В `apps/admin/src/pages/settings/api.ts` и `apps/admin/src/pages/counterparties/api.ts` заменить локальные `interface SsccCounterDto` на:

```ts
export type { SsccCounterStateDto } from "../../lib/sscc-counter";

/** Mirrors `apps/api/src/modules/org-profile/dto.ts`'s `SsccCounterDto` -- the PUT body. */
export interface SsccCounterDto {
  extensionDigit: number;
  nextSerial: number;
}
```

и сменить тип результата у fetch-функций и `useOrgProfileSscc` / `useCounterpartySscc` на `SsccCounterStateDto` (PUT-функции продолжают принимать `SsccCounterDto`).

В `OrgProfileSsccCard` (`OrgProfilePage.tsx`):

- `const blocked = describeSsccBlocker(t, ssccQuery.data?.blockedBy ?? null);`
- `const minSerial = ssccQuery.data?.minSerial ?? 1;`
- у `<Input>` для `nextSerial` добавить `disabled={blocked !== null}`;
- под `<Input>` вывести подсказку, когда блокировки нет:
  ```tsx
  {
    blocked ? (
      <Alert tone="warning">{blocked}</Alert>
    ) : (
      <p style={{ font: "var(--text-caption)", color: "var(--fg-2)", margin: 0 }}>
        {t("common.sscc.nextLabelHint", { printed: minSerial - 1, min: minSerial })}
      </p>
    );
  }
  ```
  (если `Alert` не поддерживает tone `"warning"` — использовать тот tone, который в компоненте уже объявлен для предупреждений; проверить его тип, не изобретать новый);
- у кнопки `Сохранить`: `disabled={!derivedPrefix || blocked !== null}`;
- в `catch` submit'а:
  ```tsx
      } catch (error) {
        toast(
          "error",
          describeSsccSeedError(t, error, minSerial) ??
            (error instanceof ApiRequestError
              ? error.message
              : t("pages.settings.sscc.toasts.updateError")),
        );
        // The floor and the blocker both live server-side; a rejection means
        // this form's copy of them is stale.
        await ssccQuery.refetch();
      }
  ```

В `CounterpartySsccSection` (`CounterpartyForm.tsx`) — ровно те же пять правок, с той же вёрсткой подсказки/алерта, что и выше.

- [ ] **Step 6: Прогнать тесты админки**

```bash
pnpm --filter @markiro/admin test test/org-profile.test.tsx test/counterparties.test.tsx
pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint
```

Ожидаемо: PASS (в `counterparties.test.tsx` фикстуру счётчика тоже придётся дополнить полями `minSerial`/`blockedBy` — без них TypeScript и тесты упадут); typecheck и lint чистые.

- [ ] **Step 7: Коммит**

```bash
git add apps/admin/src apps/admin/test
git commit -m "feat(admin): surface the sscc counter floor, lock and localized errors"
```

---

### Task 8: Сквозная проверка и документация

**Files:**

- Modify: `docs/architecture.md` (раздел про SSCC, если он там есть)
- Test: полные наборы всех затронутых пакетов

**Interfaces:**

- Consumes: всё выше.
- Produces: ничего нового.

- [ ] **Step 1: Прогнать полные наборы**

```bash
set -a && . ./.env && set +a && pnpm --filter @markiro/db test && pnpm --filter @markiro/domain test && pnpm --filter @markiro/api test && pnpm --filter @markiro/station test && pnpm --filter @markiro/admin test
```

Ожидаемо: PASS во всех пяти. Отдельно убедиться, что e2e-файлы `sscc*.e2e.test.ts` и `shifts-bundle.e2e.test.ts` показали `passed`, а не `skipped`.

- [ ] **Step 2: Прогнать типы и линт по монорепо**

```bash
pnpm -r typecheck && pnpm -r lint
```

Ожидаемо: без ошибок.

- [ ] **Step 3: Обновить документацию**

Найти описание SSCC-нумерации:

```bash
grep -rn "sscc_blocks\|allocateForBundle" docs/*.md docs/runbooks/*.md
```

В найденных местах дописать: счётчик в настройках теперь применяется к следующей этикетке; сохранение отзывает выданные блоки; правка запрещена при активной смене и при станции, не выходившей на связь после закрытия последней смены. Если ни одного упоминания нет — шаг пропустить, документацию не заводить.

- [ ] **Step 4: Проверить на реальном стенде**

```bash
set -a && . ./.env && set +a && psql "$DATABASE_URL" -c "SELECT issuer_prefix, from_serial, to_serial, consumed_through_serial, revoked_at FROM sscc_blocks ORDER BY issued_at DESC LIMIT 10;"
```

Убедиться, что колонка есть и живые блоки имеют `revoked_at IS NULL`.

- [ ] **Step 5: Коммит**

```bash
git add -A
git commit -m "docs(sscc): describe counter reseed semantics"
```

---

## Замечания для исполнителя

- Задачи 1→5 строго последовательны (каждая опирается на предыдущую). Задачи 6 и 7 зависят от 5 и 4 соответственно, но между собой независимы.
- Задача 2 меняет смысл существующей проверки — если после неё падает тест, которого нет в списке правок, это сигнал, что где-то ещё есть неучтённая зависимость от старой границы. Разбираться, а не подгонять ожидание.
- Нигде не ослаблять `boxes_tenant_sscc_uq` и не глушить 23505 при ingest'е: два физических короба с одним SSCC — реальная проблема данных, её нельзя проглатывать.
