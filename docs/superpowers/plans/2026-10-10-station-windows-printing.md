# Station Windows Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution method is selected by the user after plan review; this document does not authorize execution, commits, push, release or deployment.

**Goal:** Добавить печать всех этикеток Station через драйвер Windows, сохранив явный выбор ZPL/TSPL и воспроизведение существующих заданий.

**Architecture:** Общая модель этикетки получает новый выходной формат `mono-raster-v1`; Windows GDI отправляет его через выбранную установленную очередь. RAW остаётся отдельным режимом с прежними байтами. Сохранённый артефакт, снимок назначения и durable-попытка защищают восстановление от повторной отправки; сервер и история заранее получают совместимый контракт.

**Tech Stack:** TypeScript, Zod 4, React, Tauri 2, Rust/windows-sys 0.61, GDI, SQLite, Drizzle, NestJS, Vitest, Playwright, Kotlin/JUnit. Использовать имеющийся `bwip-js` 4.11.2; новые runtime-зависимости для формирования штрихкодов не нужны.

**Spec:** [Утверждённая спецификация](../specs/2026-10-10-station-windows-printing-design.md).

## Global Constraints

- Существующие профили, назначения и незавершённые задания сохраняют прежнее поведение.
- В профиле добавить явный режим `raw | windows_driver`. Отсутствующий режим старого профиля трактуется как `raw`.
- `PrinterLanguage` остаётся `zpl | tspl`; Windows не становится языком принтера.
- Валидатор запрещает `windows_driver` для TCP/serial и неизвестные режимы.
- Новые профили тоже начинают с существующего RAW-режима.
- Для первой версии поддерживаются существующие 203 и 300 DPI.
- Не применять fit-to-page, автоматический поворот или скрытое масштабирование.
- Перед любой отправкой сохраняется факт `sending`.
- Сбой/перезапуск после начала попытки переводит её в `delivery_unknown`; автоматическая повторная отправка запрещена.
- Старые события, закреплённые batch payload и их digest никогда не переписываются.
- Совместимый API и кабинет должны быть опубликованы до Station, способной создавать новые события.
- Нативный Bluetooth discovery, pairing, BLE и новый Bluetooth-транспорт в эту работу не входят.
- Node >=24, Corepack и версия pnpm из репозитория. Изолированные mutable `node_modules`/`dist`; не менять пользовательскую `.env` и общую БД.
- Сначала failing test, затем реализация и проверка. Не печатать полный КМ, байты этикетки или чувствительный контекст в логах.
- Коммиты/пуш/PR/релиз/деплой требуют соответствующего разрешения пользователя; шаги commit из общего шаблона навыка здесь заменены проверкой scoped diff.

## Review Focus

1. Старый JSON профиля без `mode` и compare-and-swap замены: чтение не должно менять сериализацию и делать законную замену невозможной. Задача 5.
2. Драйвер принимает DEVMODE, но меняет DPI/бумагу или обрезает край: отказ до StartDoc, без масштабирования. Задача 4.
3. Windows приняла задание, ответ потерян, ID позже повторно использован очередью: отсутствие/совпадение ID не доказывает результат исходной печати. Задачи 4, 6, 7.
4. Шаблон 203 DPI печатается на 300 DPI; старый API сравнивает эти значения и отправляет событие в карантин. Отделить DPI шаблона от DPI устройства. Задача 2.
5. Режим изменён, пока шла печать или остался remote reprint: использовать сохранённый профиль/формат и явное восстановление, не новые настройки. Задачи 5–8.

## Основания и границы

План сверён с кодом рабочего checkout 2026-10-10. В нём есть чужие изменения
`apps/admin/src/pages/shifts/ProductLabelHistory.tsx`, переводов, CSS, теста
истории и `tools/production-browser/product-labels-tests/admin.spec.ts`.
Не переносить их в эту задачу и не перезаписывать. Во время исполнения
проверить актуальный base и работать в отдельном checkout/ветке.

Найдены два важных отличия между концепцией и текущим кодом:

- `product-label-events.ts` действительно сравнивает `event.dpi` с DPI
  сохранённого шаблона, хотя Station уже рендерит под DPI принтера.
  Исправление включено как необходимое для нового режима; проверки policy,
  tenant, actor, payload и template digest сохраняются.
- В `LabelTemplateSpec` сейчас нет пользовательского поля поворота.
  Не добавлять редактор вращения и новый формат шаблонов. Обрабатывать
  существующие элементы и явно проверять ориентацию бумаги в драйвере;
  неизвестные поля нового raster-входа отвергать строгой схемой.

Состояния коробов/паллет сейчас не идентичны товарному журналу. Новый Windows
путь получает локальную запись доставки рядом с текущими бизнес-фактами;
не переписывать существующие inventory wire-events и не переименовывать
историческое `printed` в рамках этой задачи. В UI нового пути объяснять
«отправлено в очередь» и отдельную проверку сканированием.

## Порядок и карта файлов

```text
1. Канонический raster ──┬── 3. Renderer ───────┐
                       ├── 4. Windows GDI ────┤
2. Общий контракт/API ──┤                       ├── 7. Все потоки ── 8. UI ── 9. Приёмка
5. Профили ────────────┴── 6. Журнал доставки ─┘
```

Это порядок зависимостей, а не разрешение запускать параллельных агентов.
Рекомендуемый порядок исполнения одним агентом: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9.

