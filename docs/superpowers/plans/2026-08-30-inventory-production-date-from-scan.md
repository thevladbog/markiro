# Дата производства из сканируемого кода — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** При сканировании кода в инвентаризации станция подтягивает дату производства из снапшота: первый скан на терминале выставляет её молча, дальше расхождение выносится оператору, а спорный скан удерживается и не пишется в журнал.

**Architecture:** Чистая политика («какая дата следует из этого скана») живёт в `@markiro/domain` рядом с классификатором сканов. Станция читает `source_production_date` из зеркала снапшота, ставит проверку в `recordInventoryScanInternal` **до** резервирования события — в этой точке ещё не записано ничего, поэтому «отмена последнего шага» сводится к «не записывать». UI держит очередь сканов, показывает диалог и пересканирует тот же `raw` с новым `eventId`. Серверный контракт синхронизации не меняется.

**Tech Stack:** TypeScript, React 19, vitest, node:sqlite (`DatabaseSync`) в тестах, i18next, Playwright для галереи.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-08-30-inventory-production-date-from-scan-design.md`.
- `date-mismatch` **не** добавляется в `InventoryLocalVerdict` — этот enum отражает персистентные значения журнала.
- В `InventoryRepackScanResult.verdict` уже есть значение `"date-mismatch"` со смыслом «дата терминала ≠ дата короба». Новое значение называется `"source-date-mismatch"`. Старое не трогаем.
- Проверка запускается **только** для классификации `expected`. Для `duplicate`, `unknown`, `protected`, `known-ineligible`, `invalid` — не запускается.
- `source_production_date` в зеркале nullable: при `null` проверка не запускается.
- Спорный скан не пишет ни события, ни строки в `inventory_outbox`, ни проекции в `inventory_code_results_mirror`.
- Проверка диапазона `[productionDateFrom, productionDateTo]` — на стороне UI (там известен манифест). Журнал полагается на инвариант «`expected` ⇒ дата в диапазоне», заданный `classifyInventorySnapshotRow`.
- Каждая задача заканчивается зелёными `pnpm --filter <пакет> test` и `pnpm --filter <пакет> typecheck`.

---

### Task 1: Политика «дата из кода» в домене

**Files:**

- Modify: `packages/domain/src/inventory/scan.ts`
- Modify: `packages/domain/src/inventory/index.ts:28-36`
- Test: `packages/domain/test/inventory-scan.test.ts`

**Interfaces:**

- Consumes: ничего из предыдущих задач.
- Produces:
  - `InventoryScanSnapshotRow.sourceProductionDate: string | null` — новое обязательное поле интерфейса.
  - ```ts
    type InventoryScanSourceDate =
      | { kind: "none" }
      | { kind: "single"; scanKind: "item" | "known_box"; productionDate: string }
      | { kind: "mixed"; scanKind: "known_box" };

    function resolveInventoryScanSourceDate(
      classification: InventoryScanClassification,
      context: Pick<InventoryScanClassifierContext, "findSnapshotCode" | "findSnapshotChildren">,
    ): InventoryScanSourceDate;
    ```

- [ ] **Step 1: Добавить поле в `InventoryScanSnapshotRow`**

В `packages/domain/src/inventory/scan.ts` в интерфейс `InventoryScanSnapshotRow` (начинается на строке 7) добавить поле после `sourceState`:

```ts
export interface InventoryScanSnapshotRow {
  codeHash: string;
  canonicalRaw: string;
  gtin14: string;
  serial: string;
  sourceStatus: InventoryChzStatus;
  sourceState: string | null;
  /** Дата производства из снапшота. Для `expected` гарантированно не null. */
  sourceProductionDate: string | null;
  expected: boolean;
  protected: boolean;
  parentSscc: string | null;
}
```

- [ ] **Step 2: Прогнать типы, чтобы увидеть все точки, где строку конструируют**

Run: `pnpm --filter @markiro/domain typecheck`
Expected: FAIL — ошибки `Property 'sourceProductionDate' is missing` в `packages/domain/test/*` и/или в исходниках, конструирующих `InventoryScanSnapshotRow`. Это список мест для правки на шагах 3 и 6.

- [ ] **Step 3: Починить фикстуру доменных тестов**

В `packages/domain/test/inventory-scan.test.ts` в функции `row` (строка 19) добавить поле в возвращаемый объект после `sourceState: null,`:

```ts
    sourceProductionDate: "2026-08-20",
```

В `packages/domain/test/station-inventory-bundle.test.ts` и `packages/domain/test/inventory-snapshot.test.ts` поле `sourceProductionDate` уже присутствует — трогать не нужно. Если типизация укажет на другие файлы в `packages/domain`, добавить туда `sourceProductionDate: "2026-08-20"`.

- [ ] **Step 4: Написать падающие тесты политики**

В конец `packages/domain/test/inventory-scan.test.ts` добавить импорт в существующий блок из `../src/inventory/scan.js`:

```ts
import {
  classifyInventoryScan,
  resolveInventoryScanSourceDate,
  type InventoryLocalClaim,
  type InventoryScanSnapshotRow,
} from "../src/inventory/scan.js";
```

и новый describe-блок:

```ts
describe("inventory scan source production date", () => {
  function resolve(
    scannerRaw: string,
    rows: InventoryScanSnapshotRow[],
    claims: InventoryLocalClaim[] = [],
  ) {
    const rowsByHash = new Map(rows.map((item) => [item.codeHash, item]));
    return resolveInventoryScanSourceDate(classify(scannerRaw, rows, claims), {
      findSnapshotCode: (codeHash) => rowsByHash.get(codeHash) ?? null,
      findSnapshotChildren: (parentSscc) => rows.filter((item) => item.parentSscc === parentSscc),
    });
  }

  it("returns the item's own source date", () => {
    const expected = row("ITEM-1", { sourceProductionDate: "2026-08-21" });

    expect(resolve(raw("ITEM-1"), [expected])).toEqual({
      kind: "single",
      scanKind: "item",
      productionDate: "2026-08-21",
    });
  });

  it("returns none for a null source date", () => {
    const expected = row("ITEM-2", { sourceProductionDate: null });

    expect(resolve(raw("ITEM-2"), [expected])).toEqual({ kind: "none" });
  });

  it("returns none for a duplicate, an unknown, a protected and an ineligible code", () => {
    const claimed = row("ITEM-3", { sourceProductionDate: "2026-08-21" });
    const claim: InventoryLocalClaim = {
      codeHash: claimed.codeHash,
      eventId: "event-1",
      deviceId: "device-1",
      scannedAt: "2026-08-25T10:00:00.000Z",
    };
    const guarded = row("ITEM-4", {
      sourceProductionDate: "2026-08-21",
      sourceState: "MOVING_BY_UD",
      expected: false,
      protected: true,
    });
    const ineligible = row("ITEM-5", {
      sourceProductionDate: "2026-08-21",
      sourceStatus: "APPLIED",
      expected: false,
    });

    expect(resolve(raw("ITEM-3"), [claimed], [claim])).toEqual({ kind: "none" });
    expect(resolve(raw("ITEM-404"), [])).toEqual({ kind: "none" });
    expect(resolve(raw("ITEM-4"), [guarded])).toEqual({ kind: "none" });
    expect(resolve(raw("ITEM-5"), [ineligible])).toEqual({ kind: "none" });
  });

  it("returns the single date shared by a box's unclaimed expected children", () => {
    const rows = [
      row("BOX-1", { parentSscc: SSCC, sourceProductionDate: "2026-08-22" }),
      row("BOX-2", { parentSscc: SSCC, sourceProductionDate: "2026-08-22" }),
    ];

    expect(resolve(SSCC, rows)).toEqual({
      kind: "single",
      scanKind: "known_box",
      productionDate: "2026-08-22",
    });
  });

  it("reports a box whose unclaimed expected children disagree as mixed", () => {
    const rows = [
      row("BOX-3", { parentSscc: SSCC, sourceProductionDate: "2026-08-22" }),
      row("BOX-4", { parentSscc: SSCC, sourceProductionDate: "2026-08-23" }),
    ];

    expect(resolve(SSCC, rows)).toEqual({ kind: "mixed", scanKind: "known_box" });
  });

  it("ignores already-claimed and non-expected children when reading a box", () => {
    const claimed = row("BOX-5", { parentSscc: SSCC, sourceProductionDate: "2026-08-23" });
    const rows = [
      claimed,
      row("BOX-6", { parentSscc: SSCC, sourceProductionDate: "2026-08-22" }),
      row("BOX-7", {
        parentSscc: SSCC,
        sourceProductionDate: "2026-08-24",
        sourceStatus: "APPLIED",
        expected: false,
      }),
    ];
    const claim: InventoryLocalClaim = {
      codeHash: claimed.codeHash,
      eventId: "event-2",
      deviceId: "device-1",
      scannedAt: "2026-08-25T10:00:00.000Z",
    };

    expect(resolve(SSCC, rows, [claim])).toEqual({
      kind: "single",
      scanKind: "known_box",
      productionDate: "2026-08-22",
    });
  });
});
```

- [ ] **Step 5: Прогнать тесты и убедиться, что они падают**

Run: `pnpm --filter @markiro/domain exec vitest run test/inventory-scan.test.ts`
Expected: FAIL — `resolveInventoryScanSourceDate is not a function` / ошибка импорта.

- [ ] **Step 6: Реализовать политику**

В `packages/domain/src/inventory/scan.ts` в конец файла добавить:

```ts
export type InventoryScanSourceDate =
  | { kind: "none" }
  | { kind: "single"; scanKind: "item" | "known_box"; productionDate: string }
  | { kind: "mixed"; scanKind: "known_box" };

/**
 * Дата производства, которая следует из самого скана. Считается только для
 * `expected`: для дубля она уже зафиксирована победителем, у неизвестного кода
 * её нет, а подстройка активной даты под `protected`/`known-ineligible`
 * испортила бы дату всем последующим нормальным сканам.
 */
