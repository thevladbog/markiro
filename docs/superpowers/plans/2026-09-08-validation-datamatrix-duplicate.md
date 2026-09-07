# Проверка продукции с дублированием Data Matrix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Печатать одну внешнюю этикетку с полным кодом принятой единицы, с настраиваемой обязательностью контрольного сканирования и восстановлением после сбоя.

**Architecture:** Сохранить `validation` и `aggregation`; добавить политику печати к проверке. На станции атомарно сохранять приёмку и задание до обращения к принтеру, отдельно вести неизменяемые события попыток и проверки. Доставлять историю через существующий `POST /station/scans`, сохраняя офлайн-работу и совместимость обычных смен.

**Tech Stack:** TypeScript, React/Vite, NestJS, Zod 4, Drizzle/Postgres, SQLite через Tauri SQL, существующие `bwip-js`, ZPL/TSPL и аппаратный транспорт, Vitest, Playwright.

**Spec:** [Согласованная спецификация](../specs/2026-09-08-validation-datamatrix-duplicate-design.md). Прочитать целиком до реализации. Основа проверки исходников: HEAD `95e7673d4`; перед исполнением сверить изменения после него.

## Global Constraints

- «Внутри внешней упаковки находится одна товарная единица». Нового кода и новой принятой единицы при печати нет.
- «Два вида операций сохраняются»: `validation`, `aggregation`.
- Печать: `none | duplicate_dm`. Проверка этикетки: `none | required`.
- «Печать и обязательность контрольного сканирования настраиваются при создании смены как в кабинете, так и оператором на станции».
- «Режим, обязательность проверки и снимок шаблона редактируются только у плановой смены».
- «На станции одновременно допускается одно незавершённое задание этой операции».
- «Повторный обычный скан уже принятого товара сам по себе не печатает ничего».
- «Полный код и байты принтера не выводятся в интерфейс, консоль, сетевые ошибки и общую телеметрию».
- «`not_required` не превращается в `verified`». `print()` означает результат отправки, а не физическое подтверждение.
- «Многошаговые `BEGIN/COMMIT` через пул Tauri SQL недопустимы». Локальные составные изменения — один statement с триггером.
- Кабинет 1920×1080, станция 1280×800; `packages/ui`, IBM Plex, RU/EN, офлайн-ресурсы. Станция: без прокрутки страницы, основные действия не меньше 64 px.
- `.pen` — только Pencil MCP. Согласованный файл: `docs/design-briefs/check_with_reprint.pen`; файлы соседних дизайн-задач не менять.
- Node >=24, Corepack и версия pnpm из repository manifest. Новых зависимостей план не требует; lockfile вручную не редактировать.
- Серверные записи tenant-scoped; device/terminal определяются аутентификацией. Badge/PIN/ключи не включать в события и тестовые выводы.
- Печатный путь нового сценария TSPL — GS1-растр и `BITMAP`; старые шаблоны не переводить на него автоматически. ZPL нового сценария использует тот же растр через ^GFA: тест обнаружил несовместимую семантику размера в старом native-пути; старые вызовы не меняются.
- Перед кодом — актуальный `git status`, чтение AGENTS.md, отдельная ветка/worktree через `using-git-worktrees` при изоляции. Этот план не разрешает push, PR или production deploy.

---

## Порядок исполнения и границы файлов

Это один связанный производственный сценарий, а не несколько независимых сервисов.
Каждая задача ниже имеет свой проверяемый результат и отдельный commit. Частичные
этапы можно интегрировать с выключенным созданием нового режима; включать режим до
завершения задач 1–16 нельзя.

| Задача | Результат                                                     | Зависит от |
| ------ | ------------------------------------------------------------- | ---------- |
| 1      | Полный KM, политика, общий контракт событий                   | —          |
| 2      | Назначение шаблона и GS1-растр                                | 1          |
| 3      | Чистые переходы попытки и задания                             | 1          |
| 4      | Postgres-схема, миграция, исходный шаблон                     | 1, 2       |
| 5      | SQLite-схема и атомарная приёмка                              | 1, 2, 3    |
| 6      | API библиотеки шаблонов                                       | 2, 4       |
| 7      | API политики смены и совместимость станции                    | 4, 6       |
| 8      | Печатный контекст и зеркало станции                           | 2, 5, 7    |
| 9      | Попытки печати, проверка и восстановление                     | 3, 5, 8    |
| 10     | Серверная доставка событий                                    | 3, 4, 7    |
| 11     | Клиентская доставка, ACK и карантин                           | 5, 9, 10   |
| 12     | Библиотека и создание смены в кабинете                        | 6, 7       |
| 13     | Создание смены оператором                                     | 7, 8       |
| 14     | Рабочий экран, пауза, reprint, закрытие и credential recovery | 9, 11, 13  |
| 15     | История в кабинете и безопасная очистка                       | 10, 11, 14 |
| 16     | Браузер, hardware-приёмка и порядок выпуска                   | 1–15       |

Новые domain-файлы живут в `packages/domain/src/product-labels/`: `contracts.ts`
описывает протокол, `km.ts` сравнивает полный код, `state.ts` вычисляет состояние.
Печатная геометрия остаётся в `labels/` и `barcodes/`.

На станции `lib/product-labels/acceptance.ts` отвечает только за запись приёмки;
`store.ts` — за чтение и запись событий; `fields.ts` — за зафиксированные печатные
поля; `printing.ts` — за последовательность работы с транспортом; `sync.ts` — за
новый канал outbox; `recovery.ts` — за поиск незавершённого и очистку. UI не читает
эти таблицы напрямую. Не переносить весь `WorkScreen` или старую печать коробов.

API: новая схема `packages/db/src/schema/product-labels.ts`; новые обработчики
внутри существующих `modules/shifts/` и `modules/station-scans/`. Не создавать
общую платформу очередей/рендеринга. В `packages/platform-contracts` дубли этих
типов не добавлять: текущий station-протокол уже использует `@markiro/domain`.

## Имена и типы, общие для всех задач

Следующие определения реализуются в задаче 1 и импортируются всеми потребителями.
Схемы Zod должны точно соответствовать типам и быть strict на новых объектах.
Отсутствие `validationPrint` допустимо только на старой границе и означает `none`;
повреждённый новый объект не заменять значением по умолчанию.

```ts
import type { LabelTemplateSpec } from "../labels/model.js";

export type VerificationPolicy = "none" | "required";
export type LabelTemplatePurpose = "box" | "product_duplicate";
export type ReprintReason = "not_printed" | "damaged" | "lost";
export type PrinterLanguage = "zpl" | "tspl";

export type ValidationPrintInput =
  { mode: "none" } | { mode: "duplicate_dm"; verification: VerificationPolicy; templateId: string };

export interface DuplicateTemplateSnapshot {
  id: string;
  name: string;
  spec: LabelTemplateSpec;
  digest: string;
}

export type ValidationPrintPolicy =
  | {
      mode: "none";
      verification: "none";
      templateId: null;
      snapshot: null;
      policyRevision: null;
    }
  | {
      mode: "duplicate_dm";
      verification: VerificationPolicy;
      templateId: string;
      snapshot: DuplicateTemplateSnapshot;
      policyRevision: string;
    };

export type EnabledValidationPrintPolicy = Extract<ValidationPrintPolicy, { mode: "duplicate_dm" }>;
export type ProductLabelAttemptState =
  "prepared" | "sending" | "sent" | "failed_before_send" | "delivery_unknown";
export type ProductLabelJobStatus =
  "prepared" | "sending" | "awaiting_verification" | "completed" | "attention";
export type VerificationOutcome = "not_required" | "pending" | "verified";

export interface ProductLabelEventBase {
  eventId: string;
  jobId: string;
  attemptId: string;
  sequence: number;
  shiftId: string;
  codeHash: string;
  acceptedAt: string;
  policyRevision: string;
  templateDigest: string;
  payloadDigest: string;
  operatorId: string;
  occurredAt: string;
}

export type ProductLabelEvent = ProductLabelEventBase &
  (
    | {
        kind: "prepared";
        attemptNo: number;
        reason: ReprintReason | null;
        language: PrinterLanguage;
        dpi: 203 | 300;
        bytesDigest: string;
      }
    | { kind: "sending" }
    | { kind: "sent" }
    | {
        kind: "failed_before_send";
        errorCode: "printer_unconfigured" | "printer_changed";
      }
    | {
        kind: "delivery_unknown";
        errorCode: "transport_failed" | "persistence_failed" | "interrupted";
      }
    | { kind: "verified"; scannedPayloadDigest: string }
    | { kind: "verification_rejected"; reason: "invalid" | "mismatch" }
  );

export const PRODUCT_LABEL_PROTOCOL = "validation-dm-duplicate-v1";
export const MAX_PRODUCT_LABEL_EVENTS = 100;

export type ProductLabelRejectionCode =
  | "parent_missing"
  | "policy_mismatch"
  | "ownership_conflict"
  | "invalid_transition"
  | "sequence_gap"
  | "subscription_read_only";
export interface ProductLabelReceipt {
  protocol: typeof PRODUCT_LABEL_PROTOCOL;
  acceptedEventIds: string[];
  quarantined: Array<{ eventId: string; code: ProductLabelRejectionCode }>;
}
export interface ProductLabelTemplateList {
  items: Array<{ id: string; name: string; widthMm: number; heightMm: number; dpi: 203 | 300 }>;
}
```

Номера попыток начинаются с 1, sequence — с 1 на задание. Первая `prepared`
имеет `reason=null`; каждая последующая — явную причину. UUID и даты проверяются
на границе. Digest — lowercase SHA-256 hex, номера — положительные safe integers.
`templateId === snapshot.id`; digest снимка равен
`productLabelValueDigest({id:snapshot.id,name:snapshot.name,spec:snapshot.spec})`.
Digest снимка и payload проверяются при чтении.
Результат контрольного скана относится к текущему attemptId, а не только к коду.

## Task 1: Полный код и общие контракты

**Files:** Create `packages/domain/src/product-labels/{contracts,km}.ts`;
modify `packages/domain/src/index.ts`; test
`packages/domain/test/product-labels-{contracts,km}.test.ts`.

**Interfaces:** Consumes `canonicalizeKm`, `kmHash`, `labelTemplateSpecSchema`.
Produces типы выше, `validationPrintInputSchema`, `validationPrintPolicySchema`,
`productLabelEventSchema`, `productLabelReceiptSchema`, `productLabelTemplateListSchema`,
`parseDuplicateKm(raw: string): ParsedKm`,
`duplicatePayloadDigest(raw: string): string`,
`compareDuplicateKm(expected: string, scanned: string): "match" | "mismatch" | "invalid"`,
`productLabelValueDigest(value: unknown): string`,
`productLabelBytesDigest(bytes: Uint8Array): string` (SHA-256 самих байтов).