| Область                                                                         | Ответственность                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/domain/src/labels/mono-raster.ts` (новый)                             | Версия/геометрия/кодирование/валидация бинарного артефакта |
| `packages/domain/src/labels/mono-render.ts`, `barcodes/label-raster.ts` (новые) | Композиция страницы и адаптация имеющегося encoder         |
| `packages/domain/src/product-labels/{contracts,state,fixtures}.ts`              | Два варианта prepared, совместимость проекций/повторов     |
| API station-scans и shifts                                                      | Приём, повторы batch, история, tenant isolation            |
| `apps/station/src-tauri/src/{printer_raster,printer_windows}.rs` (новые)        | Безопасный decoder, Win32 adapter и job lookup             |
| Station hardware/config/routing                                                 | Типизированный выбор режима и API оборудования             |
| DB SQLite schema/migrations + Station `print-deliveries.ts` (новый)             | Durable claims, receipts, unknown delivery, retention      |
| Station render/printing/hooks/screens                                           | Применение режима во всех реальных потоках                 |
| Station setup/recovery/i18n                                                     | Выбор режима, preview того же артефакта, восстановление    |
| CI + runbook                                                                    | Покрытие Windows/Kotlin, браузерная и аппаратная приёмка   |

## Подготовка исполнения

- [ ] Прочитать root и scoped AGENTS.md для Station/API/Handheld, спецификацию
      и этот план; сохранить `git status --short` и SHA base. Через
      `list_artifacts` выбрать подходящий checkout или `create_worktree` создать
      из проверенного base, не наследуя автоматически текущую
      `codex/conflicts-readable-values`.
- [ ] Перенести только утверждённую спецификацию и план в task checkout,
      если их ещё нет в base. Для ветки использовать `codex/station-windows-printing`.
- [ ] Установить зависимости штатно; собрать domain/db/ui/platform-contracts
      перед consumer-командами. Проверить доступность отдельной тестовой БД,
      Windows runner и Android SDK; отсутствующие проверки записать как NOT RUN.

```bash
git status --short
git rev-parse HEAD
corepack pnpm install --frozen-lockfile
corepack pnpm turbo run build --filter='@markiro/station^...' --filter='@markiro/api^...'
```

## Task 1: Канонический растровый артефакт

**Files:** Create `packages/domain/src/labels/mono-raster.ts`,
`packages/domain/test/labels-mono-raster.test.ts`; modify
`packages/domain/src/index.ts`. Общие TS/Rust vectors хранить в новом
`packages/domain/test/fixtures/mono-raster-v1.json` без реальных КМ.

**Interfaces:**

```ts
export interface MonoRaster {
  format: "mono-raster-v1";
  widthMm: number;
  heightMm: number;
  dpi: 203 | 300;
  widthDots: number;
  heightDots: number;
  stride: number;
  requiredBounds: { left: number; top: number; right: number; bottom: number };
  pixels: Uint8Array;
}
export function encodeMonoRaster(value: MonoRaster): Uint8Array;
export function decodeMonoRaster(bytes: Uint8Array): MonoRaster;
```

- [ ] Добавить failing tests на фиксированные бинарные vectors, усечение,
      неизвестную версию, NaN/Infinity, переполнение, лишний хвост и ненулевые
      padding bits. Не ограничиваться round-trip одного encoder/decoder.

```ts
it("rejects a length mismatch before allocating a bitmap", () => {
  const pixels = new Uint8Array(800);
  const bytes = encodeMonoRaster({
    format: "mono-raster-v1",
    widthMm: 10,
    heightMm: 10,
    dpi: 203,
    widthDots: 80,
    heightDots: 80,
    stride: 10,
    requiredBounds: { left: 0, top: 0, right: 0, bottom: 0 },
    pixels,
  });
  expect(bytes.length).toBe(864);
  expect(() => decodeMonoRaster(bytes.subarray(0, 863))).toThrow();
  expect(Array.from(bytes.subarray(0, 8))).toEqual([77, 75, 82, 77, 78, 79, 49, 0]);
});
```

- [ ] Запустить `corepack pnpm --filter @markiro/domain exec vitest run test/labels-mono-raster.test.ts`.
      Ожидается FAIL из-за отсутствующего encoder; сохранить причину.
- [ ] Реализовать wire layout ниже через DataView с little-endian числовыми
      полями. Полярность 1=чёрный, строки top-down, MSB-first; padding bits = 0.

| Offset  | Тип        | Поле                                      |
| ------- | ---------- | ----------------------------------------- |
| 0       | 8 bytes    | `MKRMNO1\0`                               |
| 8       | uint32 LE  | dpi                                       |
| 12 / 16 | uint32 LE  | widthDots / heightDots                    |
| 20      | uint32 LE  | stride = ceil(widthDots / 8)              |
| 24 / 32 | float64 LE | widthMm / heightMm                        |
| 40      | uint32 LE  | pixels.length = stride × heightDots       |
| 44      | uint32 LE  | reserved = 0                              |
| 48 / 52 | uint32 LE  | requiredBounds.left / top                 |
| 56 / 60 | uint32 LE  | requiredBounds.right / bottom (exclusive) |
| 64      | bytes      | pixels                                    |

Принимать только конечные размеры 10–300 мм и DPI 203/300; dots должны
точно совпасть с текущим `mmToDots`. Полный артефакт ≤2 MiB; проверять
арифметику и ожидаемую длину до выделения массива. `bytesDigest` считать
имеющимся `productLabelBytesDigest` по всему артефакту, включая заголовок.

`requiredBounds` — объединённая область всех элементов вместе с обязательными
защитными полями штрихкодов, в координатах страницы. Для пустой страницы все
четыре значения нулевые. Decoder проверяет упорядоченность/границы и отсутствие
чёрных пикселей вне requiredBounds. Renderer вычисляет эту область из геометрии,
а не только из чёрных пикселей: белая quiet zone тоже требует места на бумаге.
Эта метаинформация позволяет Windows отличать допустимые белые поля от
обрезанной обязательной quiet zone и также входит в digest.

- [ ] Повторить focused test; запустить domain test/typecheck/lint/build.
      Проверить, что golden RAW fixtures не изменены.

## Task 2: Совместимый контракт событий, API, история и Kotlin

**Files:** Modify domain `product-labels/contracts.ts`, `state.ts`, `fixtures.ts`,
`history.ts` только при необходимости типов; tests
`product-labels-contracts.test.ts`, `product-labels-state.test.ts`,
`product-label-fixtures.test.ts`. Modify API
`src/modules/station-scans/product-label-events.ts`, tests
`station-product-label-events.e2e.test.ts`, `product-label-history.e2e.test.ts`.
Consumer tests: `apps/admin/test/product-label-history.test.tsx` и
`apps/admin/src/pages/shifts/product-labels-api.ts`.
Kotlin: `core/duplicate/ProductLabelEvents.kt`, `DuplicateJobs.kt`,
`core/storage/ProductLabelEntities.kt` только если компиляция требует адаптации;
`core/duplicate/ProductLabelFixturesTest.kt` и `DuplicateJobsTest.kt`.
Ресурс `apps/handheld/app/src/test/resources/product-label-fixtures.json`
обновляется только генератором domain.

**Interfaces:** Общие поля prepared неизменны. Формат — строгое объединение:

```ts
type ProductLabelPrintIdentity =
  | { language: "zpl" | "tspl"; dpi: 203 | 300; bytesDigest: string }
  | { printFormat: "mono-raster-v1"; dpi: 203 | 300; bytesDigest: string };