export function resolveInventoryScanSourceDate(
  classification: InventoryScanClassification,
  context: Pick<InventoryScanClassifierContext, "findSnapshotCode" | "findSnapshotChildren">,
): InventoryScanSourceDate {
  if (classification.kind !== "expected") return { kind: "none" };

  if (classification.scanKind === "item") {
    const row = context.findSnapshotCode(classification.codeHash);
    const productionDate = row?.sourceProductionDate ?? null;
    return productionDate === null
      ? { kind: "none" }
      : { kind: "single", scanKind: "item", productionDate };
  }

  const unclaimed = new Set(
    classification.children
      .filter((child) => child.firstWinning === null && child.originClassification === "expected")
      .map((child) => child.codeHash),
  );
  const dates = new Set<string>();
  for (const row of context.findSnapshotChildren(classification.sscc)) {
    if (!unclaimed.has(row.codeHash) || row.sourceProductionDate === null) continue;
    dates.add(row.sourceProductionDate);
  }
  if (dates.size === 0) return { kind: "none" };
  if (dates.size > 1) return { kind: "mixed", scanKind: "known_box" };
  const [productionDate] = [...dates];
  return { kind: "single", scanKind: "known_box", productionDate: productionDate! };
}
```

- [ ] **Step 7: Экспортировать из индекса пакета**

В `packages/domain/src/inventory/index.ts` изменить строку 28 и блок типов:

```ts
export { classifyInventoryScan, resolveInventoryScanSourceDate } from "./scan.js";
export type {
  InventoryBoxChildClassification,
  InventoryLocalClaim,
  InventoryOriginClassification,
  InventoryScanClassification,
  InventoryScanClassifierContext,
  InventoryScanSnapshotRow,
  InventoryScanSourceDate,
} from "./scan.js";
```

- [ ] **Step 8: Прогнать тесты и типы**

Run: `pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain typecheck`
Expected: PASS для обоих.

- [ ] **Step 9: Коммит**

```bash
git add packages/domain/src/inventory/scan.ts packages/domain/src/inventory/index.ts packages/domain/test/inventory-scan.test.ts
git commit -m "feat(domain): дата производства, следующая из скана инвентаризации"
```

---

### Task 2: Проверка даты в журнале станции

**Files:**

- Modify: `apps/station/src/lib/inventory-journal.ts`
- Modify: `apps/station/src/pages/InventoryWorkScreen.tsx:279-334` (минимальная адаптация вызывающей стороны)
- Test: `apps/station/test/inventory-journal.test.ts`

**Interfaces:**

- Consumes: `resolveInventoryScanSourceDate`, `InventoryScanSourceDate`, `InventoryScanSnapshotRow.sourceProductionDate` из Task 1.
- Produces:
  - ```ts
    interface InventoryScanDateMismatch {
      outcome: "date-mismatch";
      scanKind: "item" | "known_box";
      activeDate: string;
      /** null для смешанного короба — подставлять нечего. */
      codeDate: string | null;
      mixed: boolean;
    }

    type RecordInventoryScanOutcome =
      ({ outcome: "recorded" } & RecordInventoryScanResult) | InventoryScanDateMismatch;

    function recordInventoryScan(
      exec: SqlExecutor,
      input: RecordInventoryScanInput,
    ): Promise<RecordInventoryScanOutcome>;
    ```
  - `RecordInventoryScanInput.acceptSourceDateMismatch?: boolean` — обход проверки для «Зачесть как есть».

- [ ] **Step 1: Написать падающие тесты журнала**

В `apps/station/test/inventory-journal.test.ts` расширить хелпер `seedCode` (строка 31), чтобы дата кода задавалась: в объект `values` добавить `productionDate?: string`, а в `.run(...)` заменить жёстко заданный аргумент `"2026-08-20"` на `values.productionDate ?? "2026-08-20"`.

Затем добавить новый describe-блок в конец файла:

```ts
describe("inventory scan source production date guard", () => {
  it("adopts the code's date silently on the terminal's first scan", async () => {
    const { db, exec } = await setup();
    seedCode(db, "FIRST", { productionDate: "2026-08-22" });

    const outcome = await recordInventoryScan(
      exec,
      input(raw("FIRST"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    );

    expect(outcome).toMatchObject({ outcome: "recorded", verdict: "expected" });
    expect(
      await loadInventoryProductionDate(exec, {
        inventoryId: INVENTORY_ID,
        snapshotId: SNAPSHOT_ID,
        deviceId: DEVICE_ID,
      }),
    ).toBe("2026-08-22");
    const events = db
      .prepare("SELECT active_production_date FROM inventory_scan_events_mirror")
      .all() as { active_production_date: string }[];
    expect(events).toEqual([{ active_production_date: "2026-08-22" }]);
  });

  it("holds a later mismatching scan without writing anything", async () => {
    const { db, exec } = await setup();
    seedCode(db, "SAME", { productionDate: "2026-08-20" });
    seedCode(db, "OTHER", { productionDate: "2026-08-23" });
    await recordInventoryScan(exec, input(raw("SAME"), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));

    const outcome = await recordInventoryScan(
      exec,
      input(raw("OTHER"), "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    );

    expect(outcome).toEqual({
      outcome: "date-mismatch",
      scanKind: "item",
      activeDate: "2026-08-20",
      codeDate: "2026-08-23",
      mixed: false,
    });
    const held = db
      .prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror WHERE event_id = ?")
      .get("cccccccc-cccc-4ccc-8ccc-cccccccccccc") as { count: number };
    const outbox = db
      .prepare("SELECT COUNT(*) AS count FROM inventory_outbox WHERE event_id = ?")
      .get("cccccccc-cccc-4ccc-8ccc-cccccccccccc") as { count: number };
    const results = db
      .prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror")
      .get() as { count: number };
    expect(held.count).toBe(0);
    expect(outbox.count).toBe(0);
    expect(results.count).toBe(1);
  });

  it("records the held scan once the active date matches", async () => {
    const { db, exec } = await setup();
    seedCode(db, "SAME", { productionDate: "2026-08-20" });
    seedCode(db, "OTHER", { productionDate: "2026-08-23" });
    await recordInventoryScan(exec, input(raw("SAME"), "dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
    await recordInventoryScan(exec, input(raw("OTHER"), "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"));
    await setInventoryProductionDate(exec, {
      inventoryId: INVENTORY_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      operatorId: OPERATOR_ID,
      productionDate: "2026-08-23",
      updatedAt: "2026-08-25T10:05:00.000Z",
    });

    const outcome = await recordInventoryScan(
      exec,
      input(raw("OTHER"), "ffffffff-ffff-4fff-8fff-ffffffffffff"),
    );

    expect(outcome).toMatchObject({ outcome: "recorded", verdict: "expected" });
  });

  it("bypasses the guard when the operator accepts the mismatch", async () => {
    const { db, exec } = await setup();
    seedCode(db, "SAME", { productionDate: "2026-08-20" });
    seedCode(db, "OTHER", { productionDate: "2026-08-23" });
    await recordInventoryScan(exec, input(raw("SAME"), "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a"));

    const outcome = await recordInventoryScan(exec, {
      ...input(raw("OTHER"), "2b2b2b2b-2b2b-42b2-82b2-2b2b2b2b2b2b"),
      acceptSourceDateMismatch: true,
    });

    expect(outcome).toMatchObject({ outcome: "recorded", verdict: "expected" });
    const stored = db
      .prepare(
        "SELECT observed_production_date FROM inventory_code_results_mirror ORDER BY code_hash",
      )
      .all() as { observed_production_date: string }[];
    expect(stored).toContainEqual({ observed_production_date: "2026-08-20" });
  });

  it("reports a box whose children disagree as mixed", async () => {
    const { db, exec } = await setup();
    seedCode(db, "SAME", { productionDate: "2026-08-20" });
    seedCode(db, "CHILD-A", { parentSscc: SSCC, productionDate: "2026-08-21" });
    seedCode(db, "CHILD-B", { parentSscc: SSCC, productionDate: "2026-08-22" });
    await recordInventoryScan(exec, input(raw("SAME"), "3c3c3c3c-3c3c-43c3-83c3-3c3c3c3c3c3c"));

    const outcome = await recordInventoryScan(
      exec,
      input(SSCC, "4d4d4d4d-4d4d-44d4-84d4-4d4d4d4d4d4d"),
    );

    expect(outcome).toEqual({
      outcome: "date-mismatch",
      scanKind: "known_box",
      activeDate: "2026-08-20",
      codeDate: null,
      mixed: true,
    });
  });

  it("leaves protected, ineligible and unknown scans alone", async () => {
    const { db, exec } = await setup();
    seedCode(db, "SAME", { productionDate: "2026-08-20" });
    seedCode(db, "GUARDED", {
      state: "MOVING_BY_UD",
      expected: 0,
      protected: 1,
      productionDate: "2026-08-23",
    });
    seedCode(db, "STALE", { status: "APPLIED", expected: 0, productionDate: "2026-08-23" });
    await recordInventoryScan(exec, input(raw("SAME"), "5e5e5e5e-5e5e-45e5-85e5-5e5e5e5e5e5e"));

    await expect(
      recordInventoryScan(exec, input(raw("GUARDED"), "6f6f6f6f-6f6f-46f6-86f6-6f6f6f6f6f6f")),
    ).resolves.toMatchObject({ outcome: "recorded", verdict: "protected" });
    await expect(
      recordInventoryScan(exec, input(raw("STALE"), "7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a")),
    ).resolves.toMatchObject({ outcome: "recorded", verdict: "known-ineligible" });
    await expect(
      recordInventoryScan(exec, input(raw("MISSING"), "8b8b8b8b-8b8b-48b8-88b8-8b8b8b8b8b8b")),
    ).resolves.toMatchObject({ outcome: "recorded", verdict: "unknown" });
  });
});
```

- [ ] **Step 2: Прогнать тесты и убедиться, что они падают**

Run: `pnpm --filter @markiro/station exec vitest run test/inventory-journal.test.ts -t "source production date guard"`
Expected: FAIL — существующие вызовы возвращают объект без поля `outcome`, поэтому `toMatchObject({ outcome: "recorded" })` не сходится, а `date-mismatch` не возникает вовсе.

- [ ] **Step 3: Протащить колонку до классификатора**

В `apps/station/src/lib/inventory-journal.ts`:

в интерфейс `SnapshotDbRow` (строка 63) добавить поле после `source_state`:

```ts
source_production_date: string | null;
```

в функции `snapshotRow` в возвращаемый объект после `sourceState: row.source_state,` добавить:

```ts
    sourceProductionDate: row.source_production_date,
```

в `loadClassifierFacts` в **обоих** SELECT (строки 191 и 215) заменить список колонок на:

```sql
      `SELECT code_hash, canonical_raw, gtin14, serial, source_status, source_state,
              source_production_date, expected, protected, parent_sscc
```

- [ ] **Step 4: Добавить типы результата и обход проверки**

В `apps/station/src/lib/inventory-journal.ts` в блок импортов из `@markiro/domain` добавить:

```ts
  resolveInventoryScanSourceDate,
```

в `RecordInventoryScanInput` (строка 18) добавить последним полем:

```ts
  /** Оператор осознанно зачёл код с текущей активной датой. */
  acceptSourceDateMismatch?: boolean;
```

после интерфейса `RecordInventoryScanResult` добавить:

```ts
export interface InventoryScanDateMismatch {
  outcome: "date-mismatch";
  scanKind: "item" | "known_box";
  activeDate: string;
  /** null для смешанного короба — подставлять нечего. */
  codeDate: string | null;
  mixed: boolean;
}

export type RecordInventoryScanOutcome =
  ({ outcome: "recorded" } & RecordInventoryScanResult) | InventoryScanDateMismatch;
```

- [ ] **Step 5: Реализовать проверку**

В `apps/station/src/lib/inventory-journal.ts` в блок импортов добавить:

```ts
import { setInventoryProductionDate } from "./inventory-date.js";
```

перед `recordInventoryScanInternal` (строка 1319) добавить два хелпера:

```ts
async function hasDeviceScans(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<boolean> {
  const rows = await exec.all<{ present: number }>(
    `SELECT 1 AS present FROM inventory_scan_events_mirror
      WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?
      LIMIT 1`,
    [input.inventoryId, input.snapshotId, input.deviceId],
  );
  return rows.length > 0;
}

/**
 * Сверяет дату из снапшота с активной датой терминала до резервирования
 * события: в этой точке не записано ничего, поэтому «пропустить код» не
 * требует отката иммутабельного журнала.
 */
async function guardSourceProductionDate(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
  classification: InventoryScanClassification,
  facts: Awaited<ReturnType<typeof loadClassifierFacts>>,
): Promise<InventoryScanDateMismatch | null> {
  if (input.acceptSourceDateMismatch) return null;
  const source = resolveInventoryScanSourceDate(classification, {
    findSnapshotCode: (codeHash) => facts.rows.find((row) => row.codeHash === codeHash) ?? null,
    findSnapshotChildren: (parentSscc) => facts.rows.filter((row) => row.parentSscc === parentSscc),
  });
  if (source.kind === "none") return null;
  const active = await activeDate(exec, input);
  if (source.kind === "single") {
    if (source.productionDate === active) return null;
    if (!(await hasDeviceScans(exec, input))) {
      await setInventoryProductionDate(exec, {
        inventoryId: input.inventoryId,
        snapshotId: input.snapshotId,
        deviceId: input.deviceId,
        operatorId: input.operatorId,
        productionDate: source.productionDate,
        updatedAt: input.scannedAt,
      });
      return null;
    }
  }
  return {
    outcome: "date-mismatch",
    scanKind: source.scanKind,
    activeDate: active,
    codeDate: source.kind === "single" ? source.productionDate : null,
    mixed: source.kind === "mixed",
  };
}
```

- [ ] **Step 6: Встроить проверку и обернуть возвраты**

В `recordInventoryScanInternal` изменить сигнатуру и начало функции:

```ts
async function recordInventoryScanInternal(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<RecordInventoryScanOutcome> {
  if (!input.eventId) throw new Error("inventory event id is required");
  const facts = await loadClassifierFacts(exec, input);
  let classification = classifyFromFacts(input, facts);
  if (classification.kind === "invalid") {
    return { outcome: "recorded", ...resultFrom(classification, "invalid", 0, null) };
  }

  const mismatch = await guardSourceProductionDate(exec, input, classification, facts);
  if (mismatch) return mismatch;

  let event = await existingEvent(exec, input.inventoryId, input.snapshotId, input.eventId);
```

Дальше в теле функции обернуть оставшиеся три возврата.

Ветка уже закоммиченного события:

```ts
return { outcome: "recorded", ...resultFrom(classification, verdict, summary.total, winner) };
```

Повторная проверка после реконсиляции:

```ts
classification = classifyFromFacts(input, await loadClassifierFacts(exec, input));
if (classification.kind === "invalid") {
  return { outcome: "recorded", ...resultFrom(classification, "invalid", 0, null) };
}
```

Проверку даты здесь повторять не нужно — она уже пройдена на актуальных фактах.

Финальный возврат в конце функции:

```ts
return { outcome: "recorded", ...resultFrom(classification, verdict, summary.total, firstWinning) };
```

Изменить экспорт:

```ts
export function recordInventoryScan(
  exec: SqlExecutor,
  input: RecordInventoryScanInput,
): Promise<RecordInventoryScanOutcome> {
  return serializeJournal(() => recordInventoryScanInternal(exec, input));
}
```

- [ ] **Step 7: Прогнать тесты журнала**

Run: `pnpm --filter @markiro/station exec vitest run test/inventory-journal.test.ts`
Expected: PASS. Если падают старые тесты с `toEqual({ verdict: ... })`, обернуть ожидание в `toMatchObject({ outcome: "recorded", ... })` — поведение не изменилось, изменилась форма результата.

- [ ] **Step 8: Минимально адаптировать экран проверки**

В `apps/station/src/pages/InventoryWorkScreen.tsx` в импорт из `../lib/inventory-journal.js` добавить `type InventoryScanDateMismatch`.

В `CheckInventoryWorkScreen` перед `const refresh` добавить тип и состояние:

```ts
const [heldScan, setHeldScan] = useState<HeldInventoryScan | null>(null);
const heldRef = useRef(false);
const bypassRef = useRef<string | null>(null);
const queueRef = useRef<ScanQueue | null>(null);
```

а перед объявлением компонента (рядом с `EMPTY_PROGRESS`) добавить типы:

```ts
type HeldInventoryScan = InventoryScanDateMismatch & { raw: string };

type CheckScanOutcome = ({ outcome: "recorded" } & RecordInventoryScanResult) | HeldInventoryScan;
```

Переписать `useMemo` очереди (строка 279):

```ts
const queue = useMemo(
  () =>
    createScanQueue<CheckScanOutcome>({
      shouldProcess: () => !heldRef.current,
      process: async (raw) => {
        const bypass = bypassRef.current === raw;
        if (bypass) bypassRef.current = null;
        const outcome = await recordInventoryScan(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          taskGtin14: inventory.gtin14,
          raw,
          eventId: createEventId(),
          scannedAt: now(),
          ...(bypass ? { acceptSourceDateMismatch: true } : {}),
        });
        return outcome.outcome === "recorded" ? outcome : { ...outcome, raw };
      },
      onOutcome: (outcome) => {
        if (!mounted.current) return;
        setWriteFailed(false);
        if (outcome.outcome === "date-mismatch") {
          heldRef.current = true;
          queueRef.current?.discardBufferedScans();
          setHeldScan(outcome);
          return;
        }
        setResult(outcome);
        nudgeInventorySync();
        void refresh().catch((error: unknown) => {
          console.error("station: inventory progress refresh failed", error);
        });
      },
      onError: (_raw, error) => {
        console.error("station: inventory scan write failed", error);
        if (mounted.current) setWriteFailed(true);
      },
    }),
  [
    createEventId,
    deviceId,
    exec,
    inventory.gtin14,
    inventory.inventoryId,
    inventory.snapshotId,
    now,
    operatorId,
    refresh,
    nudgeInventorySync,
  ],
);
queueRef.current = queue;
```

В импорт `../lib/scan-queue.js` добавить `type ScanQueue`. В эффекте запуска сканера (строка 331) добавить `heldScan` в условие и в зависимости:

```ts
useEffect(() => {
  if (gallery || productionDate === null || dateDialog || heldScan) return undefined;
  return source.start((raw) => queue.enqueue(raw));
}, [dateDialog, gallery, heldScan, productionDate, queue, source]);
```

`setResult(outcome)` теперь получает объект с лишним полем `outcome: "recorded"` — это структурно совместимо с `RecordInventoryScanResult`, менять `setResult` не нужно.

- [ ] **Step 9: Прогнать весь пакет станции и типы**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/station typecheck`
Expected: PASS. Ожидаемо потребуется поправить форму ожиданий в `apps/station/test/inventory-mirror.test.ts` и других тестах, вызывающих `recordInventoryScan` напрямую — оборачивать в `toMatchObject({ outcome: "recorded", ... })`.

- [ ] **Step 10: Коммит**

```bash
git add apps/station/src/lib/inventory-journal.ts apps/station/src/pages/InventoryWorkScreen.tsx apps/station/test
git commit -m "feat(station): удержание скана при расхождении даты производства"
```

---

### Task 3: Диалог расхождения в простой инвентаризации

**Files:**

- Modify: `apps/station/src/pages/InventoryWorkScreen.tsx` (компонент `CheckInventoryWorkScreen`)
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json`
- Modify: `apps/station/src/dev/StationScreenGallery.tsx:370-455`
- Modify: `tools/production-browser/station-inventory-tests/gallery.spec.ts:13-28`
- Test: `apps/station/test/inventory-simple-work.test.tsx`

**Interfaces:**

- Consumes: `HeldInventoryScan`, `heldRef`, `bypassRef`, `queueRef` из Task 2.
- Produces: `InventoryWorkGalleryState` (ветка `mode: "check"`) получает поле `heldScan?: HeldInventoryScan | null`.

- [ ] **Step 1: Написать падающий тест диалога**

В `apps/station/test/inventory-simple-work.test.tsx` в фикстуре `fixture()` заменить жёстко заданную дату `'2026-08-19'` в INSERT на параметр строки. Список кортежей и INSERT становятся такими:

```ts
for (const [serial, sourceStatus, sourceState, expected, protectedFlag, productionDate] of [
  ["EXPECTED", "INTRODUCED", null, 1, 0, "2026-08-19"],
  ["PROTECTED", "INTRODUCED", "MOVING_BY_UD", 0, 1, "2026-08-19"],
  ["INELIGIBLE", "APPLIED", null, 0, 0, "2026-08-19"],
  ["NEXTDAY", "INTRODUCED", null, 1, 0, "2026-08-20"],
] as const) {
  const km = canonicalizeKm(raw(serial));
  db.prepare(
    `INSERT INTO inventory_snapshot_codes_mirror
       (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
        source_production_date, parent_sscc, expected, protected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    SNAPSHOT_ID,
    kmHash(km),
    km.raw,
    km.gtin14,
    km.serial,
    sourceStatus,
    sourceState,
    productionDate,
    expected,
    protectedFlag,
  );
}
```

Добавить тест в конец describe-блока:

```ts
  it("holds a mismatching scan, then counts it after the operator adopts the code's date", async () => {
    const { db, exec } = await fixture();
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-19', 1, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
    const scan = scanner();
    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
      />,
    );
    await waitFor(() => expect(scan.isListening()).toBe(true));

    scan.emit(raw("EXPECTED"));
    await waitFor(() => expect(screen.getByText("Код принят")).toBeTruthy());

    scan.emit(raw("NEXTDAY"));
    await waitFor(() =>
      expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy(),
    );
    expect(scan.isListening()).toBe(false);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror")
          .get() as { count: number }
      ).count,
    ).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /Установить/ }));

    await waitFor(() =>
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror")
            .get() as { count: number }
        ).count,
      ).toBe(2),
    );
    const stored = db
      .prepare(
        "SELECT active_production_date FROM inventory_terminal_state WHERE device_id = ?",
      )
      .get(DEVICE_ID) as { active_production_date: string };
    expect(stored.active_production_date).toBe("2026-08-20");
  });

  it("leaves nothing behind when the operator skips a mismatching code", async () => {
    const { db, exec } = await fixture();
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-19', 1, '2026-08-25T10:00:00.000Z')`,
    ).run(INVENTORY_ID, SNAPSHOT_ID, DEVICE_ID, OPERATOR_ID);
    const scan = scanner();
    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
      />,
    );
    await waitFor(() => expect(scan.isListening()).toBe(true));
    scan.emit(raw("EXPECTED"));
    await waitFor(() => expect(screen.getByText("Код принят")).toBeTruthy());
    scan.emit(raw("NEXTDAY"));
    await waitFor(() =>
      expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Пропустить код" }));

    await waitFor(() => expect(scan.isListening()).toBe(true));
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM inventory_scan_events_mirror")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    const stored = db
      .prepare(
        "SELECT active_production_date FROM inventory_terminal_state WHERE device_id = ?",
      )
      .get(DEVICE_ID) as { active_production_date: string };
    expect(stored.active_production_date).toBe("2026-08-19");
  });