- [x] Добавить первый failing test целого кода:

```ts
import { expect, it } from "vitest";
import { compareDuplicateKm, parseDuplicateKm } from "../src/product-labels/km.js";

it("does not accept a different crypto tail for the same item", () => {
  const raw = "010460000000001521SERIAL-42\u001d93Abcd";
  expect(compareDuplicateKm(raw, `]d2${raw}`)).toBe("match");
  expect(compareDuplicateKm(raw, raw.replace("Abcd", "Efgh"))).toBe("mismatch");
  expect(compareDuplicateKm(raw, "010460000000001521SERIAL-42")).toBe("invalid");
  expect(parseDuplicateKm(raw).raw).toBe(raw);
});
```

- [x] Run `pnpm --filter @markiro/domain exec vitest run test/product-labels-km.test.ts`; ожидается отсутствие нового модуля/export.
- [x] Реализовать полноту и сравнение; основная логика:

```ts
export function parseDuplicateKm(raw: string): ParsedKm {
  const km = canonicalizeKm(raw);
  if (!(km.ais["93"] || (km.ais["91"] && km.ais["92"]))) {
    throw new DomainError("KM_REPRINT_INCOMPLETE", "Complete marking code required");
  }
  return km;
}

export function compareDuplicateKm(
  expected: string,
  scanned: string,
): "match" | "mismatch" | "invalid" {
  const canonicalExpected = parseDuplicateKm(expected).raw;
  try {
    return parseDuplicateKm(scanned).raw === canonicalExpected ? "match" : "mismatch";
  } catch {
    return "invalid";
  }
}
```

- [x] Добавить strict discriminated Zod schemas типов выше. Отдельно проверить отсутствующие хвосты, пустые/повторные AI, GS, предел 1024 UTF-8 bytes, `]d2`, кавычки, скобки, `^`, регистр, повреждённую кодировку. Пример отрицательного контракта:

```ts
expect(
  validationPrintInputSchema.safeParse({ mode: "none", verification: "required" }).success,
).toBe(false);
expect(
  validationPrintInputSchema.parse({ mode: "duplicate_dm", templateId, verification: "none" }),
).toEqual({ mode: "duplicate_dm", templateId, verification: "none" });
```

В этом тесте `templateId` — локальная константа `40000000-0000-4000-8000-000000000004`.
`productLabelValueDigest` сериализует JSON с сортировкой ключей рекурсивно,
сохраняет порядок массивов, отвергает undefined/NaN/функции/циклы; хеширует UTF-8
существующим `@noble/hashes`. Для raw digest сначала вызывается `parseDuplicateKm`.

- [x] Run обе новые suites плюс `test/km.test.ts`; затем domain typecheck/build.
- [x] Commit только эти файлы: `feat(domain): define duplicate label contracts and full code checks`.

## Task 2: Назначение шаблона, исходная этикетка и TSPL-растр

**Files:** Create `packages/domain/src/labels/duplicate.ts`,
`packages/domain/src/barcodes/gs1-data-matrix.ts`; modify
`barcodes/svg.ts`, `labels/{eligibility,tspl,zpl,bounds}.ts`, `index.ts`;
test `product-labels-render.test.ts`, `labels-eligibility.test.ts`,
`labels-tspl.test.ts`, `labels-zpl.test.ts`, `barcodes.test.ts`.
Для превью modify `apps/admin/src/pages/labels/renderer.ts` и соответствующий
`apps/admin/test/labels-*.test.ts`, когда будет подключено назначение в задаче 12.

**Interfaces:** Produces `assertDuplicateTemplate(spec: LabelTemplateSpec): void`,
`buildDuplicateLabelTemplate(): LabelTemplateSpec`,
`rasterizeGs1DataMatrix(raw: string, sideDots: number): RasterResult`;
`GenerateTsplDeps.kmDataMatrix?: "native" | "raster"`, такой же флаг в GenerateZplDeps;
`elementBoundsMm(element,data,{kmDataMatrix:"raster"})` возвращает полный квадрат кода.
`buildDuplicateLabelTemplate` возвращает 58×40 мм, 203 dpi, имя хранится отдельно:
`Дубликат Data Matrix 58×40`. `LabelTemplatePurpose` берётся из задачи 1.

- [x] Написать failing test на привязку KM и на raster-команду:

```ts
const spec = buildDuplicateLabelTemplate();
const fields = Object.fromEntries(LABEL_FIELDS.map((field) => [field, ""])) as Record<
  LabelField,
  string
>;
fields["km.code"] = "010460000000001521SERIAL-42\u001d93Abcd";
const output = await generateTspl(spec, fields, { kmDataMatrix: "raster" });
expect(output).toContain("BITMAP ");
expect(output).not.toContain("DMATRIX ");
expect(output.endsWith("PRINT 1\n")).toBe(true);
```

Тест импортирует `LABEL_FIELDS`, `LabelField`, `generateTspl` из существующих
domain-модулей и новые функции из `labels/duplicate.ts`. Исходный шаблон состоит
из Data Matrix `(x=3,y=3,size=24 mm)` и ASCII-подписей/полей с ограниченной шириной;
кириллическое имя товара добавляется в сценарии с настоящим `rasterizeText`.

- [x] Run `pnpm --filter @markiro/domain exec vitest run test/product-labels-render.test.ts`; ожидается отсутствие raster-пути.
- [x] Вынести существующую сборку GS1/FNC1 из `svg.ts` в общий модуль без изменения escaping. Использовать `bwipjs.raw` для module grid с теми же параметрами; проверять форму результата, не маскировать её через `any`. Увеличивать модули целым числом точек, добавить свободную зону в одну module-cell. Укладывать символ в отведённый квадрат; при scale < 1 бросать `DUPLICATE_LABEL_TOO_SMALL`.
- [x] Паковать bitmap существующим `bitmapToZplHex`, а полярность TSPL получать через `buildBitmapCommand`. В ветке barcode добавить точечное условие:

```ts
if (
  element.format === "datamatrix" &&
  element.data === "km.code" &&
  deps.kmDataMatrix === "raster"
) {
  const side = mmToDots(element.sizeMm, spec.dpi);
  const raster = rasterizeGs1DataMatrix(data["km.code"], side);
  lines.push(
    buildBitmapCommand(mmToDots(element.xMm, spec.dpi), mmToDots(element.yMm, spec.dpi), raster),
  );
} else {
  lines.push(renderBarcodeElement(element, data, spec.dpi));
}
```

- [x] `assertDuplicateTemplate` проверяет ровно один `datamatrix` с `data="km.code"`, отсутствие зависимостей `sscc`, границы KM-квадрата и свободной зоны. Predicate назначения коробов дополнить `purpose=box` с fallback для старых отсутствующих метаданных. Проверить literal KM, два KM, ноль KM, скрытый sscc field, неподходящую категорию.
- [x] Добавить проверку TSPL byte packing >0x7f и точности модулей после распаковки BITMAP. Тестовый decoder `helpers/decode-data-matrix.ts` поддерживает ограниченный набор режимов: не распространять его PASS на весь GS1. Для обычного ASCII-вектора проверить FNC1 codeword 232 и точный хвост; остальные режимы сравнить с raw-grid общего encoder и оставить физическое декодирование задачей 16. Отдельно сохранить прежние golden tests нативного TSPL и ZPL.
- [x] Run domain test/typecheck/lint/build. Commit: `feat(domain): render duplicate Data Matrix labels through shared GS1 raster`.

## Task 3: Чистые переходы состояний

**Files:** Create `packages/domain/src/product-labels/state.ts`,
`packages/domain/test/product-labels-state.test.ts`; modify `index.ts`.

**Interfaces:** Consumes типы задачи 1. Produces
`productLabelStatus(attempt: ProductLabelAttemptState, verification: VerificationPolicy, verified: boolean): ProductLabelJobStatus`,
`canApplyProductLabelEvent(current: ProductLabelProjection, event: ProductLabelEvent): boolean`,
`applyProductLabelEvent(current: ProductLabelProjection | null, event: ProductLabelEvent, verification: VerificationPolicy): ProductLabelProjection`.

```ts
export interface ProductLabelProjection {
  jobId: string;
  latestSequence: number;
  attemptId: string;
  attemptNo: number;
  attemptState: ProductLabelAttemptState;
  verification: VerificationPolicy;
  verificationOutcome: VerificationOutcome;
  status: ProductLabelJobStatus;
  payloadDigest: string;
  shiftId: string;
  codeHash: string;
  acceptedAt: string;
  policyRevision: string;
  templateDigest: string;
  bytesDigest: string;
  language: PrinterLanguage;
  dpi: 203 | 300;
}
```

- [x] Зафиксировать выходы без принтера:

```ts
expect(productLabelStatus("sent", "none", false)).toBe("completed");
expect(productLabelStatus("sent", "required", false)).toBe("awaiting_verification");
expect(productLabelStatus("delivery_unknown", "required", false)).toBe("attention");
expect(productLabelStatus("delivery_unknown", "required", true)).toBe("completed");
```

- [x] Run `pnpm --filter @markiro/domain exec vitest run test/product-labels-state.test.ts`; ожидается missing export.
- [x] Реализовать таблицу переходов:

```ts
export function productLabelStatus(
  attempt: ProductLabelAttemptState,
  verification: VerificationPolicy,
  verified: boolean,
): ProductLabelJobStatus {
  if (verified) {
    if (attempt !== "sent" && attempt !== "delivery_unknown") {
      throw new DomainError(
        "PRODUCT_LABEL_TRANSITION_INVALID",
        "Verification requires a sent or unknown attempt",
      );
    }
    return "completed";
  }
  if (attempt === "prepared") return "prepared";
  if (attempt === "sending") return "sending";
  if (attempt === "sent")
    return verification === "required" ? "awaiting_verification" : "completed";
  return "attention";
}
```

- [x] Проверить полную event-матрицу: начальное `prepared` №1 без причины; повтор с №+1 и причиной; `prepared→sending→sent`; `prepared→failed_before_send`; `sending→delivery_unknown`; только текущий attempt в sent/delivery_unknown может подтверждаться; `verified` требует совпадающий payloadDigest; verification_rejected не завершает задание. Повторное событие с тем же ID/нагрузкой — no-op хранилища; другой payload с тем же ID — конфликт хранилища; stale/gap sequence не меняет projection. Новый явный reprint создаёт текущую pending-проверку, но не стирает подтверждение предыдущей попытки в истории. Чистая apply-функция бросает DomainError при запрещённом переходе; replay/CAS решает вызывающее хранилище.
- [x] Run новая suite и domain typecheck/build. Commit: `feat(domain): define product label attempt transitions`.