export function productLabelPrintFormat(
  value: ProductLabelPrintIdentity,
): "zpl" | "tspl" | "mono-raster-v1" {
  return "printFormat" in value ? value.printFormat : value.language;
}
```

Не добавлять default-поля в старые parsed events. Для двух `kind: prepared`
использовать верхнеуровневый `z.union` из двух strict prepared schemas и
отдельного discriminatedUnion остальных kind: нельзя создать два одинаковых
discriminator в одном плоском discriminatedUnion. Существующие `reason`,
attemptNo и базовые invariant refinements применить к обеим веткам.

- [ ] Дополнить существующий тест с его `prepared` fixture:

```ts
it("accepts raster without rewriting legacy events", () => {
  const { language, ...common } = prepared;
  expect(language).toBe("tspl");
  const raster = { ...common, printFormat: "mono-raster-v1" };
  expect(domain.productLabelEventSchema.parse(prepared)).toEqual(prepared);
  expect(domain.productLabelEventSchema.parse(raster)).toEqual(raster);
  expect(domain.productLabelEventSchema.safeParse({ ...raster, language }).success).toBe(false);
});
```

Добавить transitions: повтор с другим форматом/DPI/digest отклоняется;
raster → sending → sent → verified проходит с точным payload digest;
старые saved projections без нового поля читаются без rewrite.

- [ ] Запустить domain focused suites и получить FAIL, затем реализовать
      union проекции с сохранением прежней raw-формы. В reprint-сравнениях
      использовать `productLabelPrintFormat`, не nullable-псевдоязык.
- [ ] Добавить API e2e на 203-DPI snapshot + 300-DPI prepared для обоих
      форматов. При корректных policy/template/payload digests все события
      принимаются. Удалить только ошибочное равенство DPI шаблона и принтера:

```ts
const policyMatches =
  shift.mode === "validation" &&
  shift.status !== "planned" &&
  policy.mode === "duplicate_dm" &&
  event.policyRevision === policy.policyRevision &&
  event.templateDigest === policy.snapshot.digest;
```

Это условие заменяет соответствующий блок, а не проверки actor, parent,
scan ownership и tenant. Дополнить e2e: повтор одного batch сохраняет
receipts, смешанный формат отклоняется, другой tenant/device не видит
историю. Утвердить точные eventId/operatorId/target/result в фактах аудита.

- [ ] Добавить raster case в generator fixtures. В Kotlin сделать
      `printFormat: String? = null`, `language: String?` для общей event/projection
      модели, явную функцию нормализации и проверку допустимых комбинаций.
      `toWireJson()` для RAW выдаёт прежние ключи, для raster — `printFormat`
      вместо `language`. `DuplicateJobs` разрешает локальную отправку только
      имеющихся RAW-форматов; неизвестный/raster job не превращается в ZPL.
- [ ] Проверить admin API-client с новой историей. Текущий UI не выводит язык:
      не переделывать его внешний вид и не переносить чужие текущие изменения.
      Дополнительный label «Через Windows» нужен только там, где реально
      отображается формат. Сверить опубликованные OpenAPI схемы с новым union.
- [ ] Запустить focused suites после сборки domain/db; regenerate fixtures и
      выполнить Kotlin fixture test. Далее package gates API/admin/domain и
      Android `testDebugUnitTest lintDebug assembleDebug`.

```bash
corepack pnpm --filter @markiro/domain fixtures:product-labels
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api exec vitest run test/station-product-label-events.e2e.test.ts test/product-label-history.e2e.test.ts
corepack pnpm --filter @markiro/admin exec vitest run test/product-label-history.test.tsx
```

API e2e требуют отдельную подготовленную БД. Пропуски не считаются подтверждением.
Изменение протокола additive на стороне обновлённого сервера; старый сервер
новую форму не понимает. Эта задача — отдельная поставляемая часть, которую
нужно выпустить раньше Station, но публикацию сейчас не выполнять.

## Task 3: Renderer всей страницы и preview одного артефакта

**Files:** Create domain `labels/mono-render.ts`, `barcodes/label-raster.ts`,
tests `labels-mono-render.test.ts`; use existing `labels/text.ts`, `wrap.ts`,
`code128.ts`, `barcodes/gs1-data-matrix.ts`. Create Station
`src/lib/print-artifact.ts`, `src/ui/LabelRasterPreview.tsx`,
tests `print-artifact.test.ts`, `label-raster-preview.test.tsx`.
Existing `print-label.ts` remains the RAW implementation.

**Interfaces:**

```ts
export type PrintArtifact =
  | { format: "zpl" | "tspl"; dpi: 203 | 300; bytes: Uint8Array }
  | { format: "mono-raster-v1"; dpi: 203 | 300; bytes: Uint8Array };