```

- [ ] **Step 2: Прогнать тесты и убедиться, что они падают**

Run: `pnpm --filter @markiro/station exec vitest run test/inventory-simple-work.test.tsx -t "mismatching"`
Expected: FAIL — `Unable to find an element with the text: Дата в коде отличается от активной`.

- [ ] **Step 3: Добавить ключи локализации**

В `apps/station/src/i18n/ru.json` в объект `inventory.work` после ключа `"applyDate"` добавить:

```json
    "sourceDate": {
      "title": "Дата в коде отличается от активной",
      "body": "Код произведён {{code}}, активная дата — {{active}}.",
      "mixedTitle": "В коробе несколько дат розлива",
      "mixedBody": "Активная дата — {{active}}. Подставить одну дату нельзя.",
      "apply": "Установить {{date}} и зачесть",
      "accept": "Зачесть как есть",
      "skip": "Пропустить код",
      "outOfRange": "Дата кода вне диапазона задания."
    },
```

В `apps/station/src/i18n/en.json` в тот же объект:

```json
    "sourceDate": {
      "title": "The code's date differs from the active one",
      "body": "The code was produced on {{code}}; the active date is {{active}}.",
      "mixedTitle": "The box holds several production dates",
      "mixedBody": "The active date is {{active}}. No single date can be adopted.",
      "apply": "Set {{date}} and count",
      "accept": "Count as is",
      "skip": "Skip the code",
      "outOfRange": "The code's date is outside the task range."
    },