## Task 4: Postgres-схема и библиотечный seed

**Files:** Modify `packages/db/src/schema/{labels,platform}.ts`, `packages/db/src/schema.ts`,
`packages/db/drizzle.config.ts` только если требуется зарегистрировать новый schema module;
create `packages/db/src/schema/product-labels.ts`, новый SQL в `packages/db/migrations/`
и metadata через штатный генератор; test `packages/db/test/product-labels-schema.test.ts`.
Modify `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts`
и `apps/api/test/platform-tenants.e2e.test.ts`.

**Interfaces:** Produces `schema.productLabelJobs`, `schema.productLabelEvents`,
`schema.productLabelEventReceipts`;
labelTemplates.purpose; shifts.validationPrintMode, validationPrintVerification,
validationPrintTemplateId, validationPrintSnapshot, validationPrintPolicyRevision.
Сервер хранит policy snapshot, но не готовые принтерные байты.

- [ ] В DB-тесте проверить наличие колонок и CHECK на недопустимую конфигурацию; схема SQLite в эту задачу не входит. Проверить tenant-FK шаблона и смены, операторов событий, owner device, уникальность `(tenantId, deviceId, eventId)` и `(tenantId, deviceId, jobId, sequence)`.

```ts
import { getTableColumns } from "drizzle-orm";
import * as schema from "../src/schema.js";

expect(getTableColumns(schema.labelTemplates).purpose.notNull).toBe(true);
expect(Object.keys(getTableColumns(schema.productLabelJobs))).toEqual(
  expect.arrayContaining(["tenantId", "deviceId", "jobId", "payloadDigest", "latestSequence"]),
);
```

- [ ] Run `pnpm --filter @markiro/db exec vitest run test/product-labels-schema.test.ts`; ожидается отсутствие таблиц/полей.
- [ ] Добавить Drizzle-определения и SQL-ограничения. Политика `none` хранит null snapshot/template/revision и verification none; duplicate требует validation, non-null snapshot/template/revision. Purpose разрешает только box/product_duplicate и по умолчанию box. Проверяемое условие миграции:

```sql
CHECK (
  (validation_print_mode = 'none'
    AND validation_print_verification = 'none'
    AND validation_print_template_id IS NULL
    AND validation_print_snapshot IS NULL
    AND validation_print_policy_revision IS NULL)
  OR
  (mode = 'validation' AND validation_print_mode = 'duplicate_dm'
    AND validation_print_verification IN ('none', 'required')
    AND validation_print_template_id IS NOT NULL
    AND validation_print_snapshot IS NOT NULL
    AND validation_print_policy_revision IS NOT NULL)
)
```

`product_label_jobs`: tenant/device/jobId, shiftId, codeHash, acceptedAt,
policyRevision, templateDigest, payloadDigest, latestSequence и projection.
`product_label_events`: полный immutable event JSON, digest, receive status
(`accepted/conflict/rejected`), reasonCode; составной FK на job и tenant/operator.
Событие с отсутствующим/чужим parent не создаёт успешный job: исходный факт
сохраняется в существующем `station_sync_quarantine`, чей CHECK record_kind
дополнить `product_label_event`. Так FK audit job не требует фиктивной приёмки.
`product_label_event_receipts`: tenantId/deviceId/eventId как составной PK,
payloadDigest, outcome accepted/quarantined, nullable rejectionCode, receivedAt.
FK только tenant/device, без FK на job/shift из отклонённого входа. Receipt
сохраняется для каждого результата в той же transaction; quarantine содержит
сам факт, receipt — стабильный вердикт при повторе в другом batchId.
Parent принятого скана проверяется сервисом: partitioned codes/scan_events не
включать в Drizzle-генерацию. Не добавлять им вымышленный UUID scanId.

- [ ] Сгенерировать миграцию следующим свободным номером штатным `db:generate`; точное имя номера определяется актуальным журналом на исполнении, не закрепляется заранее. Добавить idempotent seed одного product_duplicate шаблона для существующих тенантов и в provisioning новых. Существующие 20 box-шаблонов и их дефолты не менять. Seed сверить с `buildDuplicateLabelTemplate()` drift-тестом.
- [ ] Run db migration на локальной тестовой БД, db test/typecheck/lint/build и provisioning test. Отдельно проверить upgrade данных обычных смен и запрет сделать product_duplicate шаблон дефолтом короба.
- [ ] Commit: `feat(db): persist validation print policy and product label history`.

## Task 5: Атомарная SQLite-приёмка с заданием

**Files:** Modify `packages/db/src/sqlite/{schema,migrations}.ts`;
create `apps/station/src/lib/product-labels/{types,acceptance,store}.ts`,
`apps/station/test/product-labels-acceptance.test.ts`,
`packages/db/test/product-labels-sqlite.test.ts`.
Reuse `apps/station/test/support/sqlite-exec.ts`.

**Interfaces:**

```ts
export interface PreparedProductLabelAcceptance {
  jobId: string;
  shiftId: string;
  deviceId: string;
  terminalId: string;
  operatorId: string;
  credentialOwnership: string;
  raw: string;
  canonicalRaw: string;
  codeHash: string;
  gtin14: string;
  serial: string;
  acceptedAt: string;
  policy: EnabledValidationPrintPolicy;
  fields: Record<LabelField, string>;
  bytesBase64: string;
  preparedEvent: Extract<ProductLabelEvent, { kind: "prepared" }>;
}
export type ProductLabelAcceptResult =
  { status: "accepted"; jobId: string } | { status: "duplicate" } | { status: "busy" };
export function recordProductLabelAcceptance(
  exec: SqlExecutor,
  input: PreparedProductLabelAcceptance,
): Promise<ProductLabelAcceptResult>;
export function readProductLabelJob(
  exec: SqlExecutor,
  credentialOwnership: string,
  jobId: string,
): Promise<StoredProductLabelJob | null>;
export function hasUnresolvedProductLabelJob(
  exec: SqlExecutor,
  credentialOwnership: string,
  shiftId?: string,
): Promise<boolean>;

export interface StoredProductLabelAttempt {
  prepared: Extract<ProductLabelEvent, { kind: "prepared" }>;
  state: ProductLabelAttemptState;
  verifiedAt: string | null;
  verifiedBy: string | null;
}
export interface StoredProductLabelJob extends PreparedProductLabelAcceptance {
  projection: ProductLabelProjection;
  attempts: StoredProductLabelAttempt[];
  ownershipConflict: boolean;
  updatedAt: string;
}
export interface ProductLabelJobView {
  jobId: string;
  shiftId: string;
  codeSuffix: string;
  attemptId: string;
  attemptNo: number;
  language: PrinterLanguage;
  dpi: 203 | 300;
  status: ProductLabelJobStatus;
  verification: VerificationPolicy;
  verificationOutcome: VerificationOutcome;
  ownershipConflict: boolean;
  acceptedAt: string;
  updatedAt: string;
}
export function presentProductLabelJob(job: StoredProductLabelJob): ProductLabelJobView;
```

`StoredProductLabelJob` остаётся внутри lib; UI получает только безопасный View.
`codeSuffix` — последние шесть символов serial, никогда хвост AI92/93.
`ownershipConflict` обновляется из явного server receipt/существующего ownership
reconciliation; конфликт не меняет исторический transport result.

- [ ] Написать тест реальной SQLite с двумя rotating connections; все миграции применить существующим `applyMigrations`. После принятия проверить один code, один scan event, один scan outbox, один job и prepared event. Повтор того же code после завершения первого job с другим jobId должен вернуть duplicate, без второго print job.

```ts
expect(await recordProductLabelAcceptance(exec, input)).toEqual({
  status: "accepted",
  jobId: input.jobId,
});
const rows = await exec.all<{ count: number }>(
  "SELECT count(*) AS count FROM codes_mirror WHERE code_hash = ?",
  [input.codeHash],
);
expect(rows[0]?.count).toBe(1);
expect(await recordProductLabelAcceptance(exec, input)).toEqual({
  status: "accepted",
  jobId: input.jobId,
});
```

`input` — полностью заполненный `PreparedProductLabelAcceptance` fixture:
raw из задачи 1, `canonicalRaw=parseDuplicateKm(raw).raw`, hash/GTIN/serial из
domain, policy со spec задачи 2, fields из LABEL_FIELDS (пустые, qty=1 и km.code
полные), bytesBase64 из синтетических ASCII bytes `PRINT 1\n`, соответствующий
bytesDigest; IDs уникальные фиксированные UUID. Fixture не вызывает renderer,
поскольку здесь проверяется атомарность. Actual render проверяет задача 8.

- [ ] Run `pnpm --filter @markiro/station exec vitest run test/product-labels-acceptance.test.ts`; ожидается missing acceptance module.
- [ ] Добавить таблицы `product_label_accept_commands`, `product_label_jobs`, `product_label_attempts`, `product_label_events`, `product_label_outbox`. Payload и bytes — TEXT/base64, чтобы не зависеть от передачи BLOB через Tauri IPC. Все IDs берутся из команды, не из `last_insert_rowid()` другого соединения. Таблицы имеют credentialOwnership; активный job ограничен partial UNIQUE на credentialOwnership. FK job→command, attempt/event→job, outbox→event используют ON DELETE CASCADE; cleanup допускается только по условиям задачи 15. Codes/legacy outbox не имеют каскадного FK на эти локальные копии.
- [ ] INSERT команды должен одним триггером записать code, scan event, legacy scan outbox, job, attempt, event и product_label_outbox. Ранний guard и write-pattern:

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM product_label_jobs
  WHERE credential_ownership = NEW.credential_ownership
    AND status <> 'completed'
) THEN RAISE(ABORT, 'PRODUCT_LABEL_BUSY') END;