export function renderMonoLabel(
  spec: LabelTemplateSpec,
  fields: Record<LabelField, string>,
  rasterizeText: RasterizeTextFn,
): Promise<MonoRaster>;

export function renderPrintArtifact(
  spec: LabelTemplateSpec,
  fields: Record<LabelField, string>,
  profile: PrinterProfile,
  rasterizeText: RasterizeTextFn,
  options?: { kmDataMatrix?: "native" | "raster" },
): Promise<PrintArtifact>;
```

- [ ] Добавить failing tests с имеющимся `sampleLabelData()` и явно
      заданными line/box/text/field/barcode элементами; bitmap assertions
      проверяют ожидаемые координаты/чёрные пиксели и чистые padding bits.

```ts
it.each([203, 300] as const)("keeps label geometry at %i dpi", async (dpi) => {
  const spec = { widthMm: 58, heightMm: 40, dpi, language: "zpl" as const, elements: [] };
  const rasterizeText: RasterizeTextFn = async () => {
    throw new Error("an empty label must not rasterize text");
  };
  const page = await renderMonoLabel(spec, sampleLabelData(), rasterizeText);
  expect(page.widthDots).toBe(dpi === 203 ? 464 : 685);
  expect(page.heightDots).toBe(dpi === 203 ? 320 : 472);
  expect(page.pixels.every((byte) => byte === 0)).toBe(true);
});
```

- [ ] Запустить focused test с ожидаемым FAIL; реализовать белый canvas как
      packed bitmap, blit с OR-композицией, линии и рамки в целых точках.
      Использовать существующие подстановки полей, форматирование даты/КМ,
      выравнивание, перенос/ellipsis и bitmap текста. Запретить выход элемента
      или обязательной quiet zone за страницу. Для нового пути дождаться
      загрузки локальных шрифтов; ошибка загрузки не подменяется незаметно
      другим шрифтом. Старый RAW rasterizer не менять без отдельного теста.
- [ ] Для `km.code` переиспользовать `rasterizeGs1DataMatrix` с текущей
      семантикой whole-symbol extent. Остальные форматы `code128`, `ean13`,
      `datamatrix`, `qr` кодировать `bwip-js/generic` в дискретные модули;
      не считать width-only функцию `code128.ts` полноценным encoder.
      Для SSCC сохранить AI 00 и GS1 FNC1. При отсутствии moduleWidthMm
      нового raster-пути брать 2 точки; это фиксированное правило нового
      режима, не изменение printer-modal default старого ZPL.
      Общий literal Data Matrix/QR сохраняет модель размера модуля из
      `model.ts`; товарный `km.code` сохраняет специальную семантику
      существующего duplicate renderer. Quiet zones брать из спецификации
      соответствующего barcode, а не подбирать по размеру страницы.
- [ ] Расширить имеющийся независимый test decoder
      `packages/domain/test/helpers/decode-data-matrix.js` для извлечения
      символа из полной страницы, сохранить проверку полного crypto tail.
      Для линейных кодов проверять checksum/FNC1 и восстановленную строку
      по независимым эталонным модулям; для QR — независимый decode в
      browser/acceptance harness. Не выдавать сравнение двух bwip-выходов
      за независимое декодирование. Если отдельного decoder ещё нет,
      добавить test-only decoder с точной версией через pnpm и проверить
      dependency policy; не добавлять его в bundle Station.
- [ ] Реализовать Station wrapper: raw вызывает существующий
      `renderLabelBytes`; driver требует явный DPI, вызывает `withPrinterDpi`,
      `renderMonoLabel`, `encodeMonoRaster`. Preview декодирует именно
      `PrintArtifact.bytes`, рисует пиксели без сглаживания и не читает каталог.
- [ ] Запустить domain gates и Station focused tests после domain build.
      Проверить длинную кириллицу, пустые поля, обратные/диагональные линии,
      шаблоны 10/300 мм, крупные crypto tail, неверные данные и quiet zones.

## Task 4: Win32 GDI adapter и аппаратный контракт Tauri

**Files:** Create `apps/station/src-tauri/src/printer_raster.rs`,
`printer_windows.rs`; modify `printer.rs`, `lib.rs`, capabilities при
необходимости регистрации новой команды; modify Station `hardware.ts`,
`test/hardware.test.ts`. Rust pure tests располагаются в новых модулях.

**Interfaces:**

```ts
export interface WindowsPrintReceipt {
  queue: string;
  jobId: number;
  documentName: string;
}
export type WindowsPrintFailure = {
  code:
    | "unsupported_platform"
    | "invalid_artifact"
    | "queue_unavailable"
    | "geometry_mismatch"
    | "driver_failure";
  phase: "before_start" | "delivery_unknown";
  receipt?: WindowsPrintReceipt;
};
export type WindowsPrintResult =
  { ok: true; receipt: WindowsPrintReceipt } | { ok: false; error: WindowsPrintFailure };
export type WindowsJobObservation =
  | { state: "present"; statusFlags: number }
  | { state: "absent" | "identity_mismatch" | "unavailable" };