```

- [ ] **Step 4: Добавить обработчики и диалог**

В `CheckInventoryWorkScreen` после функции `applyDate` добавить:

```ts
const codeDateInRange =
  heldScan?.codeDate !== null &&
  heldScan !== null &&
  heldScan.codeDate >= inventory.productionDateFrom &&
  heldScan.codeDate <= inventory.productionDateTo;

const releaseHeldScan = () => {
  heldRef.current = false;
  setHeldScan(null);
};

const adoptHeldDate = async () => {
  const held = heldScan;
  if (!held || held.codeDate === null) return;
  const codeDate = held.codeDate;
  await new Promise<void>((resolve, reject) => {
    const accepted = queue.enqueueJob(async () => {
      try {
        await setInventoryProductionDate(exec, {
          inventoryId: inventory.inventoryId,
          snapshotId: inventory.snapshotId,
          deviceId,
          operatorId,
          productionDate: codeDate,
          updatedAt: now(),
        });
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("inventory date update failed"));
        throw error;
      }
    });
    if (!accepted) reject(new Error("inventory scan queue is closed"));
  });
  if (!mounted.current) return;
  setProductionDate(codeDate);
  setDateDraft(codeDate);
  releaseHeldScan();
  queue.enqueue(held.raw);
};

const acceptHeldScan = () => {
  const held = heldScan;
  if (!held) return;
  bypassRef.current = held.raw;
  releaseHeldScan();
  queue.enqueue(held.raw);
};
```

Перед закрывающим `</StationScreen>`, рядом с существующим `FullScreenDialog` даты, добавить второй диалог:

```tsx
<FullScreenDialog
  open={heldScan !== null}
  title={
    heldScan?.mixed
      ? t("inventory.work.sourceDate.mixedTitle")
      : t("inventory.work.sourceDate.title")
  }
  backLabel={t("inventory.work.sourceDate.skip")}
  onClose={releaseHeldScan}
  footer={
    heldScan?.mixed ? (
      <Button size="floor" onClick={acceptHeldScan}>
        {t("inventory.work.sourceDate.accept")}
      </Button>
    ) : codeDateInRange ? (
      <Button
        size="floor"
        onClick={() =>
          void adoptHeldDate().catch((error: unknown) => {
            console.error("station: inventory date adoption failed", error);
            if (mounted.current) {
              setWriteFailed(true);
              releaseHeldScan();
            }
          })
        }
      >
        {t("inventory.work.sourceDate.apply", {
          date: heldScan?.codeDate ? formatCivilDate(heldScan.codeDate, locale) : "",
        })}
      </Button>
    ) : null
  }