INSERT INTO codes_mirror
  (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
VALUES
  (NEW.code_hash, NEW.shift_id, NEW.gtin14, NEW.serial, NEW.accepted_at, NULL);
```

Остальные INSERT в этом же trigger берут поля из NEW; в legacy outbox
verdict=ok, box_id=NULL, operatorId исходного скана. Не вызывать `recordScan`
после этого trigger. На повтор команды с тем же jobId сравнить digest и вернуть
уже существующий результат; иной payload того же ID отвергнуть. Реальный
unique-конфликт codes_mirror записать обычным `recordScan(exec, duplicateEvent, null)`
в журнал дублей без принятого code и без печати. Busy ничего не принимает.

- [ ] Создать fault-trigger для проверки отката внутри одного statement:

```sql
CREATE TRIGGER test_product_label_outbox_fault
BEFORE INSERT ON product_label_outbox
BEGIN
  SELECT RAISE(ABORT, 'TEST_DISK_FAILURE');
END;
```

После ошибки ожидаются нулевые новые code/scan/outbox/job/attempt rows.
Повторить fault на каждом обязательном INSERT. Через afterRun rotating hook
потерять ответ после успешной команды: повтор jobId не создаёт вторую приёмку.

- [ ] Run SQLite schema tests, station acceptance/journal/mirror tests, db build перед consumer tests. Commit: `feat(station): atomically record accepted units with duplicate label jobs`.

## Task 6: API шаблонов и защита дефолтов коробов

**Files:** Modify `apps/api/src/modules/label-templates/{dto,label-templates.service,box-label-template-eligibility}.ts`,
`apps/api/src/modules/shifts/{dto,shifts.controller,shifts.service}.ts`,
`apps/api/src/modules/org-profile/org-profile.service.ts`;
test `apps/api/test/label-templates.{service,e2e}.test.ts`,
`apps/api/test/shifts-bundle.e2e.test.ts`, org-profile suites.

**Interfaces:** `CreateLabelTemplateDto.purpose` defaults to box;
`LabelTemplateDto.purpose` и `LabelTemplateSummaryDto.purpose` обязательны.
`GET /shifts/product-label-templates?productId=UUID` возвращает
`{items: Array<{id:string;name:string;widthMm:number;heightMm:number;dpi:203|300}>}`.
`ShiftsService.listProductLabelTemplates(tenantId: string, productId: string)`
проверяет tenant/product/category. Нет наследования box defaults.

- [ ] Расширить DTO test, используя реальный минимальный spec из `buildDuplicateLabelTemplate()`:

```ts
const created = createLabelTemplateSchema.parse({
  name: "Дубликат",
  purpose: "product_duplicate",
  spec: buildDuplicateLabelTemplate(),
});
expect(created.purpose).toBe("product_duplicate");
expect(
  createLabelTemplateSchema.parse({ name: "Короб", spec: buildDuplicateLabelTemplate() }).purpose,
).toBe("box");
```

- [ ] Run `pnpm --filter @markiro/api exec vitest run test/label-templates.service.test.ts`; ожидается отсутствие purpose в parsed/returned объектах.
- [ ] Пробросить purpose в create/list/get; в PATCH запретить изменение назначения существующей строки. Валидировать spec по сохранённому purpose, включая старый PATCH без поля purpose. Не разрешать старому клиенту повредить product_duplicate шаблон.
- [ ] В server predicate и все projections выбора box-шаблона включить назначение; обязательный guard:

```ts
if (template.purpose !== "box") {
  throw new BadRequestException({ code: "BOX_LABEL_TEMPLATE_NOT_ELIGIBLE" });
}
```

Применить его также к общему/категорийному дефолту организации и существующему
выбору шаблона инвентаризации. Для нового endpoint — product_duplicate,
enabled=true и текущая категория товара; disabled/cross-tenant/другая категория
не возвращаются. Зарегистрировать статический route до `:id`.

- [ ] E2E assertions: назначить duplicate шаблон дефолтом короба → 400; назначить чужой шаблон смене → 404/tenant-safe error; выключенный/другая категория → явный отказ; обычные box listings/20 defaults неизменны. Проверить OpenAPI purpose и новый endpoint.
- [ ] Run API label-template/shifts-bundle/org-profile suites, typecheck/lint/build. Commit: `feat(api): expose product duplicate templates without changing box defaults`.

## Task 7: Политика смены, снимок и capability gates

**Files:** Create `apps/api/src/modules/shifts/validation-print-policy.ts`;
modify `modules/shifts/{dto,shifts.controller,shifts.service}.ts`,
`apps/api/test/{shifts.service,shifts.e2e,shifts-bundle.e2e,shifts-openapi}.test.ts`;
create `apps/api/test/validation-print-policy.test.ts`; modify `apps/api/src/env.ts`,
`apps/api/test/{env,env-example}.test.ts`, `.env.example`, `.env.production.example`.
Modify `compose.production.yml` и
`deploy/production/test/compose-contract.test.mjs` для передачи нового gate в API.

**Interfaces:**
`assertValidationPrintCompatible(shiftMode: ShiftMode, input: ValidationPrintInput): void`;
`assertProductLabelCapability(policy: ValidationPrintPolicy, capabilities: string | undefined): void`;
`getPlanningConfig` добавляет `validationPrintProtocol: "validation-dm-duplicate-v1" | null`.
Здесь же добавить boolean `VALIDATION_DM_DUPLICATE_ENABLED` (default false) в
существующий server env boundary и оба env example файла. При false planning
возвращает null и create/включение новой duplicate policy запрещены; чтение,
recovery и sync существующих заданий не блокируются. Задача 16 проверяет выпуск.
Compose передаёт `VALIDATION_DM_DUPLICATE_ENABLED` с default false, как остальные
явно разрешённые API environment fields; значение на production не меняется
в рамках реализации. Contract test проверяет передачу и безопасный default.
Create/PATCH принимают только `ValidationPrintInput`; ShiftDto/bundle возвращают
`ValidationPrintPolicy`. Все обращения к snapshot/digest проходят server schema.

- [ ] Добавить boundary tests:

```ts
expect(() =>
  assertValidationPrintCompatible("aggregation", {
    mode: "duplicate_dm",
    verification: "required",
    templateId: "40000000-0000-4000-8000-000000000004",
  }),
).toThrow();
expect(() => assertProductLabelCapability(policy, undefined)).toThrow();
expect(() =>
  assertProductLabelCapability(policy, "subscription-state-v1,validation-dm-duplicate-v1"),
).not.toThrow();
```

`policy` в этой suite создаётся `validationPrintPolicySchema.parse` из ID,
имени и spec задачи 2, digest через `productLabelValueDigest` и фиксированного
UUID policyRevision. Не подменять enabled policy обычной для получения PASS.

- [ ] Run `pnpm --filter @markiro/api exec vitest run test/validation-print-policy.test.ts`; ожидается missing module.
- [ ] В planned create/update сервер получает пригодный шаблон, строит snapshot и revision. При открытии — повторно проверяет и фиксирует актуальный snapshot под тем же tenant-scoped shift row lock, что смена статуса. Для active PATCH добавляется запрет:

```ts
if (current.status !== "planned" && data.validationPrint !== undefined) {
  throw new ConflictException({ code: "VALIDATION_PRINT_POLICY_FROZEN" });
}
```

Если mode меняется на aggregation при планировании, incoming policy должна
явно стать none; не оставлять скрытую duplicate policy. Старые requests/rows
none не меняют форму учёта. Отсутствующее поле PATCH сохраняет текущее значение.

- [ ] Добавить capability guard для station callers в create нового режима,
      open, enter, bundle и reference-bundle; кабинет сохраняет свои permission checks.
      Старому устройству возвращать `STATION_UPDATE_REQUIRED`, без участия в смене и
      без SSCC allocation. В bundle — новый явно именованный policy snapshot,
      legacy `labelTemplate=null` и существующий boxLabelTemplate сохраняются.
- [ ] E2E: snapshot не меняется после изменения/выключения библиотечного шаблона;
      active policy freeze выдерживает race PATCH/open; вход старого клиента не
      создаёт participation; новый mode не потребляет SSCC; новая станция и админ
      создают одинаковую конфигурацию. Обновить DTO/OpenAPI tests и backward cases.
- [ ] Run focused API suites и package gates. Commit: `feat(api): snapshot validation print policy and gate station capabilities`.

## Task 8: Печатные поля и зеркало станции

**Files:** Create `apps/station/src/lib/product-labels/fields.ts`;
modify `lib/{mirror,shift-bundle,api-client,print-label}.ts`,
`test/{mirror,shift-bundle,print-label}.test.ts`;
create `test/product-labels-fields.test.ts`.

**Interfaces:** `duplicateLabelFields(input: DuplicateLabelFieldsInput): Record<LabelField,string>`;
`prepareProductLabelAcceptance(input: PrepareProductLabelInput): Promise<PreparedProductLabelAcceptance>`.
Типы определить в station `product-labels/types.ts`, импортируя существующие
`BoxLabelInput`, `RasterizeTextFn` и типы задач 1/5:

```ts
export type DuplicateLabelFieldsInput = Omit<BoxLabelInput, "sscc" | "itemCount" | "closedAt"> & {
  canonicalRaw: string;
  acceptedAt: string;
};
export type PrepareProductLabelInput = Pick<
  PreparedProductLabelAcceptance,
  | "jobId"
  | "shiftId"
  | "deviceId"
  | "terminalId"
  | "operatorId"
  | "credentialOwnership"
  | "raw"
  | "acceptedAt"
  | "policy"
> & {
  labelContext: Omit<DuplicateLabelFieldsInput, "canonicalRaw" | "acceptedAt">;
  eventId: string;
  attemptId: string;
  language: PrinterLanguage;
  rasterizeText: RasterizeTextFn;
};
```

Job ID и время задаёт caller один раз до записи; helper не читает часы самостоятельно.
Поле dpi берётся из `policy.snapshot.spec.dpi` и проверяется против текущего
принтера до acceptance. Ошибка рендера до acceptance не создаёт code/job/попытку.

- [ ] Добавить тест неизменяемых полей:

```ts
const fields = duplicateLabelFields(input);
expect(fields["km.code"]).toBe(input.canonicalRaw);
expect(fields.qty).toBe("1");
expect(fields.sscc).toBe("");
expect(fields.date).toBe("08.09.2026");
```

`input` задаёт productionDate `2026-09-08`, acceptedAt
`2026-09-08T21:30:00.000Z`, productPrintName=null, полное имя `Сироп «Клюква»`,
известный тестовый KM, gtin14 `04600000000015`, shelfLifeDays=30, прочие nullable
BoxLabelInput поля null. Дополнить тест сменой timezone и повтором на следующий день.

- [ ] Run `pnpm --filter @markiro/station exec vitest run test/product-labels-fields.test.ts`; ожидается missing helper.
- [ ] Формировать поля так, чтобы уже существующее fallback/date поведение сохранялось:

```ts
const base = boxLabelFields({ ...input, sscc: "", itemCount: 1, closedAt: input.acceptedAt });
return { ...base, "km.code": parseDuplicateKm(input.canonicalRaw).raw, qty: "1", sscc: "" };
```

Подготовка валидирует KM/template, вызывает renderer с `kmDataMatrix="raster"`
для обоих языков TSPL/ZPL, сохраняет Latin-1 bytes как base64 через
`bytesToBase64`. Вход complete label context валидируется до принятия кода.

- [ ] Добавить optional renderer options последним аргументом `renderLabelBytes`:
      `{kmDataMatrix?:"native"|"raster"}`; существующие callers не меняют вывода.
      Поддержка нового флага не берётся из пользовательского содержимого template spec.
- [ ] В зеркало записывать policy snapshot одной атомарной публикацией, проверять
      digest и revision. Если ранее сохранено duplicate_dm, старый ответ без policy
      не заменяет её none. При новой печатной смене не готовый контекст блокирует
      первый скан; обычные смены сохраняют прежнюю обработку ошибок bundle.
- [ ] Добавить `PRODUCT_LABEL_PROTOCOL` к существующему заголовку capabilities.
      Не логировать body повреждённого bundle/raw/bytes. Проверить stale bundle,
      restart без сети, response от старого сервера и попытку перезаписать active revision.
- [ ] Run fields/mirror/shift-bundle/print-label и station typecheck/build. Commit: `feat(station): persist immutable duplicate label context`.

## Task 9: Печать, контрольное сканирование и восстановление

**Files:** Create `apps/station/src/lib/product-labels/{printing,recovery}.ts`;
extend `types.ts`, `store.ts` и SQLite runtime/schema задачи 5;
create `apps/station/test/product-labels-{printing,recovery}.test.ts`.

**Interfaces:**

```ts
export interface ProductLabelActor {
  operatorId: string;
  now(): string;
  newId(): string;
}
export interface ProductLabelPrintingDeps extends ProductLabelActor {
  exec: SqlExecutor;
  credentialOwnership: string;
  target: PrintTarget | null;
  language: "zpl" | "tspl";
  dpi: 203 | 300;
  print(target: PrintTarget, bytes: Uint8Array): Promise<void>;
}
export function sendPreparedProductLabel(
  deps: ProductLabelPrintingDeps,
  jobId: string,
): Promise<ProductLabelJobView>;
export function verifyProductLabel(
  exec: SqlExecutor,
  input: ProductLabelActor & {
    jobId: string;
    attemptId: string;
    credentialOwnership: string;
    raw: string;
  },
): Promise<"match" | "mismatch" | "invalid" | "stale">;
export function prepareProductLabelReprint(
  exec: SqlExecutor,
  input: ProductLabelActor & {
    jobId: string;
    shiftId: string;
    credentialOwnership: string;
    reason: ReprintReason;
  },
): Promise<string>;
export function restoreProductLabelWork(
  exec: SqlExecutor,
  credentialOwnership: string,
  actor: ProductLabelActor,
): Promise<ProductLabelJobView | null>;
export function appendProductLabelEvent(
  exec: SqlExecutor,
  credentialOwnership: string,
  event: ProductLabelEvent,
): Promise<"applied" | "replayed" | "stale">;
```

`prepareProductLabelReprint` возвращает новый attemptId, использует прежние байты
и новый prepared event. `PrintTarget` импортируется из `lib/hardware.ts`.

- [ ] В printing test через подготовленный job задачи 5 задать transport mock:

```ts
const print = vi.fn(async () => {
  throw new Error("printer disconnected");
});
const result = await sendPreparedProductLabel({ ...deps, print }, jobId);
expect(print).toHaveBeenCalledTimes(1);
expect(result.status).toBe("attention");
expect(
  (await readProductLabelJob(deps.exec, deps.credentialOwnership, jobId))?.projection.attemptState,
).toBe("delivery_unknown");
await restoreProductLabelWork(deps.exec, deps.credentialOwnership, deps);
expect(print).toHaveBeenCalledTimes(1);
```

Локальные `deps` и `jobId` создаются в beforeEach реальной SQLite suite:
`prepareProductLabelAcceptance` задачи 8 → `recordProductLabelAcceptance` задачи 5.
print по умолчанию resolved; now/newId детерминированы; terminal/device/operator
— валидные UUID; target `{kind:"tcp",host:"127.0.0.1",port:9100}` только mock.

- [ ] Run `pnpm --filter @markiro/station exec vitest run test/product-labels-printing.test.ts`; ожидается missing send function.
- [ ] `appendProductLabelEvent` пишет immutable row одним statement. Триггер проверяет
      expected sequence и актуальную попытку, CAS-обновляет projection, сохраняет
      attempt result и добавляет outbox. Повтор eventId принимает только равный digest.
      До claim проверить target и совпадение language/DPI с сохранёнными bytes;
      отсутствие/изменение настройки записывает failed_before_send, без transport.
      В ветке корректной настройки target уже сужен до PrintTarget.
      Контракт I/O — сначала стойкий claim:

```ts
const claimed = await appendProductLabelEvent(deps.exec, deps.credentialOwnership, sendingEvent);
if (claimed !== "applied")
  return presentProductLabelJob(await requireJob(deps.exec, deps.credentialOwnership, jobId));
try {
  await deps.print(deps.target, bytes);
} catch {
  await appendProductLabelEvent(deps.exec, deps.credentialOwnership, unknownEvent);
  return presentProductLabelJob(await requireJob(deps.exec, deps.credentialOwnership, jobId));
}
await appendProductLabelEvent(deps.exec, deps.credentialOwnership, sentEvent);
return presentProductLabelJob(await requireJob(deps.exec, deps.credentialOwnership, jobId));
```

`sendingEvent`, `unknownEvent`, `sentEvent` — текущая common event base плюс kind
и последовательность, создаваемые из сохранённого job и actor в этой функции.
`requireJob(exec,credentialOwnership,id): Promise<StoredProductLabelJob>` добавить в store: вызвать
readProductLabelJob, при null бросить `PRODUCT_LABEL_JOB_MISSING` без содержимого.
Если запись результата не удалась, вернуть recoverable error; не вызывать
транспорт повторно. Сохранённый sending остаётся для следующего восстановления.

- [ ] Restore превращает sending в delivery_unknown событием interrupted;
      prepared разрешает продолжение только после входа оператора/готовности контекста,
      sent+required возвращает проверку. Disabled verification завершает только sent,
      а не unknown. Проверка сравнивает полный код задачей 1 и публикует verified
      только после commit; race old attempt/double callback возвращает stale.
- [ ] Явный reprint: current shift/current credential owner, есть исходный accepted
      code, нет другого pending job, нет известного ownership conflict/release; reason
      обязательна. Вторая prepared фиксирует attemptNo+1 и resets текущий verification
      outcome, сохраняя прошлые события. Язык/DPI должны соответствовать сохранённым bytes.
- [ ] Тесты: before-I/O fault → zero print calls; after-I/O persistence fault →
      no automatic repeat; повтор/двойной click → один claim; verify mismatch/invalid →
      без изменения codes/outbox продукции; stale verify не подтверждает новый attempt;
      новый оператор имеет отдельную атрибуцию; bytes и date при reprint неизменны.
- [ ] Run printing/recovery/acceptance suites, station gates. Commit: `feat(station): recover duplicate printing without automatic resends`.

## Task 10: Серверный приём событий и явная квитанция

**Files:** Create `apps/api/src/modules/station-scans/product-label-events.ts`;
modify `station-scans/{dto,station-scans.service}.ts` и OpenAPI;
create `apps/api/test/station-product-label-events.e2e.test.ts`;
extend `station-scans-dto.test.ts`, `station-scans.e2e.test.ts`.

**Interfaces:** `SyncBatchDto.productLabelEvents` default `[]`, max 100;
`ProductLabelReceipt` импортируется из domain задачи 1; новый обработчик:

```ts
export type StationScanTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export function applyStationProductLabelEvents(
  tx: StationScanTransaction,
  context: { tenantId: string; authenticatedTerminalId: string },
  events: ProductLabelEvent[],
): Promise<ProductLabelReceipt>;
```

В receipt code — закрытый перечень `parent_missing | policy_mismatch |
ownership_conflict | invalid_transition | sequence_gap | subscription_read_only`;
не возвращать идентичность чужого tenant. `SyncBatchResponseDto.productLabelReceipt`
присутствует при непустом новом канале; точный receipt хранится в syncBatches.result.
В текущем API `authenticatedTerminalId` — UUID `req.deviceId` после guard;
именно он записывается в deviceId новых server tables. Не принимать независимый
device/terminal из event и не преобразовывать machineId станции в UUID.

- [ ] DTO test:

```ts
expect(
  syncBatchSchema.parse({ batchId: "fixture:legacy:1", items: [] }).productLabelEvents,
).toEqual([]);
expect(
  syncBatchSchema.safeParse({ batchId: "fixture:new:1", items: [], productLabelEvents: [{}] })
    .success,
).toBe(false);
```

- [ ] Run `pnpm --filter @markiro/api exec vitest run test/station-scans-dto.test.ts`; ожидается отсутствие нового parsed field.
- [ ] Добавить schemas и service module. Обрабатывать события после исходных scans
      и ownership claims в той же transaction. Сохранённые canonicalRaw/shift policy
      должны давать те же digests. Parent находится по shiftId/codeHash/acceptedAt
      и аутентифицированному terminal, а не по придуманному клиентскому scan UUID.
- [ ] Локировать job rows в фиксированном порядке после существующего registry
      lock, проверять eventId/digest и sequence. Применять чистые переходы задачи 3.
      Accepted/quarantined receipt состоит только из запрошенных eventId; одинаковый
      eventId с другим payload → conflict всей повторной записи, не успешный replay.
      Семантически неразрешённый parent/политика → per-record quarantine; последующие
      события этого job не считаются успешными. Другие jobs продолжают применяться.
- [ ] В existing replay return добавить сохранённый receipt:

```ts
return {
  applied: 0,
  alreadyApplied: true,
  conflicts: stored?.conflicts ?? [],
  ...(stored?.denied ? { denied: stored.denied } : {}),
  ...(stored?.productLabelReceipt ? { productLabelReceipt: stored.productLabelReceipt } : {}),
};
```

Legacy unbound replay без receipt не выдаёт подтверждения новому каналу.
Добавить новый канал в payload digest, shift permission/subscription checks,
denied/quarantine bookkeeping и query locks. Не менять scan counts на печатных фактах.
DeniedStationRecordDto.recordKind принимает `product_label_event`; quarantine
payload map включает новый массив. Несуществующий job/parent сохраняется здесь,
а не обходом FK в product_label_events. Повтор отказанного eventId с тем же
digest остаётся тем же отказом, даже если пришёл в другом batchId; глобальный
ключ и digest отказа хранить в `productLabelEventReceipts` задачи 4.

- [ ] E2E в реальной тестовой БД: один batch с scan+prepared, event-only batch,
      replay после потери ответа, изменённый payload/event ID, поздний verified,
      cross-tenant/device, одинаковый код с другим хвостом, проигранный ownership,
      parent denied, две смены (ошибка одной не теряет вторую). Assert точные audit fields.
- [ ] Run focused e2e/DTO и API package gates с DB env. Commit: `feat(api): sync product label events with durable receipts`.

## Task 11: Новый канал outbox, стабильный batch и ACK

**Files:** Create `apps/station/src/lib/product-labels/sync.ts`;
modify `lib/sync.ts`, `lib/credential-recovery.ts`,
`test/sync.test.ts`, `test/credential-recovery.test.ts`;
create `test/product-labels-sync.test.ts`.

**Interfaces:**

```ts
export function readPendingProductLabelEvents(
  exec: SqlExecutor,
  credentialOwnership: string,
  limit: number,
  ceiling: number | null,
): Promise<Array<{ id: number; event: ProductLabelEvent }>>;
export function ackProductLabelEvents(
  exec: SqlExecutor,
  credentialOwnership: string,
  sentEvents: ProductLabelEvent[],
  receipt: ProductLabelReceipt,
): Promise<void>;
export function productLabelSetSignature(events: ProductLabelEvent[]): string;
```

`productLabelReceiptSchema` и тип receipt импортируются из domain задачи 1.

- [ ] В существующем SyncEngine test fixture сохранить event, потерять ответ и
      записать более поздний verified. Основная проверка:

```ts
engine.nudge();
await engine.idle();
engine.nudge();
await engine.idle();
expect(requests[1]?.batchId).toBe(requests[0]?.batchId);
expect(requests[1]?.productLabelEvents).toEqual(requests[0]?.productLabelEvents);
expect(await readPendingProductLabelEvents(exec, ownership, 100, null)).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ event: expect.objectContaining({ kind: "verified" }) }),
  ]),
);
```

`engine` = `createSyncEngine` существующего теста; `requests` захватывает body
mock `client.post`, первый вызов падает, перед вторым nudge fixture сохраняет
verified и продвигает test clock за retry deadline. Повтор инициируется nudge,
как в текущих retry tests. Не использовать sleep. `ownership` берётся через
`await credentialGenerationOwnership(generation)`, fixtures events проходят schema.
Если ownership null (unbound generation), новый канал не открывается: сначала
требуется текущая привязка. Не подставлять пустую строку и не читать все owners.

- [ ] Run `pnpm --filter @markiro/station exec vitest run test/product-labels-sync.test.ts`; ожидается отсутствие нового канала в body.
- [ ] Добавить persisted `sync_pending_product_label_ceiling`, включая 0 для пустого
      канала; добавить signature в batchId в пределах существующих 200 символов.
      pin выполняется до отправки; добавленные после pin события не попадают в retry.
      Parent scan отправляется раньше либо в том же batch: если его outbox row ещё
      за пределом batch, зависимые print events пока не выбирать. Повреждённый local
      event quarantine до сериализации, без блокировки остальных очередей.
- [ ] Новый канал ACK только при валидной явной квитанции:

```ts
if (sentProductLabelEvents.length > 0) {
  const receipt = productLabelReceiptSchema.safeParse(response.productLabelReceipt);
  if (!receipt.success) throw new Error("PRODUCT_LABEL_PROTOCOL_UNAVAILABLE");
  await ackProductLabelEvents(exec, ownership, sentProductLabelEvents, receipt.data);
}
```

Receipt обязан точно покрыть отправленные IDs без пересечений accepted/quarantine,
без чужих/дублирующихся IDs. Отсутствие receipt после отката API не удаляет
ни печатные факты, ни pinned batch. Карантин сохраняет причину; immutable event
не переписывается. Доставка не вызывает transport print.

- [ ] Встроить счётчики нового outbox в SyncState/SealedWorkSummary и pause/drain.
      Старая credential generation не может ACK или отправить события нового владельца.
      Не удалять новый журнал при clearRejectedCredentialState; он хранит свои
      snapshot/ownership и не зависит от очищаемого shift_mirror.
- [ ] Проверить empty-channel pin, event-only batch, restart между pin и post,
      partial receipt, old server response, late ACK после seal, rejected parent,
      сохранение более позднего verified и отсутствие незавершённой работы в другой
      credential generation. Run sync/recovery suites и station gates.
- [ ] Commit: `feat(station): deliver product label history with replay-safe acknowledgements`.

## Task 12: Настройки и шаблоны в кабинете

**Files:** Modify `apps/admin/src/pages/labels/api.ts`,
`apps/admin/src/pages/labels/{index,TemplateThumb}.tsx`,
`labels/editor/{index,PreviewPane}.tsx`, `labels/renderer.ts`,
`apps/admin/src/pages/shifts/{ShiftForm,ShiftDetailsPanel}.tsx`, `shifts/api.ts`,
`apps/admin/src/i18n/{ru,en}.json`;
test `apps/admin/test/{labels-library,labels-editor,shifts}.test.tsx`,
`apps/admin/test/labels-raster.test.ts`.

**Interfaces:** Клиент `CreateShiftInput.validationPrint?: ValidationPrintInput`,
`ShiftDto.validationPrint: ValidationPrintPolicy`; purpose в клиентских template
DTO соответствует задаче 6. Новый метод
`listProductLabelTemplates(productId: string): Promise<ProductLabelTemplateList>`
потребляет endpoint задачи 6. `ProductLabelTemplateList` — общий shape
`{items: Array<{id:string;name:string;widthMm:number;heightMm:number;dpi:203|300}>}`,
его Zod schema и type экспортируются domain-контрактом задачи 1.

- [ ] В existing ShiftForm test fixture с товаром и duplicate template проверить
      форму отправки через перехват аргумента существующего API mock:

```ts
fireEvent.click(screen.getByLabelText("Печатать дубликат Data Matrix"));
expect(screen.getByLabelText("Обязательная проверка этикетки")).toBeChecked();
fireEvent.click(screen.getByLabelText("Обязательная проверка этикетки"));
fireEvent.click(screen.getByRole("button", { name: "Запланировать смену", exact: true }));
expect(submittedBody).toEqual(
  expect.objectContaining({
    validationPrint: { mode: "duplicate_dm", templateId, verification: "none" },
  }),
);
```

В тесте переключить i18n на ru; `submittedBody` — parsed JSON POST `/shifts`,
перехваченный существующим fetch mock после ожидания завершения mutation.
`templateId` — UUID выбранного fixture из задачи 1. До действия
заполнить обязательные поля через существующий setup `shifts.test.tsx`.

- [ ] Run `pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx`; ожидается отсутствие новых настроек.
- [ ] Добавить UI-поля только к validation: печать изначально выключена; при её
      первом включении проверка required. Выключение печати сериализует `{mode:"none"}`.
      Категория/товар изменились — прежний выбор шаблона очистить и загрузить новый
      список; устаревший ответ не возвращает старый выбор. Нельзя submit до загрузки
      и явного выбора пригодного шаблона. Сборка input:

```ts
const validationPrint: ValidationPrintInput = printEnabled
  ? {
      mode: "duplicate_dm",
      templateId: selectedTemplate.id,
      verification: verificationRequired ? "required" : "none",
    }
  : { mode: "none" };