```

Добавить методы `HardwareContract`:
`supportsWindowsPrinting(): Promise<boolean>`,
`preflightWindowsRaster(queue: string, bytes: Uint8Array): Promise<{ ok: true } | { ok: false; error: WindowsPrintFailure }>`,
`printWindowsRaster(queue: string, bytes: Uint8Array, documentName: string): Promise<WindowsPrintResult>`,
`getWindowsPrintJob(receipt: WindowsPrintReceipt): Promise<WindowsJobObservation>`.
Имена Tauri-команд: `supports_windows_printing`, `preflight_windows_raster`, `print_windows_raster`,
`get_windows_print_job`. `print(target, bytes)` сохраняется для RAW.
Не определять ОС по browser user-agent.

Preflight создаёт временный DC и проверяет геометрию, но не вызывает StartDoc
и не резервирует задание. Команда отправки повторяет проверку, поскольку
настройки драйвера могли измениться. Успешный preflight не гарантирует успешную
последующую отправку. Ошибка preflight может стать `failed_before_send` до
product sending; после durable product sending любой новый отказ сохраняется
как unknown согласно существующему автомату, без запрещённого перехода назад.
Подробный код ошибки остаётся локально; wire errorCode использует существующие
`printer_unconfigured` / `printer_changed` до claim и `transport_failed` после.

- [ ] Сначала Rust decoder tests по vectors Task 1, потом tests fake-GDI
      последовательности: отказ geometry не вызывает StartDoc; ошибка после
      StartDoc возвращает receipt/unknown; Drop освобождает DC/handle один раз.
      Для изоляции выделить внутренний `WindowsPrintApi` trait с операциями
      open/configure/begin/page/draw/end/abort и fake, записывающим вызовы.

```rust
#[test]
fn truncated_raster_is_rejected() {
    assert!(decode_mono_raster(b"MKRMNO1\0").is_err());
}
```

- [ ] Запустить `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`.
      Ожидаемый FAIL на новых tests до реализации. Не устанавливать обходные
      stubs Win32 для получения зелёной сборки.
- [ ] Реализовать decoder с checked arithmetic и лимитом base64 **до**
      decode; 2 MiB бинарного артефакта → не более `4 * ceil(2097152 / 3)`
      base64-символов. Отвергать embedded NUL и пустое имя очереди.
- [ ] В adapter получить DEVMODE с полным driver-private хвостом через
      DocumentPropertiesW; клонировать для документа. Поставить одну копию,
      portrait, размеры в десятых мм и requested resolution; проверить
      результат DocumentPropertiesW и затем GetDeviceCaps printer DC.
      Проверить LOGPIXELSX/Y, PHYSICALWIDTH/HEIGHT, HORZRES/VERTRES и
      PHYSICALOFFSETX/Y. Допуск сравнения физического размера — максимум
      одна точка округления; фактический bitmap не масштабировать.
- [ ] Перепаковать строки под DWORD-aligned DIB, палитра index 0=white,
      index 1=black, задать top-down bitmap. Draw 1:1; учитывать origin и
      непечатаемые поля. Разрешить белые поля за printable area, но отказать
      при попадании туда содержимого или обязательной quiet zone. Страница
      с обрезанным кодом не должна считаться успешно отправленной.
      Проверять `requiredBounds` из сохранённого заголовка; при draw можно
      передать только пересечение страницы и printable area, сохраняя 1:1
      координаты и не обрезая requiredBounds.
- [ ] StartDocW/StartPage → bitmap → EndPage/EndDoc; после начала документа
      любой сбой/неполный draw/неуспешный EndDoc считается unknown. AbortDoc —
      best effort cleanup, не доказательство отсутствия физической печати.
      `documentName = "Markiro:" + attempt UUID`, без КМ/товара/оператора.
      Возвращать receipt и на поздней ошибке. IPC rejection без structured
      результата трактуется на стороне Station консервативно как unknown.
- [ ] Job lookup сверяет queue, jobId и documentName. Не использовать один
      jobId для подтверждения оригинального задания: ID может быть повторно
      использован. Вызовы выполняются в spawn_blocking, не блокируют UI.
      На другой ОС driver command возвращает unsupported_platform.
- [ ] Проверить Tauri invoke mock на точные аргументы/base64 и выбор RAW
      команды. Host Cargo tests + реальная Windows compile обязательны;
      Windows tests fake-adapter выполнять в `station-windows-build` job.

Документация Win32 — ссылки из спецификации. Перед реализацией подтвердить
точные signatures в установленном `windows-sys`; существующий Cargo.toml
уже включает Graphics_Gdi и Graphics_Printing. Не обновлять crate без нужды.

## Task 5: Профили и совместимость сохранённых назначений

**Files:** Modify Station `hardware-config.ts`, `printer-routing.ts`,
`print-destinations.ts`, tests `hardware-config.test.ts`,
`printer-routing.test.ts`, `print-destinations.test.ts`.

**Interfaces:** В `PrinterProfile` добавить
`mode?: "raw" | "windows_driver"` и helper:

```ts
export function printerMode(profile: PrinterProfile): "raw" | "windows_driver" {
  return profile.mode ?? "raw";
}
```

`language` сохраняется как предыдущий RAW-выбор даже в driver profile,
но не используется для artifact identity. Type guard driver profile
дополнительно требует `target.kind === "usb"` и DPI 203/300.

- [ ] Тестировать старый literal profile JSON без mode, read → replace,
      сохранение нового режима, ошибочный режим/target и назначение каждой роли.

```ts
it("does not inject mode into a legacy profile used by compare-and-swap", () => {
  const stored = {
    id: "p",
    name: "Printer",
    target: { kind: "usb", printer: "Queue" },
    language: "zpl",
    dpi: 203,
  };
  const parsed = parsePrinterProfile(stored);
  expect(parsed).not.toBeNull();
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(stored));
});
```

- [ ] Получить FAIL на новых driver tests, затем расширить parser, сохраняя
      отсутствие поля для старых профилей. Не добавлять `mode: raw` через default
      в сохранённый объект. Проверить реальную CAS на pooled SQLite, не только
      JSON test. При изменении сериализации использовать сохранённый original
      JSON как CAS token, а не сериализацию нормализованной копии.
- [ ] Ключ `printerTargetKey` не включает режим/язык/DPI. Два режима одной
      очереди остаются одной физической очередью; FIFO сериализация используется
      общей обёрткой и для RAW, и для driver. Не давать молча пересоздать
      существующий профиль при дубликате endpoint.
- [ ] Проверить, что explicit unassigned не fallback-ится в legacy config,
      смена текущего режима не меняет pinned destination старого задания, а
      восстановление RAW требует того же языка/DPI, raster — того же формата/DPI.
- [ ] Выполнить три focused suites и Station typecheck после сборки deps.

## Task 6: Локальная попытка Windows, receipt и retention

**Files:** Modify `packages/db/src/sqlite/schema.ts`, append migration в
`packages/db/src/sqlite/migrations.ts`; create DB
`test/printer-deliveries-sqlite.test.ts`, Station
`src/lib/print-deliveries.ts`, `test/print-deliveries.test.ts`.
Связанные файлы retention: Station `product-labels/retention.ts` и
существующие cleanup-функции, удаляющие printer_destinations.

**Interfaces:** Не расширять immutable server-events сведениями Windows.
Локальная запись содержит purpose, scope, job/attempt IDs, сохранённый
профиль, digest артефакта, state, documentName и nullable receipt.
Для production использовать существующий `PrintDestinationKey`; для
test-print — отдельный scope текущего владельца и purpose `test`.

```sql
CREATE TABLE printer_deliveries (
  scope TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('test','box','pallet','duplicate')),
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','sending','sent','failed_before_send','delivery_unknown')),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  artifact_digest TEXT NOT NULL,
  artifact_base64 TEXT,
  document_name TEXT NOT NULL,
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope,purpose,job_id,attempt_id),
  CHECK ((purpose='duplicate' AND artifact_base64 IS NULL)
    OR (purpose<>'duplicate' AND artifact_base64 IS NOT NULL
      AND length(artifact_base64) <= 2796204))
);
```

Store bounded `artifact_base64` только для Windows box/pallet/inventory/test
попыток, чтобы восстановить фактически отправленный артефакт и preview.
Для duplicate источник остаётся `product_label_accept_commands.bytes_base64`:
не создавать расходящиеся копии. Поле ограничено длиной base64 для 2 MiB;
сохранение выполняется до начала отправки.

```ts
export interface DeliveryKey {
  scope: string;
  purpose: "test" | "box" | "pallet" | "duplicate";
  jobId: string;
  attemptId: string;
}
export function claimPrintDelivery(exec: SqlExecutor, key: DeliveryKey): Promise<boolean>;
export function recordPrintDeliveryResult(
  exec: SqlExecutor,
  key: DeliveryKey,
  result: WindowsPrintResult,
): Promise<void>;
```

- [ ] Написать failing SQLite tests на old DB upgrade без потери очередей,
      две конкурирующие claims, повторный результат и поздний ответ старого
      владельца. Claims выполнять одним SQL statement:

```sql
UPDATE printer_deliveries SET state='sending', updated_at=?
WHERE scope=? AND purpose=? AND job_id=? AND attempt_id=? AND state='prepared'
RETURNING attempt_id;
```

Ровно один claimant получает строку. Добавить ownership predicate из
существующих lease/credential guards; не выносить его в stale pre-read.

- [ ] Запустить DB/Station focused tests, затем append DDL в authoritative
      migration list; обновить Drizzle mirror и runtime migration tests.
      Старые migration strings не менять. Номер SQL-файла Postgres не нужен:
      здесь меняется SQLite, а серверные events/projections уже JSON.
- [ ] Реализовать prepare/claim/result CAS. При недоказанном результате
      после claim сохранять unknown. После restart оставшиеся sending становятся
      unknown, никогда prepared. Не переписывать существующий receipt другим
      документом; stale attempt/owner response не меняет новый active job.
- [ ] Согласовать с duplicate journal: сначала preflight и подготовка
      локального metadata, затем существующий durable product `sending`,
      затем CAS Windows delivery `sending`, только потом transport.
      Сбой между двумя записями восстанавливается по наиболее консервативному
      факту; наличие product sending запрещает повтор независимо от sidecar.
      Pooled SQL не оборачивать несколькими вызовами BEGIN/COMMIT.
- [ ] Retention: unresolved deliveries блокируют удаление родительского
      задания и его сохранённых байтов; acknowledged/resolved entries удаляются
      вместе с разрешённой parent-retention. Для тестовой печати resolved
      records удаляются при следующей успешной очистке настроек; unresolved
      остаются до явного решения оператора. Проверить cleanup/re-pair/close,
      не допустить роста неприкреплённых prepared metadata после отказа scan.
- [ ] Для удаления родителей использовать явные guards на unresolved
      deliveries; одного CASCADE недостаточно, он может уничтожить recovery.
      Удаление resolved delivery и разрешённая parent-retention выполняются
      одной транзакцией на выделенном соединении или существующим SQL trigger.
- [ ] DB test/typecheck/lint/build; затем Station focused tests с rebuilt db.
      Отдельно проверить, что pinned старый batch и event bytes не изменились.

## Task 7: Подключение всех печатных потоков и recovery

**Files:** Create Station `src/lib/print-output.ts`; modify
`box-printing.ts`, `inventory-box-label.ts`, `inventory-box-printing.ts`,
`product-labels/{types,fields,validation,store,printing,recovery}.ts`,
`use-product-label-work.ts`, `pages/WorkScreen.tsx`,
`pages/InventoryWorkScreen.tsx`, `pages/WorkstationSetup.tsx`, вызывающие
их composition roots. Tests: `box-printing.test.ts`,
`inventory-box-printing.test.ts`, `product-labels-fields.test.ts`,
`product-labels-printing.test.ts`, `product-labels-recovery.test.ts`,
`product-labels-sync.test.ts`, `product-label-work-screen.test.tsx`,
`inventory-repack-print-recovery.test.tsx`.

**Interfaces:** Единая dispatch-функция получает уже сохранённый профиль,
artifact и delivery key; никаких чтений текущей настройки внутри transport.

```ts
export interface PrintOutputDeps {
  exec: SqlExecutor;
  hardware: HardwareContract;
}
export function sendPrintArtifact(
  deps: PrintOutputDeps,
  key: DeliveryKey,
  profile: PrinterProfile,
  artifact: PrintArtifact,
): Promise<WindowsPrintResult | { ok: true; raw: true }>;
```

RAW failures сохраняют текущую обработку вызывающего кода; общий helper не
преобразует исключение в успех. Driver errors после claim превращаются
в durable unknown. В typed result для известных ошибок до send добавить
обработку на месте вызова без записи фиктивного `sent`.

- [ ] Создать таблицу parameterized tests по purpose и режимам. Для каждого:
      выбран корректный transport, одна этикетка/копия, верные поля/даты/SSCC,
      offline send, отказ после StartDoc не подтверждает печать.
      В existing printing suite с fixture helpers добавить assertion pattern:

```ts
expect(sentArtifact.bytes).toEqual(preparedArtifact.bytes);
expect(transportCalls).toHaveLength(1);
expect(recoveredAttempt.attemptState).toBe("delivery_unknown");
expect(recoveredAttempt.verificationOutcome).toBe("pending");
```

`sentArtifact`, `preparedArtifact`, `transportCalls`, `recoveredAttempt`
— захваченные значения транспорта, подготовки и перечитанного journal
данного теста; не подменять их fabricated snapshot.

- [ ] Получить FAIL и заменить связку renderer/transport в production callers
      на `renderPrintArtifact`/`sendPrintArtifact`. Проверить повторным `rg`,
      что прямые вызовы `renderLabelBytes` остаются только внутри RAW adapter
      и его tests. Test print проходит тот же dispatch и очередь.
- [ ] Duplicate acceptance сохраняет encoded raster в существующем
      bytesBase64 и новый prepared event. Validation сверяет header/DPI/digest,
      fields и canonical full code. Reprint использует сохранённые байты;
      смена каталога/даты/шаблона и RAW preference не пересоздаёт этикетку.
- [ ] Для box/pallet/inventory сохранить прежние бизнес-факты закрытия.
      Заморозить artifact в рамках Windows-попытки; явная новая box reprint
      может регенерировать по действующим правилам, но потеря ответа той же
      попытки не разрешает новую автоматическую отправку. Текущий фиксированный
      `attemptId: label` в box/pallet destination не использовать как уникальный
      delivery attempt ID: выделять и сохранять UUID до каждой новой явной
      попытки, сохраняя имеющийся destination binding.
- [ ] Remote inventory reprint закрепляет delivery attempt за correctionId:
      повтор polling одного request не печатает дважды, interrupted/unknown
      требует оператора. Не помечать request завершённым как успешную печать
      только из-за Windows receipt; сохранить текущую семантику результата
      и отдельно доступное локальное unknown.
- [ ] В recovery читать queue observation только как подсказку. `present`
      означает возможный выход исходной этикетки; absent/unavailable/mismatch
      не доказывают отсутствие печати. Перед повтором показать предупреждение
      и потребовать явное действие; скан оригинального полного кода может
      разрешить unknown согласно текущей verification policy. Никакого
      автоматического cancel/reprint и автоматической смены backend.
- [ ] Тестировать failpoints: до/после product claim, до/после sidecar claim,
      после Windows submission, до/после result persistence; плюс double-click,
      owner change, close, unmount и resultPending. Запустить Station suite,
      а не только mocks dispatcher.

## Task 8: Выбор режима, локализация и браузерная проверка

**Files:** Modify Station `ui/setup/PrinterSetupPanel.tsx`,
`PrinterRoutingPanel.tsx`, `pages/WorkstationSetup.tsx`,
`src/i18n/{ru,en}.json`, scoped setup CSS, recovery controls и gallery
fixtures, `test/workstation-setup.test.tsx`, `test/setup-tabs.test.tsx`.
Browser: `tools/production-browser/station-inventory-tests/station-setup.spec.ts`,
`product-labels-tests/station.spec.ts`, Station browser harness.

**Interfaces:** PrinterSetupPanel получает mode/supportsWindowsPrinting и
`onModeChange`; существующий onLanguageChange сохраняется. Режим driver
не отображает ZPL/TSPL как применяемый параметр, но RAW-выбор не теряется.

- [ ] Failing component tests: очередь Windows позволяет три способа,
      TCP/serial — только ZPL/TSPL; unknown/non-Windows capability не позволяет
      выбрать driver; отсутствующая saved queue видна, тестовая печать не
      переключается на другую. Пример пользовательской проверки:

```ts
expect(screen.getByRole("radio", { name: "Через драйвер Windows" })).toBeEnabled();
expect(screen.getByRole("radio", { name: "ZPL" })).toBeVisible();
expect(screen.getByRole("radio", { name: "TSPL" })).toBeVisible();
```

- [ ] Реализовать три видимых варианта способа для Windows-подключения.
      Смена подключения с driver на прямое требует явного выбора ZPL/TSPL
      перед сохранением: не делать незаметное переключение после ошибки.
      Восстановить последний raw language при сознательном выборе RAW.
      Подписи RU/EN: «Принтер Windows» / “Windows printer”,
      «Через драйвер Windows» / “Windows driver”,
      «Напрямую по IP» / “Direct IP”, «COM-порт» / “COM port”.
      Не обещать встроенное обнаружение Bluetooth.
- [ ] Test label показывает preview из отправляемого artifact; для driver
      success текст «Отправлено в очередь Windows», для проверки сканирования —
      отдельный результат. Ошибки paper/DPI/queue/preflight объясняют действие,
      а не показывают Win32 internals или полный marking code.
- [ ] Проверить 1024×768 полного shell с status bar/footer; текущий browser
      test уже открывает полный shell, поэтому не вычитать высоту header второй
      раз. Сохранить существующие touch targets, keyboard/focus/labels и RU/EN.
      Визуально проверить сохранение режимов после reload и предупреждение
      восстановления с недоступной очередью.
- [ ] Запустить focused DOM tests, затем браузерные сценарии:

```bash
corepack pnpm --dir tools/production-browser exec playwright test --config station-inventory.playwright.config.ts station-setup.spec.ts
corepack pnpm --dir tools/production-browser exec playwright test --config product-labels.playwright.config.ts station.spec.ts
```

Использовать штатную установку отдельного browser workspace и harness configs.
Не линковать mutable node_modules из другого checkout. Скриншоты показывают
UI/preview, но не доказывают печать через реальный драйвер.

## Task 9: CI, итоговые gates и runbook Windows

**Files:** Modify `tools/ci/affected.mjs`, `tools/ci/test/affected.test.mjs`,
`.github/workflows/ci.yml`, `docs/architecture.md`,
`docs/acceptance/validation-dm-duplicate.md`; create
`docs/acceptance/station-windows-printing.md`.

- [ ] Failing affected tests для изменений domain `product-labels/state.ts`,
      `fixtures.ts` и generator: должны запускаться Android и shared consumers;
      `printer_windows.rs` запускает station Rust и Windows jobs. Текущий
      classifier явно перечисляет contracts.ts, поэтому расширить ownership
      на весь изменяемый shared product-label protocol и fixture generator.

```bash
node --test tools/ci/test/affected.test.mjs
```

- [ ] Windows job выполняет Cargo tests нового adapter плюс реальную Tauri
      compile. Linux/host job проверяет pure decoder/trait tests, не скрывая
      Windows code за успешной host-only сборкой. Не добавлять автопечать на CI.
- [ ] После relevant package gates выполнить финальную последовательность
      с безопасным test env. Не запускать DB suites против shared/prod БД.

```bash
corepack pnpm turbo lint typecheck test build --concurrency=1 --force
corepack pnpm format:check
corepack pnpm test:production-bundle:contract
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
git diff --check
graphify update .
```

В `apps/handheld`: `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`.
Отдельно browser suites Task 8. Если всё прошло и код не менялся,
повторять широкие gates без причины не нужно. Зелёные локальные проверки
не выдавать за remote CI, Windows, физический scanner/printer.

- [ ] Runbook содержит воспроизводимую матрицу:

| Сценарий                                              | Критерий                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| 2 семейства драйверов, 203/300 DPI, USB/network queue | Физический размер без масштабирования, весь код читается      |
| Все 5 потоков + переключение обратно в ZPL/TSPL       | Корректный формат и назначения, прежняя RAW-печать работает   |
| Нет бумаги/отключение во время отправки               | Unknown виден, авто-дубликатов нет                            |
| Restart после submit до локального success            | Оригинальное задание не создаётся повторно                    |
| Явный повтор, оригинал ещё в Windows queue            | Оператор видит риск и делает осознанный выбор                 |
| Серия 100 этикеток на каждую модель                   | Замер фактической скорости и числа выходов; нет потерь/дублей |
| Bluetooth COM/queue при доступном оборудовании        | Проверка отдельно с моделью и способом подключения            |

Сохранять модель, driver version, Windows version, DPI, stock size, source
SHA, измеренные размеры, результаты полного scan comparison и замеры
времени. Скорость фиксируется фактом; универсальный SLA в этой задаче
не вводится. Если оборудование отсутствует — NOT RUN, не PASS.

- [ ] Документировать порядок публикации: shared contract/API + кабинет →
      Station beta → аппаратная приёмка → решение о стабильном выпуске.
      Это инструкция для последующего разрешённого релиза, не dispatch сейчас.
      Откат с raster jobs на старую Station запрещать runbook-процедурой до
      проверки unresolved jobs и сохранности артефактов; старые сборки не умеют
      безопасно интерпретировать новый режим.
- [ ] Финальный review: scoped diff против проверенного base, статус чужих
      изменений, отсутствие секретов/чувствительных payload в logs, test report
      по каждой поверхности. Не коммитить/пушить без разрешения.

## Проверка полноты плана

| Требование спецификации                               | Задачи     |
| ----------------------------------------------------- | ---------- |
| Windows + явный ZPL/TSPL; legacy defaults             | 5, 8       |
| Все элементы, полный GS1, общий preview               | 1, 3, 8    |
| Windows geometry, без global settings/масштабирования | 4          |
| Durable отправка, receipt, неизвестный результат      | 4, 6, 7    |
| Замороженные duplicate bytes, совместимость RAW       | 1, 2, 5, 7 |
| API/admin/Kotlin, старые batches без rewrite          | 2          |
| Все Station workflows и remote recovery               | 7, 8       |
| Retention unresolved и pooled SQL                     | 6, 7       |
| Windows compile, browser, hardware отдельно           | 4, 8, 9    |
| Без нового Bluetooth transport                        | 5, 8, 9    |

План подготовлен для ревью; ни один implementation checkbox ещё не выполнен.
Предпочтительный способ исполнения — последовательно в текущем чате с
отдельным итоговым review: изменения тесно связаны форматом артефакта,
состояниями попыток и общей схемой событий. Альтернатива — subagent-driven
исполнение по задачам с review после каждой, если пользователь выберет его.