>
  <div className="inventory-date-dialog">
    <p>
      {heldScan?.mixed
        ? t("inventory.work.sourceDate.mixedBody", {
            active: heldScan ? formatCivilDate(heldScan.activeDate, locale) : "",
          })
        : t("inventory.work.sourceDate.body", {
            code: heldScan?.codeDate ? formatCivilDate(heldScan.codeDate, locale) : "",
            active: heldScan ? formatCivilDate(heldScan.activeDate, locale) : "",
          })}
    </p>
    {!heldScan?.mixed && !codeDateInRange ? (
      <p>{t("inventory.work.sourceDate.outOfRange")}</p>
    ) : null}
    <Button variant="secondary" size="floor" onClick={releaseHeldScan}>
      {t("inventory.work.sourceDate.skip")}
    </Button>
  </div>
</FullScreenDialog>
```

- [ ] **Step 5: Прогнать тесты экрана**

Run: `pnpm --filter @markiro/station exec vitest run test/inventory-simple-work.test.tsx`
Expected: PASS.

- [ ] **Step 6: Добавить кадр в галерею**

В `apps/station/src/pages/InventoryWorkScreen.tsx` в ветку `mode: "check"` типа `InventoryWorkGalleryState` добавить поле:

```ts
      heldScan?: HeldInventoryScan | null;