```

`selectedTemplate` проверяется до этой ветки; не применять non-null assertion.
В planned edit восстановить значения; в active details показать frozen policy.

- [ ] В библиотеке добавить назначение «Короб» / «Дубликат товара». Для нового
      product_duplicate использовать `buildDuplicateLabelTemplate`; менять purpose
      существующего шаблона нельзя. В редакторе предупреждать о непригодности до save
      через `assertDuplicateTemplate`, сервер повторяет проверку. Для копирования в
      другое назначение создаётся новый шаблон и применяется его eligibility.
- [ ] Превью и download используют ту же спецификацию, GS1-модель и raster option,
      что Station. Новый preview передаёт kmDataMatrix=raster и в elementBoundsMm;
      геометрия старых matrix-шаблонов не меняется. Preview fixture содержит полный синтетический KM, не реальный код
      клиента; thumbnail без пригодного sample не рисует выдуманный barcode. Проверить
      Cyrillic, размер 58×40 и исключение duplicate template из всех box selectors.
- [ ] RU/EN: «Обязательная проверка этикетки» / «Require label verification»;
      пояснение выключенного режима: «После отправки на принтер можно сканировать
      следующую единицу». Использовать существующие @markiro/ui controls и tokens;
      визуальный эталон — холст, а не новые CSS-токены.
- [ ] Run указанные suites, admin test/typecheck/lint/build. Commit: `feat(admin): configure duplicate printing and label verification`.

## Task 13: Создание смены оператором на станции

**Files:** Modify `apps/station/src/pages/NewShift.tsx`,
`apps/station/src/lib/api-client.ts`, `apps/station/src/i18n/{ru,en}.json`,
`apps/station/src/dev/{gallery-fixtures.ts,StationScreenGallery.tsx}`;
test `apps/station/test/{new-shift,screen-gallery}.test.tsx`.

**Interfaces:** POST создания смены передаёт тот же `ValidationPrintInput`,
capability задачи 8 и текущего оператора существующим способом. Planning config
задачи 7 даёт доступность протокола; отдельный список product templates задачи 6
не подменяет старую библиотеку коробов. Props `NewShift` сохраняются совместимыми.

- [ ] Расширить `new-shift.test.tsx` с существующими `client`, `silentSource`,
      `submitGtin`, mocked fetch: ответить на GTIN/product/planning/template requests,
      выбрать validation и полный fixture template. Проверить обязательность и body:

```ts
render(<NewShift client={client} source={silentSource} onStarted={vi.fn()} onBack={() => {}} />);
submitGtin();
await screen.findByText("Cola");
fireEvent.click(screen.getByRole("button", { name: "Validation" }));
fireEvent.click(screen.getByLabelText("Print duplicate Data Matrix"));
expect(screen.getByLabelText("Require label verification")).toBeChecked();
fireEvent.click(screen.getByLabelText("Require label verification"));
```

Текущая suite использует en; новые имена добавляются в i18n. Завершить выбор
шаблона и существующий start action; захваченный JSON POST должен содержать
`{mode:"duplicate_dm",verification:"none",templateId}` внутри validationPrint.

- [ ] Run `pnpm --filter @markiro/station exec vitest run test/new-shift.test.tsx`; ожидается отсутствие выбора печати.
- [ ] В существующую последовательность добавить шаг настроек после выбора
      validation, затем выбор duplicate template. Для aggregation сохраняется выбор
      box template. Все новые controls используют текущие большие station controls.
      При возврате сохранять выбор до смены товара; второй клик start блокируется
      существующим entry lease. POST body строить общим input задачи 1.
- [ ] До старта проверить выбранный шаблон, printer language/DPI и доступность
      протокола. Если принтер не настроен, дать переход в существующие настройки;
      не создавать активную печатную смену с непригодным контекстом. Потеря сети до
      create показывает повтор запроса; новая возможность офлайн-создания не вводится.
- [ ] Проверить отсутствие capability, пустой список, отключённый шаблон между
      выбором и POST, возврат с шага, смену товара при pending fetch, required по
      умолчанию, none по явному выбору, stale credential/entry lease. При ответе
      сервера восстанавливать авторитетный snapshot, не локальный draft.
- [ ] Добавить gallery states `validation-print-create-required` и
      `validation-print-create-none` на реальном NewShift с fixture client.
      Test gallery registration подтверждает существование состояний. Run new-shift,
      gallery и station gates. Commit: `feat(station): let operators configure duplicate print shifts`.

## Task 14: Сканер, рабочий экран и восстановление контекста

**Files:** Create `apps/station/src/lib/use-product-label-work.ts`,
`apps/station/src/ui/work/ProductLabelInstrument.tsx`,
`apps/station/src/ui/work/ProductLabelVerification.tsx`,
`apps/station/src/ui/exceptions/ProductLabelHistory.tsx`;
modify `pages/WorkScreen.tsx`, `App.tsx`, `lib/{shift-close,credential-recovery}.ts`,
`i18n/{ru,en}.json`, `dev/{StationScreenGallery.tsx,gallery-fixtures.ts}`;
create `apps/station/test/product-label-work.test.tsx`;
extend `test/{work-screen,shift-boxes-panel}.test.tsx`,
`test/{scan-queue,shift-close,credential-recovery}.test.ts`.

**Interfaces:** `useProductLabelWork` получает `exec`, credential ownership,
enabled policy, текущий shift/operator, `ProductLabelPrintingDeps` и builder
`(raw:string)=>Promise<PreparedProductLabelAcceptance>` задачи 8. Возвращает
`{job:ProductLabelJobView|null,busy:boolean,accept(raw:string):Promise<ProductLabelAcceptResult>,
verify(raw:string):Promise<"match"|"mismatch"|"invalid"|"stale">,
reprint(jobId:string,reason:ReprintReason):Promise<void>,pause():Promise<void>}`.
Все Promise регистрируются в существующем floor work barrier. Ни UI, ни hook
не имеют второго print transport. Новый `hasUnresolvedProductLabelJob(exec,
credentialOwnership,shiftId?): Promise<boolean>` экспортируется store задачи 5.
В `closeShiftOffline` input добавить `credentialOwnership?:string`; для enabled
policy этот параметр обязателен, App передаёт его из текущей generation.
Старые none callers остаются совместимыми. `undefined` не означает доступ ко
всем owners и не разрешает закрытие смены с печатным долгом.

- [ ] В test harness существующего WorkScreen передать SQLite exec, enabled
      snapshot и spy принтера. Скан оригинала через существующий manual ScanSource:

```ts
act(() => scanner.scan(raw));
await screen.findByText("Проверьте этикетку");
act(() => scanner.scan(raw.replace("Abcd", "Efgh")));
await screen.findByText("Код не совпадает");
expect(printSpy).toHaveBeenCalledTimes(1);
expect(await hasUnresolvedProductLabelJob(exec, ownership, shiftId)).toBe(true);
act(() => scanner.scan(raw));
await screen.findByText("Этикетка подтверждена");
expect(await hasUnresolvedProductLabelJob(exec, ownership, shiftId)).toBe(false);
```

`raw` — полный fixture задачи 1; `scanner` и `printSpy` — зависимости harness,
`shiftId` и `ownership` — её текущая смена/credential. Count codes остаётся 1
после всех трёх сканов. Отдельный none-case завершается «Отправлено на принтер»
без экрана штатной проверки и без события verified.

- [ ] Run `pnpm --filter @markiro/station exec vitest run test/product-label-work.test.tsx`; ожидается обычная validation вместо нового процесса.
- [ ] В последовательном обработчике ScanQueue выбрать новую приёмку только для
      enabled policy. После atomic acceptance показать job, вызвать единственный
      `sendPreparedProductLabel`. Отклонённые GTIN/invalid/duplicate сохраняют прежние
      verdicts и звук, но не печатают. Полный scan перестаёт быть доступен UI после
      передачи контроллеру; в строке задания — только безопасный codeSuffix.
- [ ] Маршрутизировать один scanner sink: production → print busy → verification
      или production. Переключение публикуется до завершения текущего queue handler;
      удалить накопленный до переключения ввод, чтобы исходный скан не подтвердил
      свою этикетку. В sending новые сканы не принимают товар. Проверка вызывает
      `verifyProductLabel` с current attemptId; следующий production scan доступен
      только после успешного commit результата. Тестом удержать commit Promise и
      доказать, что ранний следующий скан не принят.
- [ ] `ProductLabelVerification` использует отдельный `FullScreenDialog` и полный
      KM comparator; не менять контракт SSCC verification. Кнопки: «Пауза»,
      «Напечатать повторно»; кнопки пропуска нет. При unknown разрешены сканирование
      совпавшей этикетки и явный reprint с причиной в обоих режимах. При none не
      показывать «проверено», пока не было фактического recovery verification.
- [ ] В «Исключениях» добавить историю product jobs текущей смены этой станции.
      Повтор требует not_printed/damaged/lost, неизменные bytes и новый attempt.
      Чужая смена/станция и известный ownership conflict запрещают reprint. Наличие
      другого незавершённого job блокирует его и в UI, и в атомарном store guard.
- [ ] Pause/logout сначала останавливает intake и ждёт floor writes, сохраняя job.
      После входа другого оператора `restoreProductLabelWork` получает нового actor;
      старая отправка не запускается ещё раз. При startup unresolved job проверяется
      до production routing, включая remotely closed shift. Для закрытой смены
      разрешён только recovery этого задания, обычный приём новых единиц запрещён.
- [ ] Добавить atomic close guard: SQL изменения статуса/close command не проходит
      при существующем unresolved job. UI-проверка лишь объясняет запрет. Создание
      acceptance, явный reprint и close также проверяют статус смены под единым
      statement guard, чтобы гонка close/scan не оставила новый долг в закрытой смене.
      Исключение — reprint уже незавершённого задания при удалённом закрытии, через
      явно отмеченный recovery path и сохранённый ownership.
- [ ] Credential generation seal запрещает новые вызовы и дожидается текущего I/O;
      запоздалый callback не меняет чужой journal. После rejected credential snapshot
      и долг остаются закрытыми от новой tenant generation. Новая привязка не даёт
      права читать/печатать старый job; его существующий sealed-work flow видит count.
- [ ] Тесты race scan/screen/pause/close/login, stale callback, restart каждого
      состояния, double reprint, remote close, original+confirmation same queue burst,
      required disabled/none captions и unchanged aggregation/SSCC. Run эти suites и
      station gates. Commit: `feat(station): integrate recoverable duplicate printing into validation`.

## Task 15: История смены и очистка доставленных локальных копий

**Files:** Create `apps/api/src/modules/shifts/product-label-history.ts`,
`apps/api/test/product-label-history.e2e.test.ts`,
`apps/admin/src/pages/shifts/{product-labels-api.ts,ProductLabelHistory.tsx}`,
`apps/admin/test/product-label-history.test.tsx`;
modify shifts controller/service/DTO/OpenAPI, `ShiftDetailsPanel.tsx`,
`apps/station/src/lib/product-labels/recovery.ts`, обе i18n-пары;
extend `apps/station/test/product-labels-recovery.test.ts`.

**Interfaces:** `GET /shifts/:id/product-labels?limit=50` (следующие страницы с cursor) →
`{summary:ProductLabelSummary,items:ProductLabelHistoryRow[],nextCursor:string|null}`;
`GET /shifts/:id/product-labels/:jobId/events?afterSequence=0&limit=100` →
`{items:ProductLabelEvent[],nextSequence:number|null}`. DTO истории экспортирует
`ProductLabelSummary={sentAttempts:number,verifiedAttempts:number,unresolvedJobs:number,reprintAttempts:number}`;
`ProductLabelHistoryRow={jobId:string,codeSuffix:string,acceptedAt:string,status:ProductLabelJobStatus,
verificationOutcome:VerificationOutcome,attemptNo:number,ownershipConflict:boolean}`.
`purgeCompletedProductLabelJobs(exec:SqlExecutor,credentialOwnership:string):Promise<number>`
удаляет только полностью доставленные закрытые локальные копии.

- [ ] E2E подготовить accepted unit, две попытки sent и одно verified через
      реальный sync endpoint. Проверить totals и отсутствие полного кода:

```ts
expect(body.summary).toEqual({
  sentAttempts: 2,
  verifiedAttempts: 1,
  unresolvedJobs: 0,
  reprintAttempts: 1,
});
expect(JSON.stringify(body)).not.toContain(raw);
expect(body.items[0]).toMatchObject({ attemptNo: 2, verificationOutcome: "verified" });
```

`body` — parsed GET response, `raw` — исходный fixture; отдельно проверить,
что существующий summary принятых товаров равен 1, а не 2.

- [ ] Run `pnpm --filter @markiro/api exec vitest run test/product-label-history.e2e.test.ts`; ожидается отсутствующий endpoint.
- [ ] Реализовать tenant-scoped list с keyset cursor `(acceptedAt,jobId)` и limit
      1–100; events упорядочены sequence, max 100. Чужие tenant/shift/job → 404.
      Summary считает уникальные attempts, а не число повторно доставленных events;
      quarantine/conflict не увеличивают успешные метрики. Отдельный conflict badge
      показывает подтверждённую сервером проблему владения, не стирая попытки.
- [ ] Admin добавляет компактный блок в существующие детали смены с четырьмя
      счётчиками и paginated журналом: время, оператор, причина, transport result,
      verification outcome. Надпись «Отправлено» не обещает физическую печать.
      Имена операторов получает tenant-scoped справочник существующего API; при
      отсутствии имени показывать безопасный идентификатор. Не добавлять remote print.
- [ ] Локальная очистка: один DELETE родительских command rows с каскадом на
      соответствующие job/attempt/event rows, только когда shift closed, job completed,
      product outbox и исходный scan outbox пусты, нет quarantine/ownership conflict.
      Parent→child FK/cascade определить в задаче 5. Серверная audit history и
      `codes_mirror` не удаляются. Вызов — после sync ACK/закрытия, с generation lease;
      повтор безопасен. Незакрытая смена сохраняет bytes для явного reprint.
- [ ] SQLite test выполнить cleanup на каждом запрещающем условии и на полностью
      завершённом job: blocked cases возвращают 0; затем 1; повтор 0. Stale callback
      после purge получает missing/stale и никогда не пересоздаёт job/transport.
- [ ] Run API history/e2e, admin component, station recovery и package gates.
      Commit: `feat(shifts): expose product label history and retire delivered local payloads`.

## Task 16: Браузерная, аппаратная приёмка и подготовка выпуска

**Files:** Create `tools/production-browser/product-labels.playwright.config.ts`,
`tools/production-browser/product-labels-tests/{admin,station}.spec.ts`,
`docs/acceptance/validation-dm-duplicate.md`;
create `apps/admin/test/browser/product-labels.html` и
`apps/admin/test/browser/product-labels-harness.tsx`, опираясь на существующий
`cabinet-harness.tsx`; extend `apps/station/src/dev/StationScreenGallery.tsx`,
`gallery-fixtures.ts`, `tools/production-browser/package.json`, `docs/architecture.md`.
Screenshots/trace — в отдельный outputDir tmpdir, не stage всего exports/.

**Interfaces:** Новый script tools package
`test:product-labels = playwright test --config product-labels.playwright.config.ts`.
Config запускает реальные admin/station entrypoints на двух выделенных портах
43181/43182 с strictPort, `reuseExistingServer:false`, `workers:1`, `retries:0`.
Фикстуры API/SQLite/print задаются через текущий acceptance harness; mock transport
обязан называться mock в результате. Страницы используют реальные компоненты.

- [ ] Сначала browser assertion required-state и геометрии:

```ts
await page.setViewportSize({ width: 1280, height: 800 });
await expect(page.getByRole("dialog", { name: "Проверьте этикетку" })).toBeVisible();
await expect(page.getByRole("button", { name: "Пропустить", exact: true })).toHaveCount(0);
expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
const pause = await page.getByRole("button", { name: "Пауза", exact: true }).boundingBox();
expect(pause?.height).toBeGreaterThanOrEqual(64);
```

Перед проверкой harness открывает смену и отправляет fixture scan через текущий
scanner adapter. В admin использовать 1920×1080; включить RU/EN и обе темы.

- [ ] Run `pnpm --dir tools/production-browser run test:product-labels`; сначала
      подтвердить fail на отсутствующем gallery state/flow, затем добавить конкретные
      fixture entrypoints/config. Не заменять пользовательский маршрут картинкой.
- [ ] Пройти оба места создания, печать off/required/none, ошибку транспорта,
      recovery, несовпадение хвоста, explicit reason/reprint, restart, историю и freeze.
      Снять screenshots новых шагов NewShift и всех согласованных WorkScreen states.
      Сверить с Pencil exports; проверять overflow, действия, фокус и клавиатуру.
- [ ] Запустить финальные gates в порядке зависимостей. После DB migration/build
      выполнить focused API DB suites с development env; затем общий serial gate:

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db build
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm test:production-bundle:contract
pnpm format:check
git diff --check
```

Env загружается по AGENTS.md без вывода значений. Intentional DB skips вынести
отдельно; они не закрывают API/DB gate. Cargo test требуется, если пришлось
изменить Tauri/Rust; неизменённый shell всё равно проходит ручную Windows-приёмку.
После кода при наличии локального graph выполнить `graphify update .`.

- [ ] В acceptance doc записать отдельные результаты software/browser/hardware:
      дата, commit, Windows/Tauri version, printer model/firmware, scanner model,
      transport USB/network, language ZPL/TSPL, DPI 203/300, размер 58×40, test IDs,
      результат canonical byte comparison. Исходные реальные KM и keys не коммитить.
      Допустимые статусы строки `passed`, `failed`, `not_run`; not_run не считается PASS.
- [ ] Физический протокол: исходный полный синтетический код → печать → скан
      этикетки → `compareDuplicateKm(...) === "match"`. Проверить GS/FNC1, AI93 и
      AI91+92, кавычки/скобки/^, кириллицу полей, модуль/quiet zone, смену даты при
      reprint. Отдельно снять питание/связь до/во время/после send и подтвердить
      отсутствие автоматического повтора. Windows-проверка применяет настоящий пул
      Tauri SQL с той же fault/restart матрицей задачи 5.
- [ ] При отсутствии оборудования сохранить hardware=not_run и не включать новый
      режим на линии. Браузерный mock и host test не подтверждают этикетку. Запуск
      физической приёмки можно провести сразу после задачи 2, повторить после сквозной
      интеграции; неизвестные модели принтеров не объявлять поддержанными.