```

и в `CheckInventoryWorkScreen` изменить инициализацию состояния:

```ts
const [heldScan, setHeldScan] = useState<HeldInventoryScan | null>(gallery?.heldScan ?? null);
```

В `apps/station/src/dev/StationScreenGallery.tsx` в `InventoryFixture` (строка 371) добавить ветку перед `case "production-date-change":`:

```ts
    case "source-date-mismatch":
```

и в `SimpleInventoryFixture` в `galleryState` после `dateDialog:` добавить:

```ts
        heldScan:
          variant === "source-date-mismatch"
            ? {
                outcome: "date-mismatch",
                scanKind: "item",
                activeDate: GALLERY_INVENTORY_DATE,
                codeDate: "2026-08-18",
                mixed: false,
                raw: "gallery-held-scan",
              }
            : null,
```

В `tools/production-browser/station-inventory-tests/gallery.spec.ts` в список экранов (строки 13–28) после `"inventory-production-date-change",` добавить:

```ts
  "inventory-source-date-mismatch",
```

- [ ] **Step 7: Прогнать пакет станции и типы**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/station typecheck && pnpm --filter @markiro/station lint`
Expected: PASS для всех трёх.

- [ ] **Step 8: Коммит**

```bash
git add apps/station/src/pages/InventoryWorkScreen.tsx apps/station/src/i18n apps/station/src/dev/StationScreenGallery.tsx tools/production-browser/station-inventory-tests/gallery.spec.ts apps/station/test/inventory-simple-work.test.tsx
git commit -m "feat(station): диалог расхождения даты производства в простой инвентаризации"
```

---

### Task 4: Дата короба в перекладке

**Files:**

- Modify: `apps/station/src/lib/inventory-repacking.ts`
- Test: `apps/station/test/inventory-repacking-work.test.tsx` (фикстуры) и новые кейсы там же

**Interfaces:**

- Consumes: `InventoryScanSnapshotRow.sourceProductionDate` из Task 1.
- Produces:
  - `InventoryRepackScanResult.verdict` получает значение `"source-date-mismatch"`.
  - `InventoryRepackScanResult.sourceProductionDate: string | null` — дата из кода для диалога.
  - `RecordInventoryRepackScanInput.acceptSourceDateMismatch?: boolean`.

- [ ] **Step 1: Написать падающий тест**

В `apps/station/test/inventory-repacking-work.test.tsx` тесты не разделяют фикстуру — каждый строит свою базу. Добавить в конец describe-блока самодостаточный тест:

```ts
  it("opens the new box with the production date shared by the old box contents", async () => {
    const db = new DatabaseSync(":memory:");
    const exec = makeExec(db);
    await applyMigrations(exec);
    db.prepare(
      "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'IVN-26-0043', ?)",
    ).run(INVENTORY_ID, SNAPSHOT_ID);
    db.prepare(
      `INSERT INTO sscc_pool
         (issuer_prefix, extension_digit, from_serial, to_serial, next_serial)
       VALUES ('460068200', 0, 1, 100, 1)`,
    ).run();
    const km = canonicalizeKm(`01${GTIN}21REPACK-SEED`);
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
          source_production_date, parent_sscc, expected, protected)
       VALUES (?, ?, ?, ?, ?, 'INTRODUCED', '2026-08-21', ?, 1, 0)`,
    ).run(SNAPSHOT_ID, kmHash(km), km.raw, GTIN, km.serial, OLD_SSCC);
    const scan = scanner();

    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
        createEventId={() => crypto.randomUUID()}
        now={() => "2026-08-25T10:00:01.000Z"}
      />,
    );
    await waitFor(() => expect(scan.active()).toBe(true));

    scan.emit(OLD_SSCC);

    await waitFor(() => {
      const box = db
        .prepare("SELECT production_date FROM inventory_repack_boxes_mirror LIMIT 1")
        .get() as { production_date: string } | undefined;
      expect(box?.production_date).toBe("2026-08-21");
    });
    const terminal = db
      .prepare("SELECT active_production_date FROM inventory_terminal_state WHERE device_id = ?")
      .get(DEVICE_ID) as { active_production_date: string };
    expect(terminal.active_production_date).toBe("2026-08-21");
  });
```

- [ ] **Step 2: Прогнать тест и убедиться, что он падает**

Run: `pnpm --filter @markiro/station exec vitest run test/inventory-repacking-work.test.tsx -t "opens the new box with the production date"`
Expected: FAIL — `expected '2026-08-19' to be '2026-08-21'`: короб открывается с активной датой терминала, которая пришла из `manifest.productionDateFrom`.

- [ ] **Step 3: Протащить колонку и расширить типы**

В `apps/station/src/lib/inventory-repacking.ts`:

в интерфейс `SnapshotRow` (строка ~88) добавить после `source_state`:

```ts
source_production_date: string | null;
```

в `snapshotFacts` в SELECT (строка 355) добавить колонку:

```sql
    `SELECT code_hash, canonical_raw, gtin14, serial, source_status, source_state,
            source_production_date, expected, protected, parent_sscc
```

и в маппинг после `sourceState: row.source_state,`:

```ts
          sourceProductionDate: row.source_production_date,
```

в `RecordInventoryRepackScanInput` добавить последним полем:

```ts
  /** Оператор осознанно зачёл код с текущей датой короба. */
  acceptSourceDateMismatch?: boolean;
```

в `InventoryRepackScanResult` добавить значение вердикта и поле:

```ts
export interface InventoryRepackScanResult {
  verdict:
    | "old-box-selected"
    | "expected"
    | "protected"
    | "known-ineligible"
    | "unknown"
    | "duplicate"
    | "invalid"
    | "date-mismatch"
    | "source-date-mismatch"
    | "capacity-closed";
  boxId: string | null;
  newSscc: string | null;
  itemCount: number;
  printState: InventoryRepackBoxView["printState"] | null;
  sourceParentMismatch: boolean;
  /** Дата из снапшота для спорного кода; null во всех остальных вердиктах. */
  sourceProductionDate: string | null;
}
```

Во всех существующих `return { verdict: ..., ... }` внутри `recordInternal` и в `replayResult` добавить `sourceProductionDate: null`.

- [ ] **Step 4: Засеять дату нового короба из старого**

В `apps/station/src/lib/inventory-repacking.ts` добавить импорт:

```ts
import { setInventoryProductionDate } from "./inventory-date.js";
```

и хелпер рядом с `snapshotFacts`:

```ts
/** Одна дата, общая для пригодного содержимого старого короба, иначе null. */
async function oldBoxSourceDate(
  exec: SqlExecutor,
  input: RecordInventoryRepackScanInput,
  oldSscc: string,
): Promise<string | null> {
  const rows = await exec.all<{ source_production_date: string }>(
    `SELECT DISTINCT source_production_date
       FROM inventory_snapshot_codes_mirror
      WHERE snapshot_id = ? AND parent_sscc = ? AND expected = 1 AND protected = 0
        AND source_production_date IS NOT NULL`,
    [input.snapshotId, oldSscc],
  );
  return rows.length === 1 ? (rows[0]?.source_production_date ?? null) : null;
}
```

В ветке `state.phase === "awaiting-old-box"` в `recordInternal` после получения `oldSscc` и до `burnSerial` вставить:

```ts
const seeded = await oldBoxSourceDate(exec, input, oldSscc);
const boxDate = seeded ?? terminalState.active_production_date!;
if (seeded !== null && seeded !== terminalState.active_production_date) {
  await setInventoryProductionDate(exec, {
    inventoryId: input.inventoryId,
    snapshotId: input.snapshotId,
    deviceId: input.deviceId,
    operatorId: input.operatorId,
    productionDate: seeded,
    updatedAt: input.scannedAt,
  });
}
```