- [ ] Зафиксировать порядок выпуска: совместимые миграции/API → совместимая Station
      → включение создания duplicate смен. Planning config задачи 7 не рекламирует
      протокол до завершения приёмки; используется добавленный в задаче 7 boolean
      `VALIDATION_DM_DUPLICATE_ENABLED` с default false.
      Выключенный gate запрещает создание/включение новой политики, но продолжает
      bundle/recovery/sync уже существующих заданий. Disabled gate + ordinary shifts
      работают как раньше. Добавить соответствующие config/API tests.
- [ ] Rollback test: сервер без receipt не удаляет local events; отключение gate
      не стирает jobs и не обходит required. Запрет downgrade старого Station binary
      описать в runbook: восстановление только совместимым исправлением. Не добавлять
      вымышленную защиту, которой старый бинарник технически не умеет пользоваться.
- [ ] Обновить архитектуру фактическими решениями, review scoped diff и acceptance
      report. Commit: `test(product-labels): verify duplicate print flow and document rollout`.
      Публикация ветки, PR и выпуск выполняются только по отдельному поручению.

## Карта покрытия спецификации

| Требование                                                       | Задачи / доказательство                       |
| ---------------------------------------------------------------- | --------------------------------------------- |
| Одна единица, полный тот же KM, без новой эмиссии                | 1, 2, 5; full-tail tests, один accepted code  |
| Настройка админом и оператором, freeze после старта              | 7, 12, 13; active PATCH/open race             |
| Назначение, seed, snapshot и независимые box defaults            | 2, 4, 6, 8, 12; legacy seed/selector tests    |
| Обязательная проверка / отправка без проверки                    | 3, 9, 14; persisted outcomes и UI             |
| Одна незавершённая единица, потеря питания, неизвестная доставка | 5, 9, 14; atomic fault/CAS/restart            |
| Явный повтор с причиной и неизменными bytes                      | 8, 9, 14; reprint следующего дня              |
| Офлайн, ACK, quarantine и причинная связь с приёмкой             | 10, 11; pinned retry и поздний verified       |
| Tenant/credential isolation и конфликт владения                  | 4, 7, 10, 11, 14, 15; cross-tenant/seal tests |
| Пауза, смена оператора, local/remote close                       | 9, 14; восстановление и SQL guard             |
| История, отдельные количества и очистка                          | 10, 15; totals и retention matrix             |
| Реальный дизайн и новые шаги создания                            | 12–14, 16; horizontal screenshots             |
| Windows, GS1/FNC1, физический принтер, порядок выпуска           | 2, 16; отдельные hardware результаты          |