и в этой же ветке заменить три использования даты: в `repack` — `productionDate: boxDate`, в `inventoryEventSchema.parse` — `activeProductionDate: boxDate`, в `writeJournal` — `productionDate: boxDate`.

- [ ] **Step 5: Добавить поштучную проверку**

В `recordInternal` сразу после early-return `if (classification.kind === "invalid" || classification.scanKind !== "item")` вставить:

```ts
const sourceDate = facts.row?.sourceProductionDate ?? null;
if (
  !input.acceptSourceDateMismatch &&
  classification.kind === "expected" &&
  sourceDate !== null &&
  sourceDate !== box.productionDate
) {
  return {
    verdict: "source-date-mismatch",
    boxId: box.boxId,
    newSscc: box.newSscc,
    itemCount: box.itemCount,
    printState: box.printState,
    sourceParentMismatch: false,
    sourceProductionDate: sourceDate,
  };
}
```

- [ ] **Step 6: Прогнать тесты перекладки**

Run: `pnpm --filter @markiro/station exec vitest run test/inventory-repacking-work.test.tsx test/inventory-repacking.test.ts`
Expected: PASS. Если существующие тесты ожидают `toEqual` на результате скана, добавить `sourceProductionDate: null` в ожидания.

- [ ] **Step 7: Коммит**

```bash
git add apps/station/src/lib/inventory-repacking.ts apps/station/test/inventory-repacking-work.test.tsx
git commit -m "feat(station): дата нового короба из содержимого старого и проверка даты кода"
```

---

### Task 5: Диалог расхождения в перекладке

**Files:**

- Modify: `apps/station/src/pages/InventoryWorkScreen.tsx` (компонент `RepackInventoryWorkScreen`)
- Modify: `apps/station/src/ui/inventory/RepackBoxInstrument.tsx:11-26,47-55`
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json`
- Test: `apps/station/test/inventory-repacking-work.test.tsx`

**Interfaces:**

- Consumes: вердикт `"source-date-mismatch"` и поле `sourceProductionDate` из Task 4; ключи `inventory.work.sourceDate.*` из Task 3.
- Produces: ничего для последующих задач.

- [ ] **Step 1: Написать падающий тест**

В `apps/station/test/inventory-repacking-work.test.tsx` добавить самодостаточный тест. Старый короб намеренно содержит две разные даты, поэтому засеивание из Task 4 не срабатывает и короб открывается с датой терминала `2026-08-19` — это и создаёт расхождение на первой бутылке:

```ts
  it("adopts the code's date into an empty repack box", async () => {
    const db = new DatabaseSync(":memory:");
    const exec = makeExec(db);
    await applyMigrations(exec);
    db.prepare(
      "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'IVN-26-0043', ?)",
    ).run(INVENTORY_ID, SNAPSHOT_ID);
    db.prepare(
      `INSERT INTO sscc_pool
         (issuer_prefix, extension_digit, from_serial, to_serial, next_serial)
       VALUES ('460068200', 0, 1, 100, 1)`,
    ).run();
    for (const [serial, productionDate] of [
      ["REPACK-MIX-A", "2026-08-21"],
      ["REPACK-MIX-B", "2026-08-22"],
    ] as const) {
      const km = canonicalizeKm(`01${GTIN}21${serial}`);
      db.prepare(
        `INSERT INTO inventory_snapshot_codes_mirror
           (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
            source_production_date, parent_sscc, expected, protected)
         VALUES (?, ?, ?, ?, ?, 'INTRODUCED', ?, ?, 1, 0)`,
      ).run(SNAPSHOT_ID, kmHash(km), km.raw, GTIN, km.serial, productionDate, OLD_SSCC);
    }
    const scan = scanner();

    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
        createEventId={() => crypto.randomUUID()}
        now={() => "2026-08-25T10:00:01.000Z"}
      />,
    );
    await waitFor(() => expect(scan.active()).toBe(true));
    scan.emit(OLD_SSCC);
    await waitFor(() =>
      expect(screen.getByTestId("repack-count").textContent).toContain("0 / 20"),
    );

    scan.emit(canonicalizeKm(`01${GTIN}21REPACK-MIX-A`).raw);

    await waitFor(() =>
      expect(screen.getByText("Дата в коде отличается от активной")).toBeTruthy(),
    );
    expect(scan.active()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Установить/ }));

    await waitFor(() =>
      expect(screen.getByTestId("repack-count").textContent).toContain("1 / 20"),
    );
    const box = db
      .prepare("SELECT production_date FROM inventory_repack_boxes_mirror LIMIT 1")
      .get() as { production_date: string };
    expect(box.production_date).toBe("2026-08-21");
  });

  it("offers only skip and corrections when the repack box is not empty", async () => {
    const db = new DatabaseSync(":memory:");
    const exec = makeExec(db);
    await applyMigrations(exec);
    db.prepare(
      "INSERT INTO inventory_task_mirror (inventory_id, inventory_number, active_snapshot_id) VALUES (?, 'IVN-26-0043', ?)",
    ).run(INVENTORY_ID, SNAPSHOT_ID);
    db.prepare(
      `INSERT INTO sscc_pool
         (issuer_prefix, extension_digit, from_serial, to_serial, next_serial)
       VALUES ('460068200', 0, 1, 100, 1)`,
    ).run();
    for (const [serial, productionDate] of [
      ["REPACK-KEEP", "2026-08-19"],
      ["REPACK-OTHER", "2026-08-22"],
    ] as const) {
      const km = canonicalizeKm(`01${GTIN}21${serial}`);
      db.prepare(
        `INSERT INTO inventory_snapshot_codes_mirror
           (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
            source_production_date, parent_sscc, expected, protected)
         VALUES (?, ?, ?, ?, ?, 'INTRODUCED', ?, ?, 1, 0)`,
      ).run(SNAPSHOT_ID, kmHash(km), km.raw, GTIN, km.serial, productionDate, OLD_SSCC);
    }
    const scan = scanner();

    render(
      <InventoryWorkScreen
        exec={exec}
        inventory={manifest}
        deviceId={DEVICE_ID}
        operatorId={OPERATOR_ID}
        source={scan.source}
        createEventId={() => crypto.randomUUID()}
        now={() => "2026-08-25T10:00:01.000Z"}
      />,
    );
    await waitFor(() => expect(scan.active()).toBe(true));
    scan.emit(OLD_SSCC);
    scan.emit(canonicalizeKm(`01${GTIN}21REPACK-KEEP`).raw);
    await waitFor(() =>
      expect(screen.getByTestId("repack-count").textContent).toContain("1 / 20"),
    );

    scan.emit(canonicalizeKm(`01${GTIN}21REPACK-OTHER`).raw);

    await waitFor(() =>
      expect(
        screen.getByText("В коробе уже есть бутылки другой даты. Закройте или очистите короб."),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /Установить/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Пропустить код" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Пропустить код" }));

    await waitFor(() => expect(scan.active()).toBe(true));
    expect(screen.getByTestId("repack-count").textContent).toContain("1 / 20");
  });
```

- [ ] **Step 2: Прогнать тесты и убедиться, что они падают**

Run: `pnpm --filter @markiro/station exec vitest run test/inventory-repacking-work.test.tsx -t "repack box"`
Expected: FAIL — `Unable to find an element with the text: Дата в коде отличается от активной`.

- [ ] **Step 3: Добавить ключи локализации**

В `apps/station/src/i18n/ru.json` в объект `inventory.repack` добавить:

```json
    "sourceDateBlocked": "В коробе уже есть бутылки другой даты. Закройте или очистите короб.",
    "sourceDateMismatch": "Дата кода не совпадает с датой короба",
```

В `apps/station/src/i18n/en.json` в тот же объект:

```json
    "sourceDateBlocked": "The box already holds bottles of another date. Close or clear it.",
    "sourceDateMismatch": "The code's date differs from the box date",
```

- [ ] **Step 4: Показать вердикт в инструменте короба**

В `apps/station/src/ui/inventory/RepackBoxInstrument.tsx` в `labels` добавить поле после `discrepancy`:

```ts
sourceDateMismatch: string;
```

и изменить вычисление `verdict` (строка 47):

```ts
const verdict = writeFailed
  ? labels.writeFailed
  : result?.verdict === "old-box-selected"
    ? labels.oldSelected
    : result?.verdict === "expected" || result?.verdict === "capacity-closed"
      ? labels.accepted
      : result?.verdict === "source-date-mismatch"
        ? labels.sourceDateMismatch
        : result
          ? labels.discrepancy
          : null;
```

В `RepackInventoryWorkScreen` в объект `labels` для `RepackBoxInstrument` добавить:

```tsx
                sourceDateMismatch: t("inventory.repack.sourceDateMismatch"),
```

- [ ] **Step 5: Удерживать скан и показать диалог**

В `RepackInventoryWorkScreen` добавить рядом с прочими состояниями:

```ts
const [heldScan, setHeldScan] = useState<HeldRepackScan | null>(gallery?.heldScan ?? null);
const heldRef = useRef(false);
const bypassRef = useRef<string | null>(null);
const queueRef = useRef<ScanQueue | null>(null);
const boxDateRef = useRef("");
```

а рядом с `EMPTY_REPACK_STATE` — тип:

```ts
type HeldRepackScan = { raw: string; activeDate: string; codeDate: string };
```

Дату открытого короба читать через ref, а не через захваченное состояние: `state` меняется на каждом `refresh()`, и если положить его в зависимости `useMemo`, очередь сканов будет пересоздаваться на каждом скане, а эффект `queue.open()` / `queue.close()` — дёргаться вместе с ней. Сразу после объявления `refresh` добавить:

```ts
boxDateRef.current = state.box?.productionDate ?? "";
```

В `useMemo` очереди перекладки добавить `shouldProcess`, обход и перехват:

```ts
        shouldProcess: () => !heldRef.current,
        process: async (raw) => {
          const bypass = bypassRef.current === raw;
          if (bypass) bypassRef.current = null;
          return recordInventoryRepackScan(exec, {
            inventoryId: inventory.inventoryId,
            snapshotId: inventory.snapshotId,
            deviceId,
            operatorId,
            taskGtin14: inventory.gtin14,
            issuerPrefix: inventory.sscc?.issuerPrefix ?? "",
            capacity: inventory.boxCapacity,
            raw,
            eventId: createEventId(),
            scannedAt: now(),
            ...(bypass ? { acceptSourceDateMismatch: true } : {}),
          }).then((outcome) => ({ outcome, raw }));
        },
        onOutcome: ({ outcome, raw }) => {
          if (!mounted.current) return;
          if (outcome.verdict === "source-date-mismatch" && outcome.sourceProductionDate) {
            heldRef.current = true;
            queueRef.current?.discardBufferedScans();
            setResult(outcome);
            setHeldScan({
              raw,
              activeDate: boxDateRef.current,
              codeDate: outcome.sourceProductionDate,
            });
            return;
          }
          if (outcome.verdict === "old-box-selected") {
            setPrintResult(null);
            setProvisionalPrintFailure(null);
          }
          if (outcome.verdict === "capacity-closed") setPrintBusy(true);
          setResult(outcome);
          setWriteFailed(false);
          nudge();
          void refresh();
        },
```

Тип очереди меняется на `createScanQueue<{ outcome: InventoryRepackScanResult; raw: string }>`. После `useMemo` добавить `queueRef.current = queue;`. Список зависимостей `useMemo` не расширять — дата короба читается через `boxDateRef`.

В эффекте запуска сканера добавить `heldScan` в условие и зависимости — рядом с `dateDialog` и `correctionsDialog`.

Добавить обработчики после `applyDate`:

```ts
const releaseHeldScan = () => {
  heldRef.current = false;
  setHeldScan(null);
};

const adoptHeldDate = async () => {
  const held = heldScan;
  if (!held || !state.box || state.box.itemCount > 0) return;
  await new Promise<void>((resolve, reject) => {
    if (
      !queue.enqueueJob(async () => {
        try {
          await changeOpenInventoryRepackDate(exec, {
            inventoryId: inventory.inventoryId,
            snapshotId: inventory.snapshotId,
            deviceId,
            operatorId,
            eventId: createEventId(),
            changedAt: now(),
            productionDate: held.codeDate,
          });
          await setInventoryProductionDate(exec, {
            inventoryId: inventory.inventoryId,
            snapshotId: inventory.snapshotId,
            deviceId,
            operatorId,
            productionDate: held.codeDate,
            updatedAt: now(),
          });
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error("repack date adoption failed"));
          throw error;
        }
      })
    ) {
      reject(new Error("inventory scan queue is closed"));
    }
  });
  nudge();
  await refresh();
  if (!mounted.current) return;
  setProductionDate(held.codeDate);
  setDateDraft(held.codeDate);
  releaseHeldScan();
  queue.enqueue(held.raw);
};
```

И диалог перед закрывающим `</StationScreen>`:

```tsx
<FullScreenDialog
  open={heldScan !== null}
  title={t("inventory.work.sourceDate.title")}
  backLabel={t("inventory.work.sourceDate.skip")}
  onClose={releaseHeldScan}
  footer={
    state.box && state.box.itemCount === 0 ? (
      <Button
        size="floor"
        onClick={() =>
          void adoptHeldDate().catch((error: unknown) => {
            console.error("station: repack date adoption failed", error);
            if (mounted.current) {
              setWriteFailed(true);
              releaseHeldScan();
            }
          })
        }
      >
        {t("inventory.work.sourceDate.apply", {
          date: heldScan ? formatCivilDate(heldScan.codeDate, locale) : "",
        })}
      </Button>
    ) : null
  }
>
  <div className="inventory-date-dialog">
    <p>
      {t("inventory.work.sourceDate.body", {
        code: heldScan ? formatCivilDate(heldScan.codeDate, locale) : "",
        active: heldScan ? formatCivilDate(heldScan.activeDate, locale) : "",
      })}
    </p>
    {state.box && state.box.itemCount > 0 ? <p>{t("inventory.repack.sourceDateBlocked")}</p> : null}
    <Button variant="secondary" size="floor" onClick={releaseHeldScan}>
      {t("inventory.work.sourceDate.skip")}
    </Button>
    {state.box && state.box.itemCount > 0 ? (
      <Button
        variant="secondary"
        size="floor"
        onClick={() => {
          releaseHeldScan();
          setCorrectionsDialog(true);
        }}
      >
        {t("inventory.repack.corrections")}
      </Button>
    ) : null}
  </div>
</FullScreenDialog>
```

В ветку `mode: "repack"` типа `InventoryWorkGalleryState` добавить `heldScan?: HeldRepackScan | null;`. В импорт из `../lib/inventory-date.js` добавить `setInventoryProductionDate`, если его там ещё нет.

- [ ] **Step 6: Прогнать всё**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/station typecheck && pnpm --filter @markiro/station lint`
Expected: PASS для всех трёх.

- [ ] **Step 7: Прогнать репозиторий целиком**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Ожидаемые точки правки за пределами станции — фикстуры `InventoryScanSnapshotRow` в `packages/domain`.

- [ ] **Step 8: Коммит**

```bash
git add apps/station/src/pages/InventoryWorkScreen.tsx apps/station/src/ui/inventory/RepackBoxInstrument.tsx apps/station/src/i18n apps/station/test/inventory-repacking-work.test.tsx
git commit -m "feat(station): диалог расхождения даты производства в перекладке"
```