## Правило завершения

Каждая задача считается выполненной после её focused tests и review diff;
общий режим готов к включению после всех применимых gates задачи 16. В отчёте
перечислить изменённое поведение, области файлов, автоматические результаты,
браузерные и физические результаты, а также не выполненные проверки с причиной.
План сам по себе не является свидетельством успешной печати или разрешением выпуска.

Проверка документа 2026-09-08: все разделы спецификации сопоставлены задачам;
новые общие типы и сигнатуры сверены между задачами; ссылки на существующие
исходники проверены, отсутствующие файлы обозначены как создаваемые. Реализация
и её runtime-проверки при подготовке этого плана не выполнялись.

## Ход реализации

2026-09-08: задача 1 завершена в `codex/validation-dm-duplicate`. До изменений
485 тестов domain прошли; после задачи 1 — 555 тестов. Typecheck исходников и
тестов, lint и build прошли. Новые 70 тестов сначала падали на отсутствующем
контракте, затем прошли.

Окружение: новая рабочая копия использует установленные зависимости исходного
checkout через локальные ссылки внутри игнорируемых node_modules.
`pnpm install --frozen-lockfile --offline` отклоняет существующую запись
packageManager в lockfile; автоматическая проверка зависимостей при запуске pnpm
также пытается переустановить окружение. Lockfile не изменён. Vitest, tsc, ESLint
и Prettier запускаются напрямую теми же установленными версиями, что указаны
в проекте. Для следующих пакетов окружение необходимо проверить отдельно.

Уточнение задачи 2 по исходникам и failing test: native ZPL интерпретирует
sizeMm как размер модуля, поэтому 24 мм превращались в ^BXN,192 при 203 dpi.
Новый режим печатает один и тот же GS1-растр через TSPL BITMAP / ZPL ^GFA;
geometry preview получает тот же opt-in. Это техническое уточнение сохраняет
согласованный размер целого кода и поведение всех старых вызовов.

2026-09-08: задача 2 завершена. Domain: 583 теста прошли; typecheck (src/test),
lint и build прошли. Новый флаг kmDataMatrix=raster включается только явно,
legacy golden tests не изменены. Физический принтер не запускался.

2026-09-08: задача 3 завершена. Первые 33 теста переходов наблюдались падающими
до реализации; итоговая suite содержит 39 проверок, включая полную матрицу
исходящих событий. Всего domain: 622 теста прошли, typecheck/lint/build прошли.
Projection дополнен immutable origin и bytes/language/DPI, чтобы чистый reducer
отклонял подмену смены, политики или содержимого между попытками.
Контрольная точка 1 (задачи 1–3) завершена; UI, БД, sync и аппаратная приёмка
ещё не реализованы. Следующая контрольная точка — задачи 4–7.
