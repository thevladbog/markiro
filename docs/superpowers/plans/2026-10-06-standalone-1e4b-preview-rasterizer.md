# План 1e4b: приложение — растеризатор, предпросмотр, выгрузки ZPL и TSPL и миниатюры шаблонов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Редактор шаблона «Маркиро Автоном» показывает макет таким, каким он печатается (предпросмотр с образцом назначения, русский текст — растром печати, предупреждение, если в шрифте нет кириллицы), выгружает его в ZPL и TSPL, а список «Шаблоны» показывает миниатюру у каждого названия; полный список категорий шаблона доступен и скринридеру, не только в подсказке-`title`. Это вторая часть плана 1e4 (1e4b, задачи 1–7); зависимость `opentype.js` 2.0.0 уже поставлена (`564cec314`).

**Architecture:**

- `src/labels/` — новый каталог печати вебвью, общий для офиса и будущей печати станции (план 2a): `rasterizer.ts` (перенос облачного и станционного `rasterizeText`, ведёт себя так же), `font-coverage.ts` (`checkFamilyCoverage`: opentype.js читает файлы `.woff` вложенного IBM Plex из ассетов приложения) и `opentype.d.ts` (объявление типов пакета).
- `src/office/templates/` — `label-renderer.ts` (перенос облачного `renderer.ts`: рисование макета через узкий интерфейс `LabelCanvas`, растры печати поверх русского текста `compositeTextRasters`, растр кода дубликата `paintCodeRasters`), `label-print.ts` (генераторы домена и растр GS1 отдельным чанком: они тянут bwip-js), `label-rendering.tsx` (контекст `LabelRendering`: контекст canvas, растеризатор, проверка шрифта, наблюдение видимости; в тестах — свой), `PreviewPane.tsx` (предпросмотр в карточке «Макет»), `TemplateThumb.tsx` (миниатюра в строке «Шаблонов»).
- Хост, `proto`, `src-tauri`, `apps/station` и `packages/*` не меняются; зависимостей сверх `opentype.js` нет.

**Tech Stack:** React 19.2, TypeScript 6 (strict), TanStack Query 5.101, react-router 8.3, i18next, `@markiro/ui` (`Alert`, `Button`, `Card`, `VisuallyHidden`), `@markiro/domain` (`generateZpl`, `generateTspl`, `rasterizeGs1DataMatrix`, `elementBoundsMm`, `needsImageRendering`, `rasterAlignOffsetDots`, `wrapTextToWidth`, `convertToMonochrome`, `bitmapToZplHex`, `mmToDots`, `ptToDots`, `ptToMm`), opentype.js 2.0.0, `@fontsource/ibm-plex-sans` и `@fontsource/ibm-plex-mono` 5.3.0 (уже прямые зависимости `apps/standalone`), Vitest 4 с jsdom, Vite 8 (rolldown).

**Спецификации:**

- Бриф контроллера — `.superpowers/sdd/1e4-design.md` (D1–D9 и постоянные правила процесса); план 1e4 — `docs/superpowers/plans/2026-10-06-standalone-1e4-template-editor.md`: схема «Часть 1e4б» (задачи 11–14), «Перенесено» и «Отклонения при исполнении».
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: §5.5 (офис), §6 (контракт), §8 (строка 1e).
- Облако (переносится своими модулями, не импортом): `apps/admin/src/labels/{rasterizer.ts,fontCoverage.ts,opentype.d.ts}`, `apps/admin/src/pages/labels/{renderer.ts,TemplateThumb.tsx,api.ts}`, `apps/admin/src/pages/labels/editor/{PreviewPane.tsx,raster-preview.ts,download.ts,index.tsx}`, тест `apps/admin/test/labels-raster.test.ts`; станция — `apps/station/src/lib/rasterizer.ts` (тот же растеризатор).

## Global Constraints

**Решения контроллера** (бриф 1e4; уточнения планировщика помечены «Уточнение»)

- D1. Слой протокола готов; редактор проверяет макет `labelTemplateSpecSchema` до записи (план 1e4). 1e4b запросов не прибавляет: миниатюры читают `getTemplate`.
- D2. Сводки списка никогда не держат макетов. Уточнение: миниатюра читает шаблон с макетом по требованию — когда её строка подходит к экрану — и кладёт его в кэш по ключу `officeKeys.templateLayout(id, rev)` = `["office", "template-layout", id, rev]` со `staleTime: Infinity`: любая запись даёт новую ревизию, поэтому пара не устаревает, а прочитанный раз макет рисуется снова сразу.
- D3. Обе роли (`useCan("editCatalog")`), вида «только чтение» нет.
- D4. Сетевых зависимостей нет: текст рисуется вложенным IBM Plex (`@markiro/ui/styles.css` уже подключает `@font-face` из `@fontsource`), проверка покрытия читает файлы `.woff` тех же пакетов через `?url` Vite (opentype.js 2.0.0 не читает WOFF2). В сборке это те же хешированные ассеты, что у `@font-face`; файлов шрифтов в репозиторий не кладётся, пакетов шрифтов не прибавляется.
- D5. `opentype.js` 2.0.0 поставлен владельцем (`564cec314`: `apps/standalone/package.json` и импортёр lockfile); новых зависимостей нет, `pnpm install` и `pnpm add` не запускаются.
- D6. Выгрузки — не запись: отказ (текст не нарисовался) показывается над кнопками, файл не сохраняется.
- D7. Названия — только текстом React и атрибутами (`escapeValue: false`); каждый видимый текст — ключ `src/i18n/ru.json`; элементы — из `@markiro/ui`; предпросмотр — изображение с именем (`role="img"`, размер этикетки), миниатюра декоративна (`aria-hidden`, название рядом), предупреждения — `Alert` (`role="alert"`).
- D8. Хост, `proto`, оболочка (`src-tauri`), станция (`apps/station`) и `packages/*` не меняются; Rust не меняется (41 набор, 453 теста Cargo).
- D9. Объём — семь задач; часть 1e4b закрывает схему задач 11–14 плана 1e4.

**Решения планировщика** (отличия от схемы плана 1e4 и от облака; каждое — с причиной)

- Растеризатор и проверка шрифтов живут в `src/labels/`, а не в `src/office/templates/` (схема): вебвью у офиса и станции одно, и печать станции (план 2a) возьмёт тот же растеризатор — «предпросмотр = печать» держится одним модулем.
- Подмена для тестов — контекст `LabelRendering`, который даёт `Office` (свойство `labels`, по умолчанию `BROWSER_LABEL_RENDERING`), а не свойства страницы редактора, как у облачного `LabelEditorPage`: страницы редактора рендерит маршрутизатор офиса. Провайдер стоит внутри `Office`, а не вокруг него в `renderOffice`: три прежних теста делают `rerender(<Office …/>)`, и обёртка снаружи пересоздала бы офис. `renderOffice` даёт `quietLabelRendering()` (нет canvas, растеризатор отказывает, проверка шрифта не отвечает, миниатюры никогда не на экране), поэтому прежние тесты не меняются, кроме помощника `names()` (задача 5) и ожидания ячейки категорий (задача 6) в `templates-page.test.tsx`. `test/setup.ts` глушит `HTMLCanvasElement.prototype.getContext` (jsdom печатает «Not implemented» в stderr).
- Рисование — через узкий интерфейс `LabelCanvas` (настоящий `CanvasRenderingContext2D` ему отвечает), чтобы тест записывал вызовы без приведений типов. Растр печати рисуется прямоугольниками по сериям чёрных точек (`paintRaster`), а не через offscreen-canvas, `ImageData` и `drawImage` облака: в jsdom нет `ImageData`, а тот же приём облако уже применяет к растру дубликата. Растр ставится в целых точках принтера (`mmToDots(xMm) + смещение выравнивания`), как его ставят `generateZpl`/`generateTspl`; облако ставило его по нецелым миллиметрам.
- Предпросмотр просит у растеризатора ровно то же, что генераторы домена (`fontFamily: "sans-serif"`, `zpl.ts`/`tspl.ts`), — облако просило «IBM Plex Sans»; тест сравнивает вызовы предпросмотра и `generateZpl` один к одному. Проверка покрытия идёт по семейству «IBM Plex Sans» (во что `mapFontFamily` превращает «sans-serif») и только пока в макете есть текст для растра, и не перезапускается на каждое изменение макета (облако читало файлы шрифтов при каждом изменении).
- Отдельные чанки. Генераторы и `rasterizeGs1DataMatrix` тянут bwip-js (около 0,9 МБ), opentype.js — около 0,2 МБ. Статический импорт поднял бы главный чанк с 864 до 2048 kB (измерено на копии), поэтому генераторы и растр GS1 грузятся динамически (`label-print.ts`), проверка шрифта — тоже (`BROWSER_LABEL_RENDERING.checkFamilyCoverage`); главный чанк вырастает примерно на 11 kB. Код дубликата поэтому рисуется вторым, асинхронным проходом (`paintCodeRasters`) и в предпросмотре, и в миниатюре.
- Миниатюра — в ячейке названия перед ним (декоративна, название рядом), а не отдельным столбцом: столбцы и их тесты не сдвигаются. Ленивость — `whenVisible` (IntersectionObserver на 200 px вперёд; без него — сразу) и `useOfficeQuery` с новым `enabled`.
- Пункт 6 очереди 1e3 (полный список категорий только в `title`): ячейка добавляет названия, когда показывает только их число, в `VisuallyHidden` («Категорий: 3 (Молочная продукция, …)»); подсказка остаётся.
- Выгрузки кода: обе кнопки выключены, пока собирается файл и пока дубликат нарушает правило (JSON — нет); отказ — `Alert`, а не тост облака (в редакторе офиса тостов нет). Байты — `latin1Bytes` (перенос облачного `latin1ToUint8Array`).
- Документы — последней задачей (задача 7); задачи 1–6 меняют только код и тесты.

**Код и процесс**

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: без `any`, приведений и `!` (в тестах тоже). Именованные экспорты, `import type`.
- Элементы управления — из `@markiro/ui`; `<canvas>` и `<figure>` — не поля и линтом не запрещены.
- Push и PR не разрешены; `git stash` не использовать; коммиты — явные пути, сообщение кончается ровно одной строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (вторым `-m`).

## Заметки для исполнения

**Правки**

- «Фрагмент … заменить на …» дан ровно так, как он стоит в файле на начало правки, с отступами; в файле он встречается один раз (план применён к копии репозитория по шагам скриптом, который проверял каждое совпадение). Правки внутри шага идут сверху вниз, одна за другой. Шаг 1 (тесты) применяется раньше шага 3 (реализация).
- «Создать» — новый файл, ровно как в блоке; «удалить фрагмент» (только в мутациях) — фрагмент убирается.
- `<!-- prettier-ignore -->` перед блоком — пометка для форматирования самого плана, а не часть фрагмента. Код в блоках уже отформатирован prettier.
- Русский текст в коде и в `ru.json` — буквами, не `\uXXXX`. Каждая задача кончается проверкой `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: единственное допустимое совпадение — `src/host/pairing-code.ts:66`.

**Мутации**

- Шаг мутаций проверяет, что тест ловит снятие защиты. Для каждой мутации: `cp <файл> /tmp/claude/before` и `shasum -a 256 <файл>`; правка из блока; команда — ожидаемый FAIL с названным тестом; затем `cp /tmp/claude/before <файл>`, `cmp /tmp/claude/before <файл>` (молчит) и снова `shasum -a 256 <файл>` — тот же хеш. Мутацию не коммитить. Каталог `/tmp/claude` один внутри и вне песочницы.

**Перед каждым коммитом**

- `node_modules/.bin/prettier --check` на изменённые TS, TSX, JSON, CSS и MD; `git diff --check`.

**pnpm, git и тесты**

- pnpm — только с `--config.verifyDepsBeforeRun=false`; `pnpm install` и `pnpm add` не запускать. Команды — из корня репозитория, без `cd`.
- Не передавать вывод тестов в `tail` или `grep`, когда нужен код возврата. Вывод может сокращать обёртка `rtk`; если он выглядит урезанным — `rtk proxy <команда>`; числа тестов не складывать через `| grep | awk`.
- В свежем worktree сначала собрать зависимости пакета: `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`.
- i18next в тестах бросает исключение на отсутствующий ключ (`test/setup.ts`).
- Растеризатор, проверка шрифта и наблюдение видимости приходят в тесты через `LabelRendering`: `renderOffice(fake, { labels })` или `<LabelRenderingProvider value={…}>`. Без этого офис в тестах рисует «тихо» (`quietLabelRendering`). Записывающий canvas — объект, реализующий `LabelCanvas` (см. тесты задач 2, 3, 5).
- Динамический импорт `label-print.ts` в тестах занимает десятки миллисекунд (Vite трансформирует bwip-js): тесты выгрузок ждут файл через `waitFor`, а не через один `act`.
- Новые и изменённые тестовые файлы один раз запускаются с `--reporter=verbose`: stderr должен быть пуст. Те же файлы один раз запускаются под стендом с задержкой `setImmediate` на 3 мс — два временных файла внутри пакета, запустить и сразу удалить, до `lint`:

  `apps/standalone/test/delayed-immediate.setup.ts`:

  <!-- prettier-ignore -->
  ```ts
  // Temporary stand (never committed): React's scheduler runs passive effects
  // through `setImmediate`; delaying it by 3 ms makes every effect lose the race
  // with Testing Library's `setTimeout(0)`, so an assertion that depends on an
  // effect right after `findBy*` fails every time instead of now and then.
  const realSetTimeout = globalThis.setTimeout;
  Object.defineProperty(globalThis, "setImmediate", {
    configurable: true,
    writable: true,
    value: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      realSetTimeout(callback, 3, ...args),
  });
  ```

  `apps/standalone/vitest.delay.config.ts`:

  <!-- prettier-ignore -->
  ```ts
  import react from "@vitejs/plugin-react";
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    plugins: [react()],
    test: {
      environment: "jsdom",
      globals: true,
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      setupFiles: ["test/delayed-immediate.setup.ts", "test/setup.ts"],
    },
  });
  ```

  Запуск: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --config vitest.delay.config.ts <файлы>`, затем `rm apps/standalone/test/delayed-immediate.setup.ts apps/standalone/vitest.delay.config.ts`.

- Нагрузка. Если тест падает только в полном прогоне под внешней нагрузкой, записать это в отчёт и повторить при обычной загрузке; таймауты не поднимать и утверждения не ослаблять (корневой `AGENTS.md`).

**Счёт тестов**

- До плана: Vitest — 54 файла, 1295 тестов; Cargo — 41 набор, 453 теста. Каждое «Expected» ниже измерено на копии репозитория с тестами самого плана; расхождение значит, что шаг применён не так (тесты сверх плана исполнитель называет в отчёте).

## Файлы

Задачи выполняются по порядку.

<!-- prettier-ignore -->
```text
apps/standalone/src/labels/{opentype.d.ts,rasterizer.ts,font-coverage.ts}                     задача 1
apps/standalone/test/label-raster.test.ts                                                     задача 1
apps/standalone/src/office/templates/{label-renderer,label-print}.ts                          задачи 2, 4
apps/standalone/test/label-renderer.test.ts                                                   задача 2
apps/standalone/src/office/templates/{label-rendering,PreviewPane}.tsx                        задачи 3, 5
apps/standalone/src/office/Office.tsx (свойство labels)                                       задача 3
apps/standalone/src/office/templates/TemplateEditor.tsx                                       задачи 3, 4
apps/standalone/test/{setup.ts,support/office.tsx}                                            задачи 3, 5
apps/standalone/test/template-preview.test.tsx                                                задача 3
apps/standalone/src/office/templates/download.ts                                              задача 4
apps/standalone/test/template-code-downloads.test.tsx                                         задача 4
apps/standalone/src/office/{office-query,catalog-queries}.ts                                  задача 5
apps/standalone/src/office/templates/{TemplateThumb,TemplatesPage}.tsx                        задачи 5, 6
apps/standalone/test/{template-thumbs,templates-page}.test.tsx                                задачи 5, 6
apps/standalone/src/office/templates/template-text.ts (комментарий)                          задача 6
apps/standalone/src/i18n/ru.json                                                              задачи 3, 4, 6
apps/standalone/src/app/shell.css                                                             задачи 3, 5
apps/standalone/AGENTS.md, спецификация §5.5                                                  задача 7
```

Растеризатор и проверка шрифтов (задача 1) и рисование макета (задача 2) не зависят от экранов и идут первыми, каждая со своими тестами. Затем предпросмотр в редакторе (задача 3), выгрузки ZPL и TSPL (задача 4), миниатюры (задача 5), список категорий для скринридера (задача 6) и документы (задача 7).

---

### Task 1: Растеризатор текста и проверка покрытия шрифтов (`src/labels/`)

Генераторы домена (`generateZpl`, `generateTspl`) печатают текст вне печатного ASCII — русский прежде всего — только растром, через внедряемый `RasterizeTextFn`. Задача переносит браузерную реализацию облака и станции (`rasterizeText`: текст рисуется на `<canvas>` вложенным IBM Plex, переносится по `maxWidthPx`/`maxLines`, пиксели пакуют чистые функции домена; без 2D-контекста — `RasterUnavailableError`) и проверку покрытия шрифта (`checkFamilyCoverage`: opentype.js читает подмножества `latin` и `cyrillic` семейства и требует, чтобы хотя бы одно покрывало образец «АЯЁЖЩыёя»). Файлы шрифтов — `.woff` из `@fontsource/ibm-plex-*` через `?url` Vite: те же ассеты, что `@font-face` в `@markiro/ui`, без сети; opentype.js 2.0.0 не читает WOFF2. Типов у пакета нет — `opentype.d.ts` объявляет используемую часть. Экранов в задаче нет.

Сверх облачных тестов задача проверяет настоящие файлы приложения: тест читает с диска те `.woff`, на которые указывают URL модуля, и убеждается, что кириллицу покрывает именно подмножество `cyrillic` (а `latin` — нет).

**Files:**

- Create: `apps/standalone/src/labels/opentype.d.ts`, `apps/standalone/src/labels/font-coverage.ts`, `apps/standalone/src/labels/rasterizer.ts`
- Test: `apps/standalone/test/label-raster.test.ts` (Create)

**Interfaces:**

- Consumes: `bitmapToZplHex`, `convertToMonochrome`, `wrapTextToWidth`, `type RasterizeTextFn`, `type RasterizeTextOptions` — `@markiro/domain`; `parse`, `type Font` — `opentype.js`.
- Produces:
  - `src/labels/rasterizer.ts`: `class RasterUnavailableError extends Error`, `mapFontFamily(family: string): string`, `rasterizeText: RasterizeTextFn`;
  - `src/labels/font-coverage.ts`: `CYRILLIC_SAMPLE = "АЯЁЖЩыёя"`, `type LabelFontFamily = "IBM Plex Sans" | "IBM Plex Mono"`, `FONT_SUBSET_URLS: Record<LabelFontFamily, readonly [latin: string, cyrillic: string]>`, `sampleCoveredByFont(font, sample?): boolean`, `checkCyrillicCoverage(bytes: ArrayBuffer, sample?): boolean`, `checkFamilyCoverage(family: LabelFontFamily): Promise<boolean>`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/label-raster.test.ts`:

<!-- prettier-ignore -->
```ts
import { readFile } from "node:fs/promises";

import { Font, Glyph } from "opentype.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkCyrillicCoverage,
  checkFamilyCoverage,
  CYRILLIC_SAMPLE,
  FONT_SUBSET_URLS,
  sampleCoveredByFont,
} from "../src/labels/font-coverage.js";
import { mapFontFamily, RasterUnavailableError, rasterizeText } from "../src/labels/rasterizer.js";

/** A real, serializable font of `.notdef` and one glyph per character: no outlines, no file. */
function syntheticFont(chars: readonly string[]): Font {
  const glyphs = [new Glyph({ name: ".notdef", advanceWidth: 500 })];
  for (const char of chars) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    glyphs.push(new Glyph({ name: `g${codePoint}`, unicode: codePoint, advanceWidth: 500 }));
  }
  return new Font({
    familyName: "MarkiroSyntheticTestFont",
    styleName: "Regular",
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs,
  });
}

/** Answers each `fetch` with the next buffer, as a successful response. */
function answerFetches(buffers: readonly ArrayBuffer[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const buffer = buffers[call];
    call += 1;
    return { ok: true, status: 200, arrayBuffer: async () => buffer };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The file behind a font's asset URL. Vite serves a file outside the app's
 * root as `/@fs/<absolute path>` in tests; the build gives it `/assets/…`.
 */
async function bundledFile(url: string): Promise<ArrayBuffer> {
  const bytes = await readFile(decodeURIComponent(url.replace(/^\/@fs/, "")));
  return new Uint8Array(bytes).buffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the text rasterizer", () => {
  it("refuses with RasterUnavailableError where the webview gives no 2D canvas", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const outcome = rasterizeText("Партия", {
      fontFamily: "sans-serif",
      fontSizePx: 34,
      bold: false,
    });
    await expect(outcome).rejects.toBeInstanceOf(RasterUnavailableError);
    await expect(outcome).rejects.toHaveProperty("name", "RasterUnavailableError");
  });

  it("loads the bundled face for the text's own script before it draws", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const load = vi.fn(async () => []);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    try {
      await rasterizeText("Партия", { fontFamily: "sans-serif", fontSizePx: 34, bold: true }).catch(
        () => undefined,
      );
      expect(load).toHaveBeenCalledWith("700 34px IBM Plex Sans, sans-serif", "Партия");
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });

  it("maps the generic families the domain asks for to the bundled IBM Plex faces", () => {
    expect(mapFontFamily("sans-serif")).toBe("IBM Plex Sans, sans-serif");
    expect(mapFontFamily("monospace")).toBe("IBM Plex Mono, monospace");
    expect(mapFontFamily("IBM Plex Sans")).toBe("IBM Plex Sans");
  });
});

describe("the font coverage check", () => {
  it("finds a glyph for every character of the Cyrillic sample, or says one is missing", () => {
    expect(sampleCoveredByFont(syntheticFont([...CYRILLIC_SAMPLE]))).toBe(true);
    expect(sampleCoveredByFont(syntheticFont([...CYRILLIC_SAMPLE].filter((c) => c !== "ё")))).toBe(
      false,
    );
    expect(sampleCoveredByFont(syntheticFont([]))).toBe(false);
  });

  it("parses font bytes with opentype.js and checks them", () => {
    expect(checkCyrillicCoverage(syntheticFont([...CYRILLIC_SAMPLE]).toArrayBuffer())).toBe(true);
    expect(checkCyrillicCoverage(syntheticFont(["A", "B", "C"]).toArrayBuffer())).toBe(false);
  });

  it("reads both subsets of a family and passes when either covers the sample", async () => {
    const latin = syntheticFont(["A", "B"]).toArrayBuffer();
    const cyrillic = syntheticFont([...CYRILLIC_SAMPLE]).toArrayBuffer();
    const fetchMock = answerFetches([latin, cyrillic]);
    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(true);
    expect(fetchMock.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      ...FONT_SUBSET_URLS["IBM Plex Sans"],
    ]);
    answerFetches([latin, syntheticFont(["C"]).toArrayBuffer()]);
    await expect(checkFamilyCoverage("IBM Plex Mono")).resolves.toBe(false);
  });

  it("fails on a font file that did not load instead of parsing an error page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => {
          throw new Error("the status is checked first");
        },
      })),
    );
    await expect(checkFamilyCoverage("IBM Plex Sans")).rejects.toThrow(/HTTP 404/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no file");
      }),
    );
    await expect(checkFamilyCoverage("IBM Plex Sans")).rejects.toThrow("no file");
  });

  it("checks the app's own WOFF files, never a network address or WOFF2", () => {
    for (const urls of Object.values(FONT_SUBSET_URLS)) {
      expect(urls).toHaveLength(2);
      for (const url of urls) {
        expect(url.startsWith("/")).toBe(true);
        expect(url).toMatch(/ibm-plex-(sans|mono)-(latin|cyrillic)-400-normal\.woff$/);
      }
    }
  });

  it("finds Cyrillic in the bundled IBM Plex files themselves, in the Cyrillic subset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        arrayBuffer: () => bundledFile(url),
      })),
    );
    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(true);
    await expect(checkFamilyCoverage("IBM Plex Mono")).resolves.toBe(true);
    const [latin, cyrillic] = FONT_SUBSET_URLS["IBM Plex Sans"];
    expect(checkCyrillicCoverage(await bundledFile(latin))).toBe(false);
    expect(checkCyrillicCoverage(await bundledFile(cyrillic))).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-raster.test.ts`
Expected: FAIL — 1 файл, `Tests  no tests`: `Failed to resolve import "../src/labels/font-coverage.js" from "test/label-raster.test.ts"`.

- [ ] **Step 3: Модули `src/labels/`**

1. Создать `apps/standalone/src/labels/opentype.d.ts`:

<!-- prettier-ignore -->
```ts
/**
 * The part of `opentype.js` 2.0.0 this app uses, declared by hand: the
 * package ships no declarations, and `@types/opentype.js` describes the old
 * 1.x API (a port of `apps/admin/src/labels/opentype.d.ts`). `parse` reads
 * TTF, OTF and WOFF bytes; it cannot read WOFF2 (no Brotli decoder in 2.0.0),
 * which is why the coverage check reads the `.woff` files. `Font`, `Glyph`
 * and `toArrayBuffer` let a test build a real font in memory.
 */
declare module "opentype.js" {
  export interface GlyphOptions {
    name?: string | null;
    /** 0 is reserved for `.notdef`; omit it for every other glyph. */
    unicode?: number;
    unicodes?: number[];
    advanceWidth?: number;
    index?: number;
  }

  export class Glyph {
    constructor(options: GlyphOptions);
    readonly unicode: number | undefined;
    readonly unicodes: number[];
  }

  export interface FontOptions {
    familyName: string;
    styleName: string;
    unitsPerEm: number;
    ascender: number;
    descender: number;
    glyphs: Glyph[];
  }

  export class Font {
    constructor(options: FontOptions);
    /**
     * The glyph of the character's first code point: `0` (a parsed font's
     * `.notdef`) or `null` (an in-memory font without a cmap) when there is
     * none, so anything `<= 0` means «not covered».
     */
    charToGlyphIndex(char: string): number | null;
    /** An in-memory font as real sfnt bytes. */
    toArrayBuffer(): ArrayBuffer;
  }

  /** Parses TTF, OTF or WOFF bytes; WOFF2 throws. */
  export function parse(buffer: ArrayBuffer): Font;
}
```

2. Создать `apps/standalone/src/labels/font-coverage.ts`:

<!-- prettier-ignore -->
```ts
import { parse, type Font } from "opentype.js";

import plexMonoCyrillic from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-cyrillic-400-normal.woff?url";
import plexMonoLatin from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff?url";
import plexSansCyrillic from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff?url";
import plexSansLatin from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff?url";

/** Eight letters across the alphabet, Ё and lowercase forms included (as the cloud checks). */
export const CYRILLIC_SAMPLE = "АЯЁЖЩыёя";

/** The faces a label's text is drawn in: the app's own IBM Plex. */
export type LabelFontFamily = "IBM Plex Sans" | "IBM Plex Mono";

/**
 * The files the check reads, per family: the Latin and the Cyrillic subset,
 * weight 400 (coverage does not change with the weight). They are the app's
 * own assets, the same files `@markiro/ui`'s `@font-face` rules load, so the
 * check needs no network; the `.woff` variant, since opentype.js 2.0.0 cannot
 * read WOFF2.
 */
export const FONT_SUBSET_URLS: Record<LabelFontFamily, readonly [latin: string, cyrillic: string]> =
  {
    "IBM Plex Sans": [plexSansLatin, plexSansCyrillic],
    "IBM Plex Mono": [plexMonoLatin, plexMonoCyrillic],
  };

/** Whether the font has a glyph for every character of `sample`. */
export function sampleCoveredByFont(font: Font, sample: string = CYRILLIC_SAMPLE): boolean {
  for (const char of sample) {
    const glyph = font.charToGlyphIndex(char);
    if (glyph === null || glyph <= 0) return false;
  }
  return true;
}

/** Parses font bytes (TTF, OTF, WOFF; not WOFF2) and checks them against `sample`. */
export function checkCyrillicCoverage(
  bytes: ArrayBuffer,
  sample: string = CYRILLIC_SAMPLE,
): boolean {
  return sampleCoveredByFont(parse(bytes), sample);
}

/**
 * Whether a family draws Cyrillic, after the cloud's `checkFamilyCoverage`:
 * both subset files are read, and either one alone must cover the sample (in
 * practice the Cyrillic one). A file that does not load rejects, and the
 * caller says the check failed, rather than parsing an error page.
 */
export async function checkFamilyCoverage(family: LabelFontFamily): Promise<boolean> {
  const buffers = await Promise.all(
    FONT_SUBSET_URLS[family].map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`failed to fetch font subset ${url}: HTTP ${response.status}`);
      }
      return response.arrayBuffer();
    }),
  );
  return buffers.some((buffer) => checkCyrillicCoverage(buffer));
}
```

3. Создать `apps/standalone/src/labels/rasterizer.ts`:

<!-- prettier-ignore -->
```ts
/**
 * The webview's `RasterizeTextFn` (`@markiro/domain`), a port of
 * `apps/admin/src/labels/rasterizer.ts` and `apps/station/src/lib/rasterizer.ts`
 * that must behave as they do: a template previewed in an office and printed
 * by a station has to give the same bitmap («предпросмотр = печать»), so the
 * font mapping, the wrapping and the line height do not drift. It only draws
 * the text on a `<canvas>` and reads the pixels back; the domain's DOM-free
 * `convertToMonochrome` and `bitmapToZplHex` pack them. It lives outside the
 * office because the station of this app (plan 2a) prints through it too.
 */
import {
  bitmapToZplHex,
  convertToMonochrome,
  wrapTextToWidth,
  type RasterizeTextFn,
  type RasterizeTextOptions,
} from "@markiro/domain";

/**
 * The webview gave no 2D canvas context (jsdom has none; a real webview could
 * refuse one when out of canvas memory). Typed, so a caller tells «cannot
 * rasterize here» from any other failure.
 */
export class RasterUnavailableError extends Error {
  constructor(message = "2D canvas rendering context is unavailable in this environment") {
    super(message);
    this.name = "RasterUnavailableError";
  }
}

function canvas2d(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new RasterUnavailableError();
  return context;
}

/**
 * The generic families the domain's generators ask for, mapped to the app's
 * bundled IBM Plex faces with the generic one kept as the fallback; a family
 * already named (the preview asks for «IBM Plex Sans») stays as it is.
 */
export function mapFontFamily(family: string): string {
  if (family === "sans-serif") return "IBM Plex Sans, sans-serif";
  if (family === "monospace") return "IBM Plex Mono, monospace";
  return family;
}

function fontShorthand(family: string, sizePx: number, bold: boolean): string {
  return `${bold ? 700 : 400} ${sizePx}px ${mapFontFamily(family)}`;
}

/**
 * Measures the text on a throwaway context, wraps it to `maxWidthPx` and
 * `maxLines` with the same measure (the emitters never clip a bitmap, so this
 * keeps a long name on the label; what still does not fit ends in «…»),
 * draws each line black on white in a box of `ceil(sizePx × 1.5)` and packs
 * the pixels. The width is clamped too: a line that fills the box exactly
 * could round one dot past it.
 */
function rasterizeTextSync(
  text: string,
  { fontFamily, fontSizePx, bold, maxWidthPx, maxLines }: RasterizeTextOptions,
) {
  const font = fontShorthand(fontFamily, fontSizePx, bold);
  const measureContext = canvas2d(1, 1);
  measureContext.font = font;
  const measure = (line: string) => measureContext.measureText(line).width;

  const bounded = maxWidthPx !== undefined && maxWidthPx > 0;
  const lines = bounded ? wrapTextToWidth(text, measure, maxWidthPx, maxLines ?? 1) : [text];
  const lineHeight = Math.ceil(fontSizePx * 1.5);
  const naturalWidth = Math.ceil(Math.max(...lines.map(measure)));
  const width = Math.max(1, bounded ? Math.min(maxWidthPx, naturalWidth) : naturalWidth);
  const height = lineHeight * lines.length;

  const context = canvas2d(width, height);
  context.font = font;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#000000";
  context.textBaseline = "middle";
  lines.forEach((line, index) => {
    context.fillText(line, 0, index * lineHeight + lineHeight / 2);
  });

  const { data } = context.getImageData(0, 0, width, height);
  const packed = bitmapToZplHex(convertToMonochrome(data, width, height), width, height);
  return { ...packed, width, height };
}

/**
 * Loads the face for the text's own script first (`document.fonts.load` with
 * the text: by default only the Latin subset loads), so the measure and the
 * drawing use IBM Plex rather than a fallback; a load that fails or a webview
 * without `document.fonts` is not fatal.
 */
export const rasterizeText: RasterizeTextFn = async (text, options) => {
  const font = fontShorthand(options.fontFamily, options.fontSizePx, options.bold);
  try {
    await document.fonts?.load(font, text);
  } catch {
    // Best effort: the canvas draws with whatever face it has.
  }
  try {
    return rasterizeTextSync(text, options);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/label-raster.test.ts`
Expected: PASS — 1 файл, 9 тестов; stderr пуст. Затем тот же файл под стендом с задержкой `setImmediate` — PASS, 9; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/labels/font-coverage.ts` не проверять ответ на запрос файла шрифта: удалить фрагмент

<!-- prettier-ignore -->
```ts
      if (!response.ok) {
        throw new Error(`failed to fetch font subset ${url}: HTTP ${response.status}`);
      }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-raster.test.ts -t "fails on a font file that did not load"`
Expected: FAIL — `× fails on a font file that did not load instead of parsing an error page`, `AssertionError: expected [Function] to throw error matching /HTTP 404/ but got 'the status is checked first'`.

Мутация 2. В `apps/standalone/src/labels/font-coverage.ts` требовать кириллицу от каждого подмножества: фрагмент

<!-- prettier-ignore -->
```ts
  return buffers.some((buffer) => checkCyrillicCoverage(buffer));
```

заменить на

<!-- prettier-ignore -->
```ts
  return buffers.every((buffer) => checkCyrillicCoverage(buffer));
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-raster.test.ts -t "reads both subsets"`
Expected: FAIL — `× reads both subsets of a family and passes when either covers the sample`, `AssertionError: expected false to be true // Object.is equality`.

Мутация 3. В `apps/standalone/src/labels/font-coverage.ts` считать глиф `.notdef` (0) покрытием: фрагмент

<!-- prettier-ignore -->
```ts
    if (glyph === null || glyph <= 0) return false;
```

заменить на

<!-- prettier-ignore -->
```ts
    if (glyph === null || glyph < 0) return false;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-raster.test.ts -t "parses font bytes"`
Expected: FAIL — `× parses font bytes with opentype.js and checks them`, `AssertionError: expected true to be false // Object.is equality`.

Мутация 4. В `apps/standalone/src/labels/font-coverage.ts` читать кириллицу IBM Plex Sans из WOFF2: фрагмент

<!-- prettier-ignore -->
```ts
import plexSansCyrillic from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff?url";
```

заменить на

<!-- prettier-ignore -->
```ts
import plexSansCyrillic from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff2?url";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-raster.test.ts -t "bundled IBM Plex files"`
Expected: FAIL — `× finds Cyrillic in the bundled IBM Plex files themselves, in the Cyrillic subset`, `AssertionError: promise rejected "Error: WOFF2 require an external decompre…" instead of resolving`.

Мутация 5. В `apps/standalone/src/labels/rasterizer.ts` загружать шрифт без текста (только латиница): фрагмент

<!-- prettier-ignore -->
```ts
    await document.fonts?.load(font, text);
```

заменить на

<!-- prettier-ignore -->
```ts
    await document.fonts?.load(font);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-raster.test.ts -t "loads the bundled face"`
Expected: FAIL — `× loads the bundled face for the text's own script before it draws`, `AssertionError: expected "vi.fn()" to be called with arguments: [ …(2) ]`.

Мутация 6. В `apps/standalone/src/labels/rasterizer.ts` не переводить «sans-serif» во вложенный IBM Plex Sans: удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (family === "sans-serif") return "IBM Plex Sans, sans-serif";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-raster.test.ts -t "maps the generic families"`
Expected: FAIL — `× maps the generic families the domain asks for to the bundled IBM Plex faces`, `AssertionError: expected 'sans-serif' to be 'IBM Plex Sans, sans-serif' // Object.is equality`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/labels apps/standalone/test/label-raster.test.ts`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 55 файлов, 1304 теста.

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/labels/opentype.d.ts apps/standalone/src/labels/font-coverage.ts apps/standalone/src/labels/rasterizer.ts apps/standalone/test/label-raster.test.ts
git commit -m "feat(standalone): растеризатор текста и проверка покрытия шрифтов" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Рисование макета и растры печати поверх него (`label-renderer.ts`)

Перенос облачного `renderer.ts` (`apps/admin/src/pages/labels/renderer.ts`) и `raster-preview.ts` одним модулем. `drawLabel` рисует макет на canvas в масштабе (пикселей на миллиметр) с данными образца: вся этикетка белая, элементы чёрные; текст — нативно, с переносом и выравниванием как у принтера; коды — схемой (у матричного — узор, засеянный текстом; у линейного — штрихи по настоящей ширине `elementBoundsMm`); рамка — с отступом в полтолщины. Код дубликата (`kmDataMatrix: "raster"`) `drawLabel` оставляет белым: `paintCodeRasters` рисует растр станции, когда загрузится кодировщик (`label-print.ts` — отдельный чанк, bwip-js велик). `compositeTextRasters` кладёт поверх текста, который печать растрирует (`rasterTextElements`: всё, что не печатный ASCII), растр печати: просит `rasterizeText` с теми же параметрами, что генераторы домена, закрывает нативный текст белым и рисует растр там, где его поставит принтер (целые точки плюс смещение `rasterAlignOffsetDots`); отказ растеризатора оставляет нативный текст, отмена (`cancelled()`) прекращает рисование. `paintRaster` рисует чёрные точки растра прямоугольником на серию.

Рисование идёт через `LabelCanvas` — узкую часть 2D-контекста; настоящий `CanvasRenderingContext2D` ей отвечает, а тест записывает вызовы своим объектом. Экранов в задаче нет.

**Files:**

- Create: `apps/standalone/src/office/templates/label-renderer.ts`, `apps/standalone/src/office/templates/label-print.ts`
- Test: `apps/standalone/test/label-renderer.test.ts` (Create)

**Interfaces:**

- Consumes: `elementBoundsMm`, `INTERIOR_MODULES`, `labelFieldDisplayValue`, `LINE_HEIGHT_EM`, `mmToDots`, `needsImageRendering`, `ptToDots`, `ptToMm`, `QUIET_ZONE_MODULES`, `rasterAlignOffsetDots`, `TOTAL_MODULES`, `wrapTextToWidth`, `rasterizeGs1DataMatrix` (только в `label-print.ts`) и типы элементов, `RasterizeTextFn`, `RasterResult` — `@markiro/domain`; `type LabelRenderOptions` — `label-samples.ts` (план 1e4).
- Produces:
  - `label-renderer.ts`: `interface LabelCanvas`, `LABEL_BACKGROUND = "#ffffff"`, `rasterTextElements(spec, data): (LabelTextElement | LabelFieldElement)[]`, `paintRaster(canvas, raster, xPx, yPx, dotPx): void`, `drawLabel(spec, canvas, scale, data, options): void`, `paintCodeRasters(spec, canvas, scale, data, options, cancelled: () => boolean): Promise<void>`, `compositeTextRasters(spec, canvas, scale, data, options, rasterizeText, cancelled): Promise<void>`;
  - `label-print.ts`: реэкспорт `rasterizeGs1DataMatrix` (задача 4 прибавит генераторы), загружается только через `import("./label-print.js")`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/label-renderer.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from "vitest";

import {
  buildDuplicateLabelTemplate,
  elementBoundsMm,
  generateZpl,
  mmToDots,
  ptToMm,
  rasterizeGs1DataMatrix,
  type LabelTemplateSpec,
  type RasterizeTextOptions,
  type RasterResult,
} from "@markiro/domain";

import {
  compositeTextRasters,
  drawLabel,
  paintCodeRasters,
  paintRaster,
  type LabelCanvas,
} from "../src/office/templates/label-renderer.js";
import { labelRenderOptions, labelSampleData } from "../src/office/templates/label-samples.js";

type Op = (string | number)[];

/** A 2D context that records what is drawn; a character measures 10 px. */
function recordingCanvas(): LabelCanvas & { ops: Op[] } {
  const ops: Op[] = [];
  return {
    ops,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textBaseline: "alphabetic",
    textAlign: "start",
    clearRect(x, y, w, h) {
      ops.push(["clearRect", x, y, w, h]);
    },
    fillRect(x, y, w, h) {
      ops.push(["fillRect", String(this.fillStyle), x, y, w, h]);
    },
    strokeRect(x, y, w, h) {
      ops.push(["strokeRect", String(this.strokeStyle), this.lineWidth, x, y, w, h]);
    },
    fillText(text, x, y, maxWidth) {
      ops.push([
        "fillText",
        text,
        x,
        y,
        maxWidth ?? -1,
        this.font,
        this.textAlign,
        this.textBaseline,
      ]);
    },
    measureText: (text) => ({ width: text.length * 10 }),
    beginPath() {
      ops.push(["beginPath"]);
    },
    moveTo(x, y) {
      ops.push(["moveTo", x, y]);
    },
    lineTo(x, y) {
      ops.push(["lineTo", x, y]);
    },
    stroke() {
      ops.push(["stroke", String(this.strokeStyle), this.lineWidth]);
    },
  };
}

const BOX_DATA = labelSampleData("box");

const LAYOUT: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { kind: "box", id: "frame", xMm: 1, yMm: 1, widthMm: 56, heightMm: 38, thicknessMm: 0.5 },
    { kind: "text", id: "lot", xMm: 4, yMm: 4, text: "LOT", fontSizePt: 10 },
    {
      kind: "field",
      id: "name",
      xMm: 4,
      yMm: 10,
      field: "product.printName",
      fontSizePt: 12,
      bold: true,
      align: "center",
      maxWidthMm: 70,
    },
    { kind: "line", id: "rule", xMm: 4, yMm: 30, x2Mm: 54, y2Mm: 30, thicknessMm: 0.3 },
  ],
};

/** A one-dot bitmap that answers every rasterize call, and the calls it got. */
function recordingRasterizer() {
  const calls: [string, RasterizeTextOptions][] = [];
  const raster: RasterResult = { hex: "80", bytesPerRow: 1, totalBytes: 1, width: 1, height: 1 };
  const rasterize = vi.fn(async (text: string, options: RasterizeTextOptions) => {
    calls.push([text, options]);
    return raster;
  });
  return { calls, rasterize };
}

describe("drawing a label layout", () => {
  it("paints the label white, then each element in black at the scale, with the sample's text", () => {
    const canvas = recordingCanvas();
    drawLabel(LAYOUT, canvas, 2, BOX_DATA, {});
    expect(canvas.ops).toEqual([
      ["clearRect", 0, 0, 116, 80],
      ["fillRect", "#ffffff", 0, 0, 116, 80],
      // A box's stroke is inset by half its width, so its outer edge is the element's box.
      ["strokeRect", "#000000", 1, 2.5, 2.5, 111, 75],
      ["fillText", "LOT", 8, 8, -1, `400 ${ptToMm(10) * 2}px sans-serif`, "left", "top"],
      // Within its width, centred: the middle of the box, as the printer aligns it.
      [
        "fillText",
        "Пиво светлое",
        78,
        20,
        140,
        `700 ${ptToMm(12) * 2}px sans-serif`,
        "center",
        "top",
      ],
      ["beginPath"],
      ["moveTo", 8, 60],
      ["lineTo", 108, 60],
      ["stroke", "#000000", 0.6],
    ]);
  });

  it("draws the same schematic code for the same layout every time", () => {
    const qr: LabelTemplateSpec = {
      ...LAYOUT,
      elements: [
        { kind: "barcode", id: "q", xMm: 2, yMm: 2, format: "qr", data: "sscc", sizeMm: 1 },
      ],
    };
    const first = recordingCanvas();
    const second = recordingCanvas();
    drawLabel(qr, first, 3, BOX_DATA, {});
    drawLabel(qr, second, 3, BOX_DATA, {});
    expect(first.ops.length).toBeGreaterThan(10);
    expect(second.ops).toEqual(first.ops);
  });

  it("paints a bitmap's black dots as one rectangle per run, within its width", () => {
    const canvas = recordingCanvas();
    paintRaster(
      canvas,
      { hex: "E0A0", bytesPerRow: 1, totalBytes: 2, width: 3, height: 2 },
      10,
      20,
      2,
    );
    paintRaster(canvas, { hex: "FF", bytesPerRow: 1, totalBytes: 1, width: 3, height: 1 }, 0, 0, 1);
    expect(canvas.ops).toEqual([
      ["fillRect", "#000000", 10, 20, 6, 2],
      ["fillRect", "#000000", 10, 22, 2, 2],
      ["fillRect", "#000000", 14, 22, 2, 2],
      ["fillRect", "#000000", 0, 0, 3, 1],
    ]);
  });

  it("leaves a product duplicate's code white, then paints it as the raster the station prints", async () => {
    const spec = buildDuplicateLabelTemplate();
    const data = labelSampleData("product_duplicate");
    const options = labelRenderOptions("product_duplicate");
    const code = spec.elements.find(
      (element) => element.kind === "barcode" && element.data === "km.code",
    );
    if (code?.kind !== "barcode") throw new Error("the duplicate has no code");
    const drawn = recordingCanvas();
    drawLabel(spec, drawn, 3, data, options);
    const withoutCode = recordingCanvas();
    drawLabel(
      { ...spec, elements: spec.elements.filter((element) => element !== code) },
      withoutCode,
      3,
      data,
      options,
    );
    expect(drawn.ops).toEqual(withoutCode.ops);
    await paintCodeRasters(spec, drawn, 3, data, options, () => false);
    const expected = recordingCanvas();
    const dotPx = (25.4 / spec.dpi) * 3;
    const bounds = elementBoundsMm(code, data, options);
    paintRaster(
      expected,
      rasterizeGs1DataMatrix(data["km.code"], mmToDots(code.sizeMm, spec.dpi)),
      mmToDots(bounds.x, spec.dpi) * dotPx,
      mmToDots(bounds.y, spec.dpi) * dotPx,
      dotPx,
    );
    expect(expected.ops.length).toBeGreaterThan(10);
    expect(drawn.ops.slice(withoutCode.ops.length)).toEqual(expected.ops);
    const cancelled = recordingCanvas();
    await paintCodeRasters(spec, cancelled, 3, data, options, () => true);
    expect(cancelled.ops).toEqual([]);
  });
});

describe("the print bitmaps over the drawing", () => {
  const CYRILLIC: LabelTemplateSpec = {
    ...LAYOUT,
    elements: [
      { kind: "text", id: "lot", xMm: 4, yMm: 4, text: "LOT", fontSizePt: 10 },
      { kind: "text", id: "batch", xMm: 4, yMm: 20, text: "Партия", fontSizePt: 9 },
      ...LAYOUT.elements.slice(2, 3),
    ],
  };

  it("asks the rasterizer what the print asks it, for the text that is not printable ASCII only", async () => {
    const preview = recordingRasterizer();
    await compositeTextRasters(
      CYRILLIC,
      recordingCanvas(),
      3,
      BOX_DATA,
      {},
      preview.rasterize,
      () => false,
    );
    const print = recordingRasterizer();
    await generateZpl(CYRILLIC, BOX_DATA, { rasterizeText: print.rasterize });
    expect(preview.calls.map(([text]) => text)).toEqual(["Партия", "Пиво светлое"]);
    expect(preview.calls).toEqual(print.calls);
  });

  it("covers each element's drawing and paints its bitmap where the printer puts it", async () => {
    const canvas = recordingCanvas();
    const { rasterize } = recordingRasterizer();
    await compositeTextRasters(CYRILLIC, canvas, 2, BOX_DATA, {}, rasterize, () => false);
    const dotPx = (25.4 / 203) * 2;
    const field = CYRILLIC.elements[2];
    if (field === undefined) throw new Error("no field");
    const bounds = elementBoundsMm(field, BOX_DATA);
    // At 203 dpi «Партия» starts at (32, 160) dots; the field at (32, 80), centred in
    // 70 mm (559 dots) as the printer centres a 1-dot bitmap: 279 dots further in.
    expect(canvas.ops[1]).toEqual(["fillRect", "#000000", 32 * dotPx, 160 * dotPx, dotPx, dotPx]);
    expect(canvas.ops.slice(2)).toEqual([
      ["fillRect", "#ffffff", bounds.x * 2, bounds.y * 2, bounds.w * 2, bounds.h * 2],
      ["fillRect", "#000000", (32 + 279) * dotPx, 80 * dotPx, dotPx, dotPx],
    ]);
  });

  it("keeps the drawing of an element its bitmap failed for, and stops once cancelled", async () => {
    const canvas = recordingCanvas();
    const rasterize = vi
      .fn<(text: string, options: RasterizeTextOptions) => Promise<RasterResult>>()
      .mockRejectedValueOnce(new Error("no canvas"))
      .mockResolvedValue({ hex: "80", bytesPerRow: 1, totalBytes: 1, width: 1, height: 1 });
    await compositeTextRasters(CYRILLIC, canvas, 2, BOX_DATA, {}, rasterize, () => false);
    expect(rasterize).toHaveBeenCalledTimes(2);
    expect(canvas.ops).toHaveLength(2);
    const cancelled = recordingCanvas();
    await compositeTextRasters(CYRILLIC, cancelled, 2, BOX_DATA, {}, rasterize, () => true);
    expect(cancelled.ops).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts`
Expected: FAIL — 1 файл, `Tests  no tests`: `Failed to resolve import "../src/office/templates/label-renderer.js" from "test/label-renderer.test.ts"`.

- [ ] **Step 3: Рисование макета**

1. Создать `apps/standalone/src/office/templates/label-print.ts`:

<!-- prettier-ignore -->
```ts
/**
 * The domain's printing code, loaded on its own (`import("./label-print.js")`):
 * the GS1 DataMatrix raster brings the barcode encoder (bwip-js, about
 * 0.9 MB) with it, which the webview needs only once a duplicate's code is
 * drawn, not when it starts.
 */
export { rasterizeGs1DataMatrix } from "@markiro/domain";
```

2. Создать `apps/standalone/src/office/templates/label-renderer.ts`:

<!-- prettier-ignore -->
```ts
import {
  elementBoundsMm,
  INTERIOR_MODULES,
  labelFieldDisplayValue,
  LINE_HEIGHT_EM,
  mmToDots,
  needsImageRendering,
  ptToDots,
  ptToMm,
  QUIET_ZONE_MODULES,
  rasterAlignOffsetDots,
  TOTAL_MODULES,
  wrapTextToWidth,
  type LabelBarcodeElement,
  type LabelBoxElement,
  type LabelField,
  type LabelFieldElement,
  type LabelLineElement,
  type LabelTemplateSpec,
  type LabelTextElement,
  type RasterizeTextFn,
  type RasterResult,
} from "@markiro/domain";

import type { LabelRenderOptions } from "./label-samples.js";

/**
 * The part of a 2D context a label is drawn with: a real
 * `CanvasRenderingContext2D` is one, and a test records the calls of its own.
 */
export interface LabelCanvas {
  font: string;
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/** A label is black ink on white stock whatever the office's theme. */
export const LABEL_BACKGROUND = "#ffffff";
const INK = "#000000";

/** The family the domain's generators ask the rasterizer for (`zpl.ts`, `tspl.ts`). */
const PRINT_FONT_FAMILY = "sans-serif";

type TextLikeElement = LabelTextElement | LabelFieldElement;

function textOf(element: TextLikeElement, data: Record<LabelField, string>): string {
  return element.kind === "text"
    ? element.text
    : labelFieldDisplayValue(element.field, data, element.textFormat);
}

/**
 * The text elements the print rasterizes with `data`: those whose text is not
 * printable ASCII only (`needsImageRendering`, Cyrillic above all).
 */
export function rasterTextElements(
  spec: LabelTemplateSpec,
  data: Record<LabelField, string>,
): TextLikeElement[] {
  return spec.elements.filter(
    (element): element is TextLikeElement =>
      (element.kind === "text" || element.kind === "field") &&
      needsImageRendering(textOf(element, data)),
  );
}

/**
 * Paints a bitmap's black dots (`RasterResult`: hex, rows padded to bytes,
 * the most significant bit first, 1 for ink) as one rectangle per run of a
 * row, from `(xPx, yPx)`, each dot `dotPx` wide. Dots past the bitmap's width
 * (the padding) are never painted.
 */
export function paintRaster(
  canvas: LabelCanvas,
  raster: RasterResult,
  xPx: number,
  yPx: number,
  dotPx: number,
): void {
  canvas.fillStyle = INK;
  for (let row = 0; row < raster.height; row++) {
    let runStart = -1;
    for (let column = 0; column <= raster.width; column++) {
      let ink = false;
      if (column < raster.width) {
        const offset = (row * raster.bytesPerRow + (column >> 3)) * 2;
        const byte = Number.parseInt(raster.hex.slice(offset, offset + 2), 16);
        ink = ((byte >> (7 - (column % 8))) & 1) === 1;
      }
      if (ink && runStart < 0) runStart = column;
      if (!ink && runStart >= 0) {
        canvas.fillRect(
          xPx + runStart * dotPx,
          yPx + row * dotPx,
          (column - runStart) * dotPx,
          dotPx,
        );
        runStart = -1;
      }
    }
  }
}

function drawText(
  canvas: LabelCanvas,
  element: TextLikeElement,
  text: string,
  scale: number,
): void {
  const fontPx = ptToMm(element.fontSizePt) * scale;
  canvas.font = `${element.bold ? 700 : 400} ${fontPx}px sans-serif`;
  canvas.fillStyle = INK;
  canvas.textBaseline = "top";
  const xPx = element.xMm * scale;
  const yPx = element.yMm * scale;
  // As the printer: alignment works only inside a `maxWidthMm` box.
  if (element.maxWidthMm === undefined) {
    canvas.textAlign = "left";
    canvas.fillText(text, xPx, yPx);
    return;
  }
  const boxPx = element.maxWidthMm * scale;
  const align = element.align ?? "left";
  canvas.textAlign = align;
  const drawX = align === "center" ? xPx + boxPx / 2 : align === "right" ? xPx + boxPx : xPx;
  // Wrapped and cut as print wraps and cuts it (`wrapTextToWidth`).
  const lines = wrapTextToWidth(
    text,
    (line) => canvas.measureText(line).width,
    boxPx,
    element.maxLines ?? 1,
  );
  const lineHeightPx = ptToMm(element.fontSizePt) * LINE_HEIGHT_EM * scale;
  lines.forEach((line, index) => {
    canvas.fillText(line, drawX, yPx + index * lineHeightPx, boxPx);
  });
}

/** A deterministic 32-bit hash of a string: the seed of a schematic code. */
function simpleHash(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

/** A seeded generator (mulberry32): the same seed, the same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A matrix code's schematic: a pattern seeded by its text, not a real encoding. */
function drawMatrixCode(
  canvas: LabelCanvas,
  text: string,
  xPx: number,
  yPx: number,
  modulePx: number,
): void {
  canvas.fillStyle = LABEL_BACKGROUND;
  canvas.fillRect(xPx, yPx, TOTAL_MODULES * modulePx, TOTAL_MODULES * modulePx);
  const random = mulberry32(simpleHash(text));
  canvas.fillStyle = INK;
  for (let row = 0; row < INTERIOR_MODULES; row++) {
    for (let column = 0; column < INTERIOR_MODULES; column++) {
      if (random() < 0.5) {
        canvas.fillRect(
          xPx + (QUIET_ZONE_MODULES + column) * modulePx,
          yPx + (QUIET_ZONE_MODULES + row) * modulePx,
          modulePx,
          modulePx,
        );
      }
    }
  }
}

/**
 * A linear code's schematic over the element's whole height and its real
 * printed width (`elementBoundsMm`); no digits under it, since neither
 * emitter asks the printer for them.
 */
function drawLinearCode(
  canvas: LabelCanvas,
  text: string,
  xPx: number,
  yPx: number,
  heightPx: number,
  widthPx: number,
): void {
  const value = text.length > 0 ? text : " ";
  const segmentPx = widthPx / (value.length * 2);
  canvas.fillStyle = LABEL_BACKGROUND;
  canvas.fillRect(xPx, yPx, widthPx, heightPx);
  canvas.fillStyle = INK;
  let cursor = xPx;
  for (let index = 0; index < value.length; index++) {
    const jitter = 0.6 + ((value.charCodeAt(index) % 9) / 8) * 0.8;
    canvas.fillRect(cursor, yPx, segmentPx * jitter, heightPx);
    cursor += segmentPx * 2;
  }
}

/** A product duplicate's code: the station prints it as its own GS1 raster. */
function isStationRaster(element: LabelBarcodeElement, options: LabelRenderOptions): boolean {
  return (
    options.kmDataMatrix === "raster" &&
    element.format === "datamatrix" &&
    element.data === "km.code"
  );
}

function drawBarcode(
  canvas: LabelCanvas,
  element: LabelBarcodeElement,
  scale: number,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
): void {
  // Left white here: `paintCodeRasters` paints the station's raster once its encoder loads.
  if (isStationRaster(element, options)) return;
  const text = typeof element.data === "string" ? (data[element.data] ?? "") : element.data.literal;
  const xPx = element.xMm * scale;
  const yPx = element.yMm * scale;
  if (element.format === "datamatrix" || element.format === "qr") {
    drawMatrixCode(canvas, text, xPx, yPx, element.sizeMm * scale);
    return;
  }
  const { w } = elementBoundsMm(element, data);
  drawLinearCode(canvas, text, xPx, yPx, element.sizeMm * scale, w * scale);
}

function drawLine(canvas: LabelCanvas, element: LabelLineElement, scale: number): void {
  canvas.strokeStyle = INK;
  canvas.lineWidth = element.thicknessMm * scale;
  canvas.beginPath();
  canvas.moveTo(element.xMm * scale, element.yMm * scale);
  canvas.lineTo(element.x2Mm * scale, element.y2Mm * scale);
  canvas.stroke();
}

function drawBox(canvas: LabelCanvas, element: LabelBoxElement, scale: number): void {
  const thicknessPx = element.thicknessMm * scale;
  canvas.strokeStyle = INK;
  canvas.lineWidth = thicknessPx;
  // Inset by half the stroke, so the outer edge is the element's own box.
  canvas.strokeRect(
    element.xMm * scale + thicknessPx / 2,
    element.yMm * scale + thicknessPx / 2,
    element.widthMm * scale - thicknessPx,
    element.heightMm * scale - thicknessPx,
  );
}

/**
 * Draws a layout at `scale` pixels per millimetre with `data` for its fields,
 * after the cloud's `renderer.ts`: the whole label white, then each element in
 * black. Text is drawn natively here; `compositeTextRasters` puts the print's
 * bitmaps over the text that needs them. Codes are schematic, except a product
 * duplicate's code (`kmDataMatrix: "raster"`), which stays white until
 * `paintCodeRasters` paints the station's raster.
 */
export function drawLabel(
  spec: LabelTemplateSpec,
  canvas: LabelCanvas,
  scale: number,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
): void {
  const widthPx = spec.widthMm * scale;
  const heightPx = spec.heightMm * scale;
  canvas.clearRect(0, 0, widthPx, heightPx);
  canvas.fillStyle = LABEL_BACKGROUND;
  canvas.fillRect(0, 0, widthPx, heightPx);
  for (const element of spec.elements) {
    switch (element.kind) {
      case "text":
        drawText(canvas, element, element.text, scale);
        break;
      case "field":
        drawText(canvas, element, textOf(element, data), scale);
        break;
      case "barcode":
        drawBarcode(canvas, element, scale, data, options);
        break;
      case "line":
        drawLine(canvas, element, scale);
        break;
      case "box":
        drawBox(canvas, element, scale);
        break;
    }
  }
}

/**
 * Paints a product duplicate's code as the station's GS1 raster, dot for dot
 * where the printer puts it. The encoder comes with the domain's printing code
 * (`label-print.ts`, a chunk of its own: bwip-js is large), so this waits for
 * it; a code it cannot encode, or an encoder that did not load, stays white,
 * and nothing is painted once `cancelled()` says the layout has changed.
 */
export async function paintCodeRasters(
  spec: LabelTemplateSpec,
  canvas: LabelCanvas,
  scale: number,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
  cancelled: () => boolean,
): Promise<void> {
  const codes = spec.elements.filter(
    (element): element is LabelBarcodeElement =>
      element.kind === "barcode" && isStationRaster(element, options),
  );
  if (codes.length === 0) return;
  const print = await import("./label-print.js").catch(() => null);
  if (print === null || cancelled()) return;
  const dotPx = (25.4 / spec.dpi) * scale;
  for (const code of codes) {
    let raster: RasterResult;
    try {
      raster = print.rasterizeGs1DataMatrix(data["km.code"], mmToDots(code.sizeMm, spec.dpi));
    } catch {
      continue;
    }
    const bounds = elementBoundsMm(code, data, options);
    paintRaster(
      canvas,
      raster,
      mmToDots(bounds.x, spec.dpi) * dotPx,
      mmToDots(bounds.y, spec.dpi) * dotPx,
      dotPx,
    );
  }
}

/**
 * Puts over a drawn layout the bitmaps the print carries
 * («предпросмотр = печать»): every text the print rasterizes
 * (`rasterTextElements`) goes to `rasterizeText` with the options the
 * domain's generators give it, its native drawing is covered with the label's
 * white, and the bitmap is painted where the printer puts it: at the
 * element's origin in whole dots plus the same alignment offset
 * (`rasterAlignOffsetDots`). An element whose bitmap fails
 * keeps its native drawing; nothing is painted once `cancelled()` says the
 * layout has changed.
 */
export async function compositeTextRasters(
  spec: LabelTemplateSpec,
  canvas: LabelCanvas,
  scale: number,
  data: Record<LabelField, string>,
  options: LabelRenderOptions,
  rasterizeText: RasterizeTextFn,
  cancelled: () => boolean,
): Promise<void> {
  const dotPx = (25.4 / spec.dpi) * scale;
  for (const element of rasterTextElements(spec, data)) {
    const text = textOf(element, data);
    const maxWidthDots =
      element.maxWidthMm === undefined ? undefined : mmToDots(element.maxWidthMm, spec.dpi);
    let raster: RasterResult | null;
    try {
      raster = await rasterizeText(text, {
        fontFamily: PRINT_FONT_FAMILY,
        fontSizePx: ptToDots(element.fontSizePt, spec.dpi),
        bold: element.bold ?? false,
        maxWidthPx: maxWidthDots,
        maxLines: element.maxLines ?? 1,
      });
    } catch {
      raster = null;
    }
    if (cancelled()) return;
    if (raster === null) continue;
    const bounds = elementBoundsMm(element, data, options);
    canvas.fillStyle = LABEL_BACKGROUND;
    canvas.fillRect(bounds.x * scale, bounds.y * scale, bounds.w * scale, bounds.h * scale);
    const offsetDots = rasterAlignOffsetDots(element.align, maxWidthDots, raster.width);
    paintRaster(
      canvas,
      raster,
      (mmToDots(element.xMm, spec.dpi) + offsetDots) * dotPx,
      mmToDots(element.yMm, spec.dpi) * dotPx,
      dotPx,
    );
  }
}
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/label-renderer.test.ts`
Expected: PASS — 1 файл, 7 тестов; stderr пуст. Затем тот же файл под стендом с задержкой `setImmediate` — PASS, 7; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/label-renderer.ts` не отступать рамкой на полтолщины по горизонтали: фрагмент

<!-- prettier-ignore -->
```ts
    element.xMm * scale + thicknessPx / 2,
```

заменить на

<!-- prettier-ignore -->
```ts
    element.xMm * scale,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts -t "paints the label white"`
Expected: FAIL — `× paints the label white, then each element in black at the scale, with the sample's text`, `AssertionError: expected [ …(9) ] to deeply equal [ …(9) ]`.

Мутация 2. В `apps/standalone/src/office/templates/label-renderer.ts` не закрывать серию точек у правого края растра: фрагмент

<!-- prettier-ignore -->
```ts
    for (let column = 0; column <= raster.width; column++) {
```

заменить на

<!-- prettier-ignore -->
```ts
    for (let column = 0; column < raster.width; column++) {
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts -t "one rectangle per run"`
Expected: FAIL — `× paints a bitmap's black dots as one rectangle per run, within its width`, `AssertionError: expected [ [ 'fillRect', '#000000', 10, …(3) ] ] to deeply equal [ …(4) ]`.

Мутация 3. В `apps/standalone/src/office/templates/label-renderer.ts` не выравнивать текст внутри его ширины: фрагмент

<!-- prettier-ignore -->
```ts
  const drawX = align === "center" ? xPx + boxPx / 2 : align === "right" ? xPx + boxPx : xPx;
```

заменить на

<!-- prettier-ignore -->
```ts
  const drawX = xPx;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts -t "paints the label white"`
Expected: FAIL — `× paints the label white, then each element in black at the scale, with the sample's text`, `AssertionError: expected [ …(9) ] to deeply equal [ …(9) ]`.

Мутация 4. В `apps/standalone/src/office/templates/label-renderer.ts` просить растеризатор о другом семействе, чем печать: фрагмент

<!-- prettier-ignore -->
```ts
        fontFamily: PRINT_FONT_FAMILY,
```

заменить на

<!-- prettier-ignore -->
```ts
        fontFamily: "IBM Plex Sans",
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts -t "asks the rasterizer what the print asks"`
Expected: FAIL — `× asks the rasterizer what the print asks it, for the text that is not printable ASCII only`, `AssertionError: expected [ [ 'Партия', { …(5) } ], …(1) ] to deeply equal [ [ 'Партия', { …(5) } ], …(1) ]`.

Мутация 5. В `apps/standalone/src/office/templates/label-renderer.ts` рисовать растры текста и после отмены: удалить фрагмент

<!-- prettier-ignore -->
```ts
    if (cancelled()) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts -t "stops once cancelled"`
Expected: FAIL — `× keeps the drawing of an element its bitmap failed for, and stops once cancelled`, `AssertionError: expected [ …(4) ] to deeply equal []`.

Мутация 6. В `apps/standalone/src/office/templates/label-renderer.ts` не закрывать нативный текст под растром: удалить фрагмент

<!-- prettier-ignore -->
```ts
    canvas.fillRect(bounds.x * scale, bounds.y * scale, bounds.w * scale, bounds.h * scale);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts -t "covers each element's drawing"`
Expected: FAIL — `× covers each element's drawing and paints its bitmap where the printer puts it`, `AssertionError: expected [ 'fillRect', '#000000', …(4) ] to deeply equal [ 'fillRect', '#000000', …(4) ]`.

Мутация 7. В `apps/standalone/src/office/templates/label-renderer.ts` ставить растр текста без смещения выравнивания: фрагмент

<!-- prettier-ignore -->
```ts
      (mmToDots(element.xMm, spec.dpi) + offsetDots) * dotPx,
```

заменить на

<!-- prettier-ignore -->
```ts
      mmToDots(element.xMm, spec.dpi) * dotPx,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts -t "covers each element's drawing"`
Expected: FAIL — `× covers each element's drawing and paints its bitmap where the printer puts it`, `AssertionError: expected [ …(2) ] to deeply equal [ …(2) ]`.

Мутация 8. В `apps/standalone/src/office/templates/label-renderer.ts` рисовать код дубликата схемой в первом проходе: удалить фрагмент

<!-- prettier-ignore -->
```ts
  if (isStationRaster(element, options)) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts -t "leaves a product duplicate's code white"`
Expected: FAIL — `× leaves a product duplicate's code white, then paints it as the raster the station prints`, `AssertionError: expected [ …(220) ] to deeply equal [ …(25) ]`.

Мутация 9. В `apps/standalone/src/office/templates/label-renderer.ts` рисовать растр кода и после отмены: фрагмент

<!-- prettier-ignore -->
```ts
  if (print === null || cancelled()) return;
```

заменить на

<!-- prettier-ignore -->
```ts
  if (print === null) return;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/label-renderer.test.ts -t "leaves a product duplicate's code white"`
Expected: FAIL — `× leaves a product duplicate's code white, then paints it as the raster the station prints`, `AssertionError: expected [ …(1008) ] to deeply equal []`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/templates/label-renderer.ts apps/standalone/src/office/templates/label-print.ts apps/standalone/test/label-renderer.test.ts`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 56 файлов, 1311 тестов.

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/templates/label-renderer.ts apps/standalone/src/office/templates/label-print.ts apps/standalone/test/label-renderer.test.ts
git commit -m "feat(standalone): рисование макета этикетки и растры печати поверх него" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Предпросмотр макета в редакторе шаблона (`PreviewPane`)

Карточка «Макет» показывает макет таким, каким он печатается, как облачный `PreviewPane`: canvas 3 пикселя на миллиметр (изображение с именем «Предпросмотр этикетки 58 × 40 мм»), образец данных назначения (`labelSampleData`), перерисовка при каждом изменении макета (`drawLabel`), затем растр кода дубликата (`paintCodeRasters`) и растры печати поверх русского текста (`compositeTextRasters`, внедрённый `rasterizeText`); устаревший макет ничего не дорисовывает. Пока в макете есть текст для растра, предпросмотр проверяет, что во вложенном шрифте есть кириллица (`checkFamilyCoverage("IBM Plex Sans")`), и предупреждает, если её нет или проверить не удалось; у дубликата — заметка облака про синтетический код.

Как рисовать, офис берёт из контекста `LabelRendering` (`label-rendering.tsx`): контекст canvas, растеризатор и проверка шрифта. По умолчанию — вебвью (`BROWSER_LABEL_RENDERING`; проверка шрифта с opentype.js грузится отдельным чанком при первой проверке); `Office` получает свойство `labels`, а `renderOffice` в тестах — «тихий» набор `quietLabelRendering()`, поэтому прежние тесты не рисуют, не растрируют и не ждут проверки шрифта. `test/setup.ts` глушит `getContext` jsdom (он печатает «Not implemented» в stderr).

**Files:**

- Create: `apps/standalone/src/office/templates/label-rendering.tsx`, `apps/standalone/src/office/templates/PreviewPane.tsx`
- Modify: `apps/standalone/src/office/templates/TemplateEditor.tsx`, `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/template-preview.test.tsx` (Create), `apps/standalone/test/setup.ts`, `apps/standalone/test/support/office.tsx` (Modify)

**Interfaces:**

- Consumes: `drawLabel`, `paintCodeRasters`, `compositeTextRasters`, `rasterTextElements`, `type LabelCanvas` — задача 2; `rasterizeText`, `RasterUnavailableError` — `src/labels/rasterizer.ts`, `checkFamilyCoverage`, `type LabelFontFamily` — `src/labels/font-coverage.ts` (задача 1); `labelSampleData`, `labelRenderOptions` — `label-samples.ts`; `sizeText` — `template-text.ts`.
- Produces:
  - `label-rendering.tsx`: `interface LabelRendering { context(canvas): LabelCanvas | null; rasterizeText: RasterizeTextFn; checkFamilyCoverage(family): Promise<boolean> }`, `BROWSER_LABEL_RENDERING`, `LabelRenderingProvider({ value, children })`, `useLabelRendering()` (задача 5 прибавит `whenVisible`);
  - `PreviewPane({ spec, purpose })`;
  - `OfficeProps.labels?: LabelRendering`;
  - тесты: `quietLabelRendering(): LabelRendering` в `test/support/office.tsx`, `renderOffice` даёт его по умолчанию (`props.labels` заменяет).

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/template-preview.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDuplicateLabelTemplate,
  type LabelTemplateSpec,
  type RasterizeTextOptions,
  type RasterResult,
} from "@markiro/domain";

import type { LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import type { LabelFontFamily } from "../src/labels/font-coverage.js";
import type { LabelCanvas } from "../src/office/templates/label-renderer.js";
import {
  LabelRenderingProvider,
  type LabelRendering,
} from "../src/office/templates/label-rendering.js";
import { PreviewPane } from "../src/office/templates/PreviewPane.js";
import {
  fakeOfficeSession,
  quietLabelRendering,
  renderOffice,
  TECHNOLOGIST,
} from "./support/office.js";

type Op = (string | number)[];

/** A 2D context that records the filled text and rectangles; a character measures 10 px. */
function recordingCanvas(): LabelCanvas & { ops: Op[] } {
  const ops: Op[] = [];
  return {
    ops,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textBaseline: "alphabetic",
    textAlign: "start",
    clearRect(x, y, w, h) {
      ops.push(["clearRect", x, y, w, h]);
    },
    fillRect(x, y, w, h) {
      ops.push(["fillRect", String(this.fillStyle), x, y, w, h]);
    },
    strokeRect: () => undefined,
    fillText(text) {
      ops.push(["fillText", text]);
    },
    measureText: (text) => ({ width: text.length * 10 }),
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
  };
}

const DOT: RasterResult = { hex: "80", bytesPerRow: 1, totalBytes: 1, width: 1, height: 1 };

/** Rendering that draws on a recording canvas; the rasterizer and the check are the test's. */
function drawingTools(overrides: Partial<LabelRendering> = {}) {
  const canvas = recordingCanvas();
  const tools: LabelRendering = {
    ...quietLabelRendering(),
    context: () => canvas,
    ...overrides,
  };
  return { canvas, tools };
}

const ASCII: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { kind: "text", id: "lot", xMm: 4, yMm: 4, text: "LOT", fontSizePt: 10 },
    { kind: "field", id: "gtin", xMm: 4, yMm: 12, field: "product.gtin", fontSizePt: 10 },
  ],
};

const CYRILLIC: LabelTemplateSpec = {
  ...ASCII,
  widthMm: 100,
  elements: [{ kind: "text", id: "batch", xMm: 4, yMm: 20, text: "Партия", fontSizePt: 9 }],
};

function preview(
  spec: LabelTemplateSpec,
  tools: LabelRendering,
  purpose: "box" | "product_duplicate" = "box",
) {
  return (
    <LabelRenderingProvider value={tools}>
      <PreviewPane spec={spec} purpose={purpose} />
    </LabelRenderingProvider>
  );
}

const MISSING =
  "В шрифте этикетки нет кириллицы: русский текст напечатается не так, как в предпросмотре. Переустановите приложение на этом ПК.";
const CHECK_FAILED =
  "Не удалось проверить шрифт этикетки: русский текст может напечататься не так, как в предпросмотре.";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the layout preview", () => {
  it("draws the layout with the purpose's sample at 3 px per millimetre, as an image named by its size", () => {
    const { canvas, tools } = drawingTools();
    render(preview(ASCII, tools));
    const image = screen.getByRole("img", { name: "Предпросмотр этикетки 58 × 40 мм" });
    expect(image.getAttribute("width")).toBe("174");
    expect(image.getAttribute("height")).toBe("120");
    expect(canvas.ops[0]).toEqual(["clearRect", 0, 0, 174, 120]);
    expect(canvas.ops).toContainEqual(["fillText", "LOT"]);
    expect(canvas.ops).toContainEqual(["fillText", "04600682000013"]);
    expect(
      screen.getByText("Русский текст показан растром печати, коды — схемой. Масштаб: 3 пикс./мм."),
    ).toBeTruthy();
  });

  it("draws again when the layout changes, with the print bitmaps over its Cyrillic text", async () => {
    const rasterize = vi.fn(async (_text: string, _options: RasterizeTextOptions) => DOT);
    const { canvas, tools } = drawingTools({ rasterizeText: rasterize });
    const view = render(preview(ASCII, tools));
    expect(rasterize).not.toHaveBeenCalled();
    await act(async () => {
      view.rerender(preview(CYRILLIC, tools));
    });
    expect(screen.getByRole("img", { name: "Предпросмотр этикетки 100 × 40 мм" })).toBeTruthy();
    expect(rasterize.mock.calls.map(([text]) => text)).toEqual(["Партия"]);
    expect(canvas.ops).toContainEqual(["clearRect", 0, 0, 300, 120]);
    expect(canvas.ops.at(-1)?.[1]).toBe("#000000");
  });

  it("paints no bitmap of a layout that changed while it was being made", async () => {
    let finish: (raster: RasterResult) => void = () => undefined;
    const rasterize = vi.fn(
      () =>
        new Promise<RasterResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { canvas, tools } = drawingTools({ rasterizeText: rasterize });
    const view = render(preview(CYRILLIC, tools));
    await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(1));
    view.rerender(preview(ASCII, tools));
    const drawn = canvas.ops.length;
    await act(async () => {
      finish(DOT);
    });
    expect(canvas.ops).toHaveLength(drawn);
  });

  it("checks the font only for Cyrillic text, and says when it lacks Cyrillic or could not be checked", async () => {
    let answer: (covered: boolean) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const check = vi
      .fn<(family: LabelFontFamily) => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((_resolve, reject) => {
            fail = reject;
          }),
      );
    const { tools } = drawingTools({ checkFamilyCoverage: check });
    const view = render(preview(ASCII, tools));
    expect(check).not.toHaveBeenCalled();
    view.rerender(preview(CYRILLIC, tools));
    expect(check).toHaveBeenCalledWith("IBM Plex Sans");
    await act(async () => {
      answer(false);
    });
    expect(screen.getByRole("alert").textContent).toContain(MISSING);
    // A layout without such text has nothing to warn about.
    view.rerender(preview(ASCII, tools));
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(preview(CYRILLIC, tools));
    await act(async () => {
      fail(new Error("no font file"));
    });
    expect(screen.getByRole("alert").textContent).toContain(CHECK_FAILED);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("says nothing about the font when it has Cyrillic", async () => {
    const { tools } = drawingTools({ checkFamilyCoverage: async () => true });
    render(preview(CYRILLIC, tools));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("paints a product duplicate's code as the station's raster once its encoder has loaded", async () => {
    const { canvas, tools } = drawingTools();
    render(preview(buildDuplicateLabelTemplate(), tools, "product_duplicate"));
    const ink = () => canvas.ops.filter((op) => op[0] === "fillRect" && op[1] === "#000000");
    expect(ink()).toEqual([]);
    await waitFor(() => expect(ink().length).toBeGreaterThan(50));
  });

  it("tells that a product duplicate's code is a synthetic sample", () => {
    const { tools } = drawingTools();
    const view = render(preview(ASCII, tools, "product_duplicate"));
    const sample = "Образец с синтетическим кодом. На линии печатается код со сканера.";
    expect(screen.getByText(sample)).toBeTruthy();
    view.rerender(preview(ASCII, tools));
    expect(screen.queryByText(sample)).toBeNull();
  });
});

describe("the template editor's preview", () => {
  const GROUPS: ProductGroup[] = [{ code: 8, alias: "milk", name: "Молочная продукция" }];
  const BOX_58: LabelTemplateSummary = {
    id: "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
    name: "Коробка 58×40",
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: true,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 60,
  };
  const ZPL = [
    "^XA",
    "^PW464",
    "^LL320",
    "^FO40,40^A0N,34,34^FDПартия^FS",
    "^FO40,100^A0N,34,34^FD{{qty}}^FS",
    "^XZ",
  ].join("\n");

  it("shows the layout being edited and draws it again after an import", async () => {
    const fake = fakeOfficeSession({ user: TECHNOLOGIST });
    fake.api.listTemplates.mockResolvedValue([BOX_58]);
    fake.api.listProductGroups.mockResolvedValue(GROUPS);
    const { canvas, tools } = drawingTools();
    renderOffice(fake, { labels: tools });
    fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
    await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
    await screen.findByRole("heading", { name: "Новый шаблон" });
    const layout = screen.getByRole("heading", { level: 2, name: "Макет" }).closest(".mk-card");
    if (!(layout instanceof HTMLElement)) throw new Error("no layout card");
    expect(
      within(layout).getByRole("img", { name: "Предпросмотр этикетки 58 × 40 мм" }),
    ).toBeTruthy();
    expect(canvas.ops).not.toContainEqual(["fillText", "Партия"]);
    fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
    const dialog = await screen.findByRole("dialog", { name: "Импорт кода этикетки" });
    fireEvent.change(within(dialog).getByLabelText("Код ZPL"), { target: { value: ZPL } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Заменить макет" }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      within(layout).getByRole("img", { name: "Предпросмотр этикетки 58,06 × 40,04 мм" }),
    ).toBeTruthy();
    expect(canvas.ops).toContainEqual(["fillText", "Партия"]);
    expect(canvas.ops).toContainEqual(["fillText", "20 шт."]);
  });
});
```

2. В `apps/standalone/test/setup.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverMock,
    writable: true,
  });
}
```

заменить на

<!-- prettier-ignore -->
```ts
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverMock,
    writable: true,
  });

  // jsdom has no canvas: `getContext` logs «Not implemented» and returns null.
  // Here it returns null quietly; a test that looks at a drawing passes a
  // recording context of its own (`LabelRendering`).
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: () => null,
  });
}
```

3. В `apps/standalone/test/support/office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { Office, type OfficeProps } from "../../src/office/Office.js";
import type { OfficeSessionValue } from "../../src/office/office-session.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { RasterUnavailableError } from "../../src/labels/rasterizer.js";
import { Office, type OfficeProps } from "../../src/office/Office.js";
import type { OfficeSessionValue } from "../../src/office/office-session.js";
import type { LabelRendering } from "../../src/office/templates/label-rendering.js";
```

4. В `apps/standalone/test/support/office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
/** The office as the shell renders it, in the dark theme. */
export function renderOffice(
  session: OfficeSessionValue,
  props: Omit<OfficeProps, "session"> = {},
): RenderResult {
  return render(
    <ThemeProvider defaultTheme="dark">
      <Office session={session} {...props} />
    </ThemeProvider>,
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
/**
 * Label drawing that stays still in jsdom: no canvas, a rasterizer that
 * refuses as the webview does without one, and a font check that never
 * answers, so no warning arrives after a test has looked.
 */
export function quietLabelRendering(): LabelRendering {
  return {
    context: () => null,
    rasterizeText: () => Promise.reject(new RasterUnavailableError()),
    checkFamilyCoverage: () => new Promise<boolean>(() => undefined),
  };
}

/**
 * The office as the shell renders it, in the dark theme; it draws labels
 * quietly (`quietLabelRendering`) unless `props.labels` says otherwise.
 */
export function renderOffice(
  session: OfficeSessionValue,
  props: Omit<OfficeProps, "session"> = {},
): RenderResult {
  return render(
    <ThemeProvider defaultTheme="dark">
      <Office session={session} labels={quietLabelRendering()} {...props} />
    </ThemeProvider>,
  );
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-preview.test.tsx`
Expected: FAIL — 1 файл, `Tests  no tests`: `Failed to resolve import "../src/office/templates/label-rendering.js" from "test/template-preview.test.tsx"`.

- [ ] **Step 3: Контекст рисования, предпросмотр и его место в редакторе**

1. Создать `apps/standalone/src/office/templates/label-rendering.tsx`:

<!-- prettier-ignore -->
```tsx
import { createContext, useContext, type ReactNode } from "react";

import type { RasterizeTextFn } from "@markiro/domain";

import type { LabelFontFamily } from "../../labels/font-coverage.js";
import { rasterizeText } from "../../labels/rasterizer.js";
import type { LabelCanvas } from "./label-renderer.js";

/**
 * What the office draws labels with: a canvas's 2D context, the text
 * rasterizer and the font coverage check. The webview's own by default; a
 * test passes its own (jsdom has no canvas, and a font file is not fetched
 * there), as the cloud's `LabelEditorPage` takes `rasterizeText` and
 * `checkFamilyCoverage` as props.
 */
export interface LabelRendering {
  /** A canvas's 2D context; `null` where the webview gives none. */
  context: (canvas: HTMLCanvasElement) => LabelCanvas | null;
  rasterizeText: RasterizeTextFn;
  checkFamilyCoverage: (family: LabelFontFamily) => Promise<boolean>;
}

/**
 * The webview's canvas, the bundled-font rasterizer and the check of the
 * bundled fonts; the check, with opentype.js, is a chunk of its own, loaded
 * the first time a layout has Cyrillic text.
 */
export const BROWSER_LABEL_RENDERING: LabelRendering = {
  context: (canvas) => canvas.getContext("2d"),
  rasterizeText,
  checkFamilyCoverage: async (family) => {
    const { checkFamilyCoverage } = await import("../../labels/font-coverage.js");
    return checkFamilyCoverage(family);
  },
};

const LabelRenderingContext = createContext<LabelRendering>(BROWSER_LABEL_RENDERING);

/** Gives the office below another way to draw labels (tests). */
export function LabelRenderingProvider({
  value,
  children,
}: {
  value: LabelRendering;
  children: ReactNode;
}) {
  return <LabelRenderingContext value={value}>{children}</LabelRenderingContext>;
}

/** How labels are drawn here. */
export function useLabelRendering(): LabelRendering {
  return useContext(LabelRenderingContext);
}
```

2. Создать `apps/standalone/src/office/templates/PreviewPane.tsx`:

<!-- prettier-ignore -->
```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LabelTemplateSpec } from "@markiro/domain";
import { Alert } from "@markiro/ui";

import type { TemplatePurpose } from "../../host/protocol.js";
import type { LabelFontFamily } from "../../labels/font-coverage.js";
import {
  compositeTextRasters,
  drawLabel,
  paintCodeRasters,
  rasterTextElements,
} from "./label-renderer.js";
import { useLabelRendering } from "./label-rendering.js";
import { labelRenderOptions, labelSampleData } from "./label-samples.js";
import { sizeText } from "./template-text.js";

/** Pixels per millimetre of the preview: a 58 mm label is 174 px wide. */
const SCALE = 3;

/** The face the print's bitmaps are drawn in (`mapFontFamily` of the generators' «sans-serif»). */
const PREVIEW_FONT_FAMILY: LabelFontFamily = "IBM Plex Sans";

type Coverage = "ok" | "missing" | "failed";

export interface PreviewPaneProps {
  spec: LabelTemplateSpec;
  purpose: TemplatePurpose;
}

/**
 * The layout as it prints, after the cloud's `PreviewPane`: drawn with the
 * purpose's sample data (`labelSampleData`) and drawn again whenever the
 * layout changes, a duplicate's code painted as the station's raster
 * (`paintCodeRasters`) and the print's own bitmaps put over its Cyrillic text
 * (`compositeTextRasters`), and a warning when the font lacks Cyrillic or
 * could not be checked. The check runs only while the layout has such text;
 * it needs no canvas, so a webview without one still says it.
 */
export function PreviewPane({ spec, purpose }: PreviewPaneProps) {
  const { t } = useTranslation();
  const { context, rasterizeText, checkFamilyCoverage } = useLabelRendering();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [coverage, setCoverage] = useState<Coverage>("ok");
  const data = labelSampleData(purpose);
  const options = labelRenderOptions(purpose);
  const needsCheck = rasterTextElements(spec, data).length > 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    const drawing = canvas === null ? null : context(canvas);
    if (drawing === null) return undefined;
    drawLabel(spec, drawing, SCALE, data, options);
    let cancelled = false;
    const isCancelled = () => cancelled;
    void paintCodeRasters(spec, drawing, SCALE, data, options, isCancelled).then(() =>
      compositeTextRasters(spec, drawing, SCALE, data, options, rasterizeText, isCancelled),
    );
    return () => {
      cancelled = true;
    };
  }, [spec, data, options, context, rasterizeText]);

  useEffect(() => {
    if (!needsCheck) return undefined;
    let cancelled = false;
    checkFamilyCoverage(PREVIEW_FONT_FAMILY).then(
      (covered) => {
        if (!cancelled) setCoverage(covered ? "ok" : "missing");
      },
      () => {
        if (!cancelled) setCoverage("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needsCheck, checkFamilyCoverage]);

  const shown = needsCheck ? coverage : "ok";
  return (
    <figure className="template-preview">
      <canvas
        ref={canvasRef}
        className="template-preview__label"
        role="img"
        aria-label={t("office.templateEditor.preview.label", { size: sizeText(spec, t) })}
        width={Math.round(spec.widthMm * SCALE)}
        height={Math.round(spec.heightMm * SCALE)}
      />
      <figcaption className="office-note">
        {t("office.templateEditor.preview.caption", { scale: SCALE })}
      </figcaption>
      {purpose === "product_duplicate" && (
        <p className="office-note">{t("office.templateEditor.preview.sample")}</p>
      )}
      {shown === "missing" && (
        <Alert tone="warn">{t("office.templateEditor.preview.missingGlyphs")}</Alert>
      )}
      {shown === "failed" && (
        <Alert tone="warn">{t("office.templateEditor.preview.checkFailed")}</Alert>
      )}
    </figure>
  );
}
```

3. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { officeRoutes } from "./routes.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { officeRoutes } from "./routes.js";
import {
  BROWSER_LABEL_RENDERING,
  LabelRenderingProvider,
  type LabelRendering,
} from "./templates/label-rendering.js";
```

4. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  deviceId?: string | null;
}
```

заменить на

<!-- prettier-ignore -->
```tsx
  deviceId?: string | null;
  /**
   * How the office draws labels (the template editor's preview): the
   * webview's canvas and fonts by default; a test passes its own.
   */
  labels?: LabelRendering;
}
```

5. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  deviceId = null,
}: OfficeProps) {
```

заменить на

<!-- prettier-ignore -->
```tsx
  deviceId = null,
  labels = BROWSER_LABEL_RENDERING,
}: OfficeProps) {
```

6. В `apps/standalone/src/office/Office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
          <ThisDeviceProvider deviceId={deviceId}>
            <RouterProvider router={router} />
          </ThisDeviceProvider>
```

заменить на

<!-- prettier-ignore -->
```tsx
          <ThisDeviceProvider deviceId={deviceId}>
            <LabelRenderingProvider value={labels}>
              <RouterProvider router={router} />
            </LabelRenderingProvider>
          </ThisDeviceProvider>
```

7. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { LabelSizeDialog } from "./LabelSizeDialog.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { LabelSizeDialog } from "./LabelSizeDialog.js";
import { PreviewPane } from "./PreviewPane.js";
```

8. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * only an import puts on the label (`ImportCodeDialog`); a layout downloads
 * as JSON. Nothing goes to the host before «Сохранить»: the name is trimmed
```

заменить на

<!-- prettier-ignore -->
```tsx
 * only an import puts on the label (`ImportCodeDialog`) and the preview
 * shows as it prints (`PreviewPane`); a layout downloads as JSON. Nothing
 * goes to the host before «Сохранить»: the name is trimmed
```

9. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
                  : t("office.templateEditor.elements", { n: draft.spec.elements.length })}
              </p>
```

заменить на

<!-- prettier-ignore -->
```tsx
                  : t("office.templateEditor.elements", { n: draft.spec.elements.length })}
              </p>
              <PreviewPane spec={draft.spec} purpose={draft.purpose} />
```

10. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "languages": "Один шаблон печатается и на Zebra, и на TSC: станция выбирает язык по своему принтеру.",
```

заменить на

<!-- prettier-ignore -->
```json
      "languages": "Один шаблон печатается и на Zebra, и на TSC: станция выбирает язык по своему принтеру.",
      "preview": {
        "label": "Предпросмотр этикетки {{size}}",
        "caption": "Русский текст показан растром печати, коды — схемой. Масштаб: {{scale}} пикс./мм.",
        "sample": "Образец с синтетическим кодом. На линии печатается код со сканера.",
        "missingGlyphs": "В шрифте этикетки нет кириллицы: русский текст напечатается не так, как в предпросмотре. Переустановите приложение на этом ПК.",
        "checkFailed": "Не удалось проверить шрифт этикетки: русский текст может напечататься не так, как в предпросмотре."
      },
```

11. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
/* The size dialog's width and height side by side. */
```

заменить на

<!-- prettier-ignore -->
```css
/* The layout's preview: the label as white stock at its own size, its notes under it. */
.template-preview {
  display: grid;
  justify-items: start;
  gap: 8px;
  margin: 0;
}

.template-preview__label {
  max-width: 100%;
  background: var(--paper);
  border: 1px solid var(--line-strong);
}

/* The size dialog's width and height side by side. */
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/template-preview.test.tsx test/office.test.tsx test/template-editor.test.tsx`
Expected: PASS — 3 файла, 130 тестов; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` — PASS; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/PreviewPane.tsx` не отменять растры устаревшего макета: фрагмент

<!-- prettier-ignore -->
```tsx
      compositeTextRasters(spec, drawing, SCALE, data, options, rasterizeText, isCancelled),
    );
    return () => {
      cancelled = true;
    };
```

заменить на

<!-- prettier-ignore -->
```tsx
      compositeTextRasters(spec, drawing, SCALE, data, options, rasterizeText, isCancelled),
    );
    return () => {};
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-preview.test.tsx -t "paints no bitmap of a layout that changed"`
Expected: FAIL — `× paints no bitmap of a layout that changed while it was being made`, `AssertionError: expected [ …(9) ] to have a length of 7 but got 9`.

Мутация 2. В `apps/standalone/src/office/templates/PreviewPane.tsx` проверять шрифт и без русского текста: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    if (!needsCheck) return undefined;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-preview.test.tsx -t "checks the font only for Cyrillic text"`
Expected: FAIL — `× checks the font only for Cyrillic text, and says when it lacks Cyrillic or could not be checked`, `AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times`.

Мутация 3. В `apps/standalone/src/office/templates/PreviewPane.tsx` держать предупреждение о шрифте и без русского текста: фрагмент

<!-- prettier-ignore -->
```tsx
  const shown = needsCheck ? coverage : "ok";
```

заменить на

<!-- prettier-ignore -->
```tsx
  const shown = coverage;
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-preview.test.tsx -t "checks the font only for Cyrillic text"`
Expected: FAIL — `× checks the font only for Cyrillic text, and says when it lacks Cyrillic or could not be checked`, `AssertionError: expected <div role="alert" …(2)>…(2)</div> to be null`.

Мутация 4. В `apps/standalone/src/office/templates/PreviewPane.tsx` проверять не то семейство: фрагмент

<!-- prettier-ignore -->
```tsx
const PREVIEW_FONT_FAMILY: LabelFontFamily = "IBM Plex Sans";
```

заменить на

<!-- prettier-ignore -->
```tsx
const PREVIEW_FONT_FAMILY: LabelFontFamily = "IBM Plex Mono";
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-preview.test.tsx -t "checks the font only for Cyrillic text"`
Expected: FAIL — `× checks the font only for Cyrillic text, and says when it lacks Cyrillic or could not be checked`, `AssertionError: expected "vi.fn()" to be called with arguments: [ 'IBM Plex Sans' ]`.

Мутация 5. В `apps/standalone/src/office/templates/PreviewPane.tsx` не рисовать растр кода дубликата: фрагмент

<!-- prettier-ignore -->
```tsx
    void paintCodeRasters(spec, drawing, SCALE, data, options, isCancelled).then(() =>
      compositeTextRasters(spec, drawing, SCALE, data, options, rasterizeText, isCancelled),
    );
```

заменить на

<!-- prettier-ignore -->
```tsx
    void compositeTextRasters(spec, drawing, SCALE, data, options, rasterizeText, isCancelled);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-preview.test.tsx -t "paints a product duplicate's code"`
Expected: FAIL — `× paints a product duplicate's code as the station's raster once its encoder has loaded`, `AssertionError: expected 0 to be greater than 50`.

Мутация 6. В `apps/standalone/src/office/templates/TemplateEditor.tsx` показывать открытый макет, а не правку: фрагмент

<!-- prettier-ignore -->
```tsx
              <PreviewPane spec={draft.spec} purpose={draft.purpose} />
```

заменить на

<!-- prettier-ignore -->
```tsx
              <PreviewPane spec={opened.spec} purpose={draft.purpose} />
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-preview.test.tsx -t "shows the layout being edited"`
Expected: FAIL — `× shows the layout being edited and draws it again after an import`, `TestingLibraryElementError: Unable to find an accessible element with the role "img" and name "Предпросмотр этикетки 58,06 × 40,04 мм"`.

Мутация 7. В `apps/standalone/src/office/Office.tsx` не отдавать офису свой способ рисовать: фрагмент

<!-- prettier-ignore -->
```tsx
            <LabelRenderingProvider value={labels}>
```

заменить на

<!-- prettier-ignore -->
```tsx
            <LabelRenderingProvider value={BROWSER_LABEL_RENDERING}>
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-preview.test.tsx -t "shows the layout being edited"`
Expected: FAIL — `× shows the layout being edited and draws it again after an import`, `AssertionError: expected [] to deep equally contain [ 'fillText', 'Партия' ]`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/templates/label-rendering.tsx apps/standalone/src/office/templates/PreviewPane.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/office/Office.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/template-preview.test.tsx apps/standalone/test/setup.ts apps/standalone/test/support/office.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 57 файлов, 1319 тестов.

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/templates/label-rendering.tsx apps/standalone/src/office/templates/PreviewPane.tsx apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/office/Office.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/app/shell.css apps/standalone/test/template-preview.test.tsx apps/standalone/test/setup.ts apps/standalone/test/support/office.tsx
git commit -m "feat(standalone): предпросмотр макета в редакторе шаблона" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Выгрузки ZPL и TSPL в редакторе шаблона

«Скачать ZPL» и «Скачать TSPL (TSC)» рядом со «Скачать JSON», как в облаке: файл — документ домена (`generateZpl`, `generateTspl`) макета с образцом данных назначения и параметрами отрисовки (дубликат — растр кода), русский текст — растрами внедрённого `rasterizeText`, то есть тот документ, который станция отправила бы своему принтеру. Генераторы грузятся из `label-print.ts` отдельным чанком (они тянут bwip-js). Файл пишется байт в байт (`latin1Bytes`: `Blob` строки записал бы каждый символ от 0x80, в том числе байты `BITMAP` TSPL, двумя байтами UTF-8) и сохраняется тем же `downloadFile`, что JSON, под именем `templateFileName`. Пока файл собирается, обе кнопки кода выключены (у нажатой — индикатор); пока дубликат нарушает правило, они тоже выключены, а JSON — нет. Если текст не нарисовался, файл не сохраняется, а над кнопками — «Файл не собран…».

`<a download>` с blob URL в WebView2 и WKWebView не проверен (план 1e4 «Перенесено»): если вебвью Tauri не сохранит файл, все три выгрузки нужно будет вести через команду оболочки (диалог сохранения и запись байтов) — это изменение `src-tauri` и решение владельца, в этом плане оболочка не меняется.

**Files:**

- Modify: `apps/standalone/src/office/templates/download.ts`, `apps/standalone/src/office/templates/label-print.ts`, `apps/standalone/src/office/templates/TemplateEditor.tsx`, `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/template-code-downloads.test.tsx` (Create)

**Interfaces:**

- Consumes: `useLabelRendering` — задача 3; `labelSampleData`, `labelRenderOptions` — `label-samples.ts`; `downloadFile`, `templateFileName` — план 1e4.
- Produces: `download.ts`: `latin1Bytes(text): Uint8Array<ArrayBuffer>`, `zplBlob(zpl): Blob` (`text/plain`), `tsplBlob(tspl): Blob` (`application/octet-stream`); `label-print.ts` реэкспортирует ещё `generateTspl`, `generateZpl`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/template-code-downloads.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateTspl,
  generateZpl,
  type RasterizeTextOptions,
  type RasterResult,
} from "@markiro/domain";

import type { LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { latin1Bytes, tsplBlob, zplBlob } from "../src/office/templates/download.js";
import { analyzeImport } from "../src/office/templates/import-analysis.js";
import type { LabelRendering } from "../src/office/templates/label-rendering.js";
import { labelSampleData } from "../src/office/templates/label-samples.js";
import {
  fakeOfficeSession,
  quietLabelRendering,
  renderOffice,
  TECHNOLOGIST,
} from "./support/office.js";

const GROUPS: ProductGroup[] = [{ code: 8, alias: "milk", name: "Молочная продукция" }];

const BOX_58: LabelTemplateSummary = {
  id: "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c",
  name: "Коробка 58×40",
  purpose: "box",
  enabled: true,
  chzProductGroupCodes: null,
  stock: true,
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  rev: 60,
};

/** 58×40 mm at 203 dpi: a text line and a `{{qty}}` field, both Cyrillic once filled. */
const ZPL = [
  "^XA",
  "^PW464",
  "^LL320",
  "^FO40,40^A0N,34,34^FDПартия^FS",
  "^FO40,100^A0N,34,34^FD{{qty}}^FS",
  "^XZ",
].join("\n");

function importedSpec() {
  const outcome = analyzeImport({ source: ZPL, format: "zpl", dpi: 203, purpose: "box" });
  if (!outcome.ok) throw new Error("the sample does not import");
  return outcome.analysis.result.spec;
}

/** A bitmap of one byte of ink and one of none: 0xFF and 0x00 once TSPL inverts them. */
const BITMAP: RasterResult = { hex: "FF00", bytesPerRow: 2, totalBytes: 2, width: 16, height: 1 };

function bitmaps() {
  return vi.fn(async (_text: string, _options: RasterizeTextOptions) => BITMAP);
}

/** What the page saves: each blob and the name of each clicked link. */
function recordDownloads() {
  const blobs: Blob[] = [];
  const names: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
    if (blob instanceof Blob) blobs.push(blob);
    return "blob:template";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    names.push(this.download);
  });
  return { blobs, names };
}

async function openNew(labels: LabelRendering): Promise<void> {
  const fake = fakeOfficeSession({ user: TECHNOLOGIST });
  fake.api.listTemplates.mockResolvedValue([BOX_58]);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  renderOffice(fake, { labels });
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Создать шаблон" }));
  await screen.findByRole("heading", { name: "Новый шаблон" });
}

async function importZpl(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Импорт кода" }));
  const dialog = await screen.findByRole("dialog", { name: "Импорт кода этикетки" });
  fireEvent.change(within(dialog).getByLabelText("Код ZPL"), { target: { value: ZPL } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Проверить код" }));
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Заменить макет" }));
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

async function bytesOf(blob: Blob | undefined): Promise<number[]> {
  if (blob === undefined) throw new Error("nothing was saved");
  return [...new Uint8Array(await blob.arrayBuffer())];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a code file of a label", () => {
  it("keeps each character a byte, where a blob of the text would write two", async () => {
    const text = `A${String.fromCharCode(0xff)}`;
    expect([...latin1Bytes(text)]).toEqual([0x41, 0xff]);
    expect(new Blob([text]).size).toBe(3);
    expect(await bytesOf(tsplBlob(text))).toEqual([0x41, 0xff]);
    expect(tsplBlob(text).type).toBe("application/octet-stream");
    expect(await bytesOf(zplBlob(text))).toEqual([0x41, 0xff]);
    expect(zplBlob(text).type).toBe("text/plain");
  });
});

describe("the template editor's code downloads", () => {
  it("saves the domain's ZPL of the layout with the purpose's sample and the print's bitmaps, under the template's name", async () => {
    const saved = recordDownloads();
    const rasterize = bitmaps();
    await openNew({ ...quietLabelRendering(), rasterizeText: rasterize });
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: " Молоко 58×40 " } });
    await importZpl();
    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));
    await waitFor(() => expect(saved.names).toEqual(["Молоко-58-40.zpl"]));
    expect(rasterize.mock.calls.map(([text]) => text)).toEqual(["Партия", "20 шт."]);
    const expected = await generateZpl(importedSpec(), labelSampleData("box"), {
      rasterizeText: bitmaps(),
    });
    expect(saved.blobs[0]?.type).toBe("text/plain");
    expect(await saved.blobs[0]?.text()).toBe(expected);
  });

  it("saves the domain's TSPL with the bitmap's bytes one for one", async () => {
    const saved = recordDownloads();
    await openNew({ ...quietLabelRendering(), rasterizeText: bitmaps() });
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Молоко" } });
    await importZpl();
    fireEvent.click(screen.getByRole("button", { name: "Скачать TSPL (TSC)" }));
    await waitFor(() => expect(saved.names).toEqual(["Молоко.tspl"]));
    const expected = await generateTspl(importedSpec(), labelSampleData("box"), {
      rasterizeText: bitmaps(),
    });
    const bytes = await bytesOf(saved.blobs[0]);
    expect(bytes).toEqual([...expected].map((char) => char.charCodeAt(0)));
    expect(bytes).toContain(0xff);
    expect(saved.blobs[0]?.type).toBe("application/octet-stream");
  });

  it("says the file was not made when the text cannot be drawn, and saves nothing", async () => {
    const saved = recordDownloads();
    await openNew(quietLabelRendering());
    await importZpl();
    fireEvent.click(screen.getByRole("button", { name: "Скачать ZPL" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Файл не собран: русский текст этикетки не удалось нарисовать. Попробуйте ещё раз.",
    );
    expect(saved.names).toEqual([]);
  });

  it("keeps both code downloads off while a product duplicate breaks its rule, and the JSON on", async () => {
    await openNew(quietLabelRendering());
    fireEvent.change(screen.getByRole("combobox", { name: "Назначение" }), {
      target: { value: "product_duplicate" },
    });
    expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", false);
    await importZpl();
    expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Скачать TSPL (TSC)" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Скачать JSON" })).toHaveProperty("disabled", false);
  });

  it("keeps both code downloads off while one file is being made", async () => {
    let finish: (raster: RasterResult) => void = () => undefined;
    const rasterize = vi.fn(
      () =>
        new Promise<RasterResult>((resolve) => {
          finish = resolve;
        }),
    );
    const saved = recordDownloads();
    await openNew({ ...quietLabelRendering(), rasterizeText: rasterize });
    await importZpl();
    fireEvent.click(screen.getByRole("button", { name: "Скачать TSPL (TSC)" }));
    expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Скачать TSPL (TSC)" })).toHaveProperty(
      "disabled",
      true,
    );
    // Two texts, one bitmap after the other.
    await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(1));
    await act(async () => {
      finish(BITMAP);
    });
    await waitFor(() => expect(rasterize).toHaveBeenCalledTimes(2));
    await act(async () => {
      finish(BITMAP);
    });
    await waitFor(() => expect(saved.names).toEqual(["label.tspl"]));
    expect(screen.getByRole("button", { name: "Скачать ZPL" })).toHaveProperty("disabled", false);
  });
});
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-code-downloads.test.tsx`
Expected: FAIL — `Tests  6 failed (6)`; падают: `× keeps each character a byte, where a blob of the text would write two`, `× saves the domain's ZPL of the layout with the purpose's sample and the print's bitmaps, under the template's name`, `× saves the domain's TSPL with the bitmap's bytes one for one`, `× says the file was not made when the text cannot be drawn, and saves nothing`, `× keeps both code downloads off while a product duplicate breaks its rule, and the JSON on`, `× keeps both code downloads off while one file is being made`.

- [ ] **Step 3: Байты файла и кнопки выгрузок**

1. В `apps/standalone/src/office/templates/download.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  anchor.remove();
  URL.revokeObjectURL(url);
}
```

заменить на

<!-- prettier-ignore -->
```ts
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * A document of the domain's generators as its bytes, one byte per
 * character, after the cloud's `latin1ToUint8Array`: TSPL's `BITMAP` carries
 * raw bytes as characters 0x00–0xFF, and a ZPL `^FD` may carry a Latin-1
 * byte, while a `Blob` of the string would write each character from 0x80 up
 * as two UTF-8 bytes. `& 0xff` keeps the result whole for any other text.
 */
export function latin1Bytes(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/** A ZPL document to save: text, byte for byte. */
export function zplBlob(zpl: string): Blob {
  return new Blob([latin1Bytes(zpl)], { type: "text/plain" });
}

/** A TSPL document to save: it may hold binary bitmap bytes. */
export function tsplBlob(tspl: string): Blob {
  return new Blob([latin1Bytes(tspl)], { type: "application/octet-stream" });
}
```

2. Заменить содержимое `apps/standalone/src/office/templates/label-print.ts` целиком:

<!-- prettier-ignore -->
```ts
/**
 * The domain's printing code, loaded on its own (`import("./label-print.js")`):
 * the ZPL and TSPL generators and the GS1 DataMatrix raster bring the barcode
 * encoder (bwip-js, about 0.9 MB) with them, which the webview needs only once
 * a duplicate's code is drawn or a code file is saved, not when it starts.
 */
export { generateTspl, generateZpl, rasterizeGs1DataMatrix } from "@markiro/domain";
```

3. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { downloadFile } from "./download.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { downloadFile, tsplBlob, zplBlob } from "./download.js";
```

4. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { ImportCodeDialog } from "./ImportCodeDialog.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { ImportCodeDialog } from "./ImportCodeDialog.js";
import { useLabelRendering } from "./label-rendering.js";
import { labelRenderOptions, labelSampleData } from "./label-samples.js";
```

5. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * shows as it prints (`PreviewPane`); a layout downloads as JSON. Nothing
 * goes to the host before «Сохранить»: the name is trimmed
```

заменить на

<!-- prettier-ignore -->
```tsx
 * shows as it prints (`PreviewPane`); a layout downloads as ZPL, TSPL or
 * JSON. Nothing goes to the host before «Сохранить»: the name is trimmed
```

6. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const [deleting, setDeleting] = useState(false);
```

заменить на

<!-- prettier-ignore -->
```tsx
  const [deleting, setDeleting] = useState(false);
  const [preparing, setPreparing] = useState<"zpl" | "tspl" | null>(null);
  const [codeFailed, setCodeFailed] = useState(false);
  const { rasterizeText } = useLabelRendering();
```

7. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  const errorOf = (field: EditorField) =>
```

заменить на

<!-- prettier-ignore -->
```tsx
  // A code file is the domain's document of the layout with the purpose's sample, its
  // Cyrillic as the print's bitmaps: what a station would send to its printer.
  const downloadCode = async (language: "zpl" | "tspl") => {
    setPreparing(language);
    setCodeFailed(false);
    const data = labelSampleData(draft.purpose);
    const deps = { rasterizeText, ...labelRenderOptions(draft.purpose) };
    let blob: Blob;
    try {
      // The generators come with the barcode encoder, a chunk of its own.
      const { generateTspl, generateZpl } = await import("./label-print.js");
      blob =
        language === "zpl"
          ? zplBlob(await generateZpl(draft.spec, data, deps))
          : tsplBlob(await generateTspl(draft.spec, data, deps));
    } catch {
      setCodeFailed(true);
      return;
    } finally {
      setPreparing(null);
    }
    downloadFile(blob, `${templateFileName(draft.name)}.${language}`);
  };

  const errorOf = (field: EditorField) =>
```

8. В `apps/standalone/src/office/templates/TemplateEditor.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
                <Button variant="secondary" onClick={downloadJson}>
                  {t("office.templateEditor.downloadJson")}
                </Button>
              </div>
```

заменить на

<!-- prettier-ignore -->
```tsx
                {/* A broken duplicate has no code to print; its JSON can still be saved. */}
                <Button
                  variant="secondary"
                  disabled={duplicateInvalid || preparing !== null}
                  loading={preparing === "zpl"}
                  onClick={() => void downloadCode("zpl")}
                >
                  {t("office.templateEditor.downloadZpl")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={duplicateInvalid || preparing !== null}
                  loading={preparing === "tspl"}
                  onClick={() => void downloadCode("tspl")}
                >
                  {t("office.templateEditor.downloadTspl")}
                </Button>
                <Button variant="secondary" onClick={downloadJson}>
                  {t("office.templateEditor.downloadJson")}
                </Button>
              </div>
              {codeFailed && <Alert tone="error">{t("office.templateEditor.codeFailed")}</Alert>}
```

9. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
      "downloadJson": "Скачать JSON",
```

заменить на

<!-- prettier-ignore -->
```json
      "downloadZpl": "Скачать ZPL",
      "downloadTspl": "Скачать TSPL (TSC)",
      "downloadJson": "Скачать JSON",
      "codeFailed": "Файл не собран: русский текст этикетки не удалось нарисовать. Попробуйте ещё раз.",
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/template-code-downloads.test.tsx test/template-editor.test.tsx`
Expected: PASS — 2 файла, 103 теста; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` — PASS; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/download.ts` отдать `Blob` строку ZPL: фрагмент

<!-- prettier-ignore -->
```ts
  return new Blob([latin1Bytes(zpl)], { type: "text/plain" });
```

заменить на

<!-- prettier-ignore -->
```ts
  return new Blob([zpl], { type: "text/plain" });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-code-downloads.test.tsx -t "keeps each character a byte"`
Expected: FAIL — `× keeps each character a byte, where a blob of the text would write two`, `AssertionError: expected [ 65, 195, 191 ] to deeply equal [ 65, 255 ]`.

Мутация 2. В `apps/standalone/src/office/templates/download.ts` отдать `Blob` строку TSPL: фрагмент

<!-- prettier-ignore -->
```ts
  return new Blob([latin1Bytes(tspl)], { type: "application/octet-stream" });
```

заменить на

<!-- prettier-ignore -->
```ts
  return new Blob([tspl], { type: "application/octet-stream" });
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-code-downloads.test.tsx -t "bitmap's bytes one for one"`
Expected: FAIL — `× saves the domain's TSPL with the bitmap's bytes one for one`, `AssertionError: expected [ 83, 73, 90, 69, 32, 53, 56, …(128) ] to deeply equal [ 83, 73, 90, 69, 32, 53, 56, …(126) ]`.

Мутация 3. В `apps/standalone/src/office/templates/TemplateEditor.tsx` не выключать «Скачать ZPL» у сломанного дубликата: фрагмент

<!-- prettier-ignore -->
```tsx
                  disabled={duplicateInvalid || preparing !== null}
                  loading={preparing === "zpl"}
```

заменить на

<!-- prettier-ignore -->
```tsx
                  disabled={preparing !== null}
                  loading={preparing === "zpl"}
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-code-downloads.test.tsx -t "breaks its rule"`
Expected: FAIL — `× keeps both code downloads off while a product duplicate breaks its rule, and the JSON on`, `AssertionError: expected <button type="button" …(2)></button> to have property "disabled" with value true`.

Мутация 4. В `apps/standalone/src/office/templates/TemplateEditor.tsx` не передавать генераторам растеризатор: фрагмент

<!-- prettier-ignore -->
```tsx
    const deps = { rasterizeText, ...labelRenderOptions(draft.purpose) };
```

заменить на

<!-- prettier-ignore -->
```tsx
    const deps = { ...labelRenderOptions(draft.purpose) };
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-code-downloads.test.tsx -t "saves the domain's ZPL"`
Expected: FAIL — `× saves the domain's ZPL of the layout with the purpose's sample and the print's bitmaps, under the template's name`, `AssertionError: expected [] to deeply equal [ 'Молоко-58-40.zpl' ]`.

Мутация 5. В `apps/standalone/src/office/templates/TemplateEditor.tsx` брать образец паллеты для любого назначения: фрагмент

<!-- prettier-ignore -->
```tsx
    const data = labelSampleData(draft.purpose);
```

заменить на

<!-- prettier-ignore -->
```tsx
    const data = labelSampleData("pallet");
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-code-downloads.test.tsx -t "saves the domain's ZPL"`
Expected: FAIL — `× saves the domain's ZPL of the layout with the purpose's sample and the print's bitmaps, under the template's name`, `AssertionError: expected [ 'Партия', '240 шт.' ] to deeply equal [ 'Партия', '20 шт.' ]`.

Мутация 6. В `apps/standalone/src/office/templates/TemplateEditor.tsx` молчать, когда файл не собран: удалить фрагмент

<!-- prettier-ignore -->
```tsx
      setCodeFailed(true);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-code-downloads.test.tsx -t "says the file was not made"`
Expected: FAIL — `× says the file was not made when the text cannot be drawn, and saves nothing`, `TestingLibraryElementError: Unable to find role="alert"`.

Мутация 7. В `apps/standalone/src/office/templates/TemplateEditor.tsx` не включать кнопки обратно после выгрузки: фрагмент

<!-- prettier-ignore -->
```tsx
    } finally {
      setPreparing(null);
    }
```

заменить на

<!-- prettier-ignore -->
```tsx
    }
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-code-downloads.test.tsx -t "while one file is being made"`
Expected: FAIL — `× keeps both code downloads off while one file is being made`, `AssertionError: expected <button type="button" …(3)></button> to have property "disabled" with value false`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/templates/download.ts apps/standalone/src/office/templates/label-print.ts apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/template-code-downloads.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 58 файлов, 1325 тестов.

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/templates/download.ts apps/standalone/src/office/templates/label-print.ts apps/standalone/src/office/templates/TemplateEditor.tsx apps/standalone/src/i18n/ru.json apps/standalone/test/template-code-downloads.test.tsx
git commit -m "feat(standalone): выгрузки ZPL и TSPL в редакторе шаблона" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Миниатюры шаблонов в списке «Шаблоны»

У каждого названия на «Шаблонах» — миниатюра макета, как карточки облака (`TemplateThumb`): рамка 64 × 48 px, этикетка в ней со своими пропорциями, нарисованная с образцом данных назначения (`drawLabel`, у дубликата — растр кода `paintCodeRasters`). Сводки макетов не держат (D2), поэтому миниатюра читает шаблон с макетом сама — `getTemplate` по строке, только когда строка подходит к экрану (`whenVisible`: `IntersectionObserver` на 200 px вперёд; вебвью без него показывает все сразу), — и кладёт его в кэш по паре «id, ревизия» (`useTemplateLayout`, `officeKeys.templateLayout`, `staleTime: Infinity`). Возврат на страницу рисует прочитанный макет сразу; строка с новой ревизией (любая запись) читает макет заново. Пока макет не прочитан, не загрузился или не читается доменом, рамка пуста; отказ чтения не показывается: миниатюра декоративна (`aria-hidden="true"`), что это за шаблон, говорит название рядом. `useOfficeQuery` получает необязательное `enabled`.

**Files:**

- Create: `apps/standalone/src/office/templates/TemplateThumb.tsx`
- Modify: `apps/standalone/src/office/office-query.ts`, `apps/standalone/src/office/catalog-queries.ts`, `apps/standalone/src/office/templates/label-rendering.tsx`, `apps/standalone/src/office/templates/TemplatesPage.tsx`, `apps/standalone/src/app/shell.css`
- Test: `apps/standalone/test/template-thumbs.test.tsx` (Create), `apps/standalone/test/support/office.tsx`, `apps/standalone/test/templates-page.test.tsx` (Modify)

**Interfaces:**

- Consumes: `drawLabel`, `paintCodeRasters` — задача 2; `useLabelRendering` — задача 3; `readSpec` — `editor-model.ts`; `labelSampleData`, `labelRenderOptions` — `label-samples.ts`.
- Produces: `officeKeys.templateLayout(id: string, rev: number)`; `OfficeQueryOptions.enabled?: boolean`; `useTemplateLayout(template: Pick<LabelTemplateSummary, "id" | "rev">, enabled: boolean)` в `catalog-queries.ts`; `LabelRendering.whenVisible(element: Element, onVisible: () => void): () => void`; `TemplateThumb({ template })`; имя шаблона в строке — `span.template-name__text`.

- [ ] **Step 1: Тесты (падающие)**

1. Создать `apps/standalone/test/template-thumbs.test.tsx`:

<!-- prettier-ignore -->
```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDuplicateLabelTemplate, type LabelTemplateSpec } from "@markiro/domain";

import type { LabelTemplate, LabelTemplateSummary, ProductGroup } from "../src/host/protocol.js";
import { createOfficeQueryClient, officeKeys } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import type { LabelCanvas } from "../src/office/templates/label-renderer.js";
import {
  LabelRenderingProvider,
  type LabelRendering,
} from "../src/office/templates/label-rendering.js";
import { TemplatesPage } from "../src/office/templates/TemplatesPage.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  quietLabelRendering,
  renderOffice,
  type FakeOfficeSession,
} from "./support/office.js";

type Op = (string | number)[];

/** A 2D context that records the filled text and rectangles; a character measures 10 px. */
function recordingCanvas(): LabelCanvas & { ops: Op[] } {
  const ops: Op[] = [];
  return {
    ops,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textBaseline: "alphabetic",
    textAlign: "start",
    clearRect(x, y, w, h) {
      ops.push(["clearRect", x, y, w, h]);
    },
    fillRect() {
      ops.push(["fillRect", String(this.fillStyle)]);
    },
    strokeRect: () => undefined,
    fillText(text) {
      ops.push(["fillText", text]);
    },
    measureText: (text) => ({ width: text.length * 10 }),
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
  };
}

/** Rows come on screen when the test says so. */
function screenRows() {
  const watched = new Map<Element, () => void>();
  const whenVisible = (element: Element, onVisible: () => void) => {
    watched.set(element, onVisible);
    return () => {
      watched.delete(element);
    };
  };
  const show = (name: string) => {
    const row = screen.getByText(name).closest("tr");
    for (const [element, onVisible] of [...watched]) {
      if (row?.contains(element)) act(onVisible);
    }
  };
  return { whenVisible, show };
}

function drawingTools() {
  const canvas = recordingCanvas();
  const rows = screenRows();
  const tools: LabelRendering = {
    ...quietLabelRendering(),
    context: () => canvas,
    whenVisible: rows.whenVisible,
  };
  return { canvas, tools, show: rows.show };
}

const GROUPS: ProductGroup[] = [{ code: 8, alias: "milk", name: "Молочная продукция" }];

const MILK: LabelTemplateSummary = {
  id: "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  name: "Молоко 58×40",
  purpose: "box",
  enabled: true,
  chzProductGroupCodes: null,
  stock: false,
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  rev: 60,
};

const PALLET: LabelTemplateSummary = {
  ...MILK,
  id: "0f4b7e5d-2a6c-4b8d-9e9f-4a5b6c7d8e9f",
  name: "Паллета 100×150",
  purpose: "pallet",
  widthMm: 100,
  heightMm: 150,
};

const MILK_SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { kind: "field", id: "name", xMm: 4, yMm: 4, field: "product.printName", fontSizePt: 10 },
  ],
};

function layoutOf(
  summary: LabelTemplateSummary,
  spec: LabelTemplate["spec"] = MILK_SPEC,
): LabelTemplate {
  return {
    id: summary.id,
    name: summary.name,
    purpose: summary.purpose,
    enabled: summary.enabled,
    chzProductGroupCodes: summary.chzProductGroupCodes,
    stock: summary.stock,
    spec,
    rev: summary.rev,
  };
}

function session(templates: LabelTemplateSummary[] = [MILK, PALLET]): FakeOfficeSession {
  // The administrator: «Профиль», where a test leaves the list for a while, is theirs.
  const fake = fakeOfficeSession();
  fake.api.listTemplates.mockResolvedValue(templates);
  fake.api.listProductGroups.mockResolvedValue(GROUPS);
  fake.api.getOrg.mockResolvedValue(ORG_PROFILE);
  return fake;
}

async function openTemplates(): Promise<void> {
  fireEvent.click(await screen.findByRole("link", { name: "Шаблоны" }));
  await screen.findByRole("heading", { name: "Шаблоны этикеток" });
  await waitFor(() => expect(screen.queryByText("Загрузка…")).toBeNull());
}

function thumbOf(name: string): HTMLElement {
  const thumb = screen.getByText(name).closest("tr")?.querySelector(".template-thumb");
  if (!(thumb instanceof HTMLElement)) throw new Error(`no thumbnail for ${name}`);
  return thumb;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the templates' thumbnails", () => {
  it("reads a row's layout once the row is on screen, and draws it with the purpose's sample", async () => {
    const fake = session();
    fake.api.getTemplate.mockResolvedValue(layoutOf(MILK));
    const { canvas, tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    expect(fake.api.getTemplate).not.toHaveBeenCalled();
    expect(thumbOf("Молоко 58×40").querySelector("canvas")).toBeNull();
    show("Молоко 58×40");
    await waitFor(() => expect(thumbOf("Молоко 58×40").querySelector("canvas")).not.toBeNull());
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(1);
    expect(fake.api.getTemplate).toHaveBeenCalledWith("office-session-token", MILK.id);
    // 58 × 40 mm inside 64 × 48 px: the width fills the box.
    const label = thumbOf("Молоко 58×40").querySelector("canvas");
    expect(label?.getAttribute("width")).toBe("64");
    expect(label?.getAttribute("height")).toBe("44");
    expect(canvas.ops).toContainEqual(["fillText", "Пиво светлое"]);
    expect(thumbOf("Паллета 100×150").querySelector("canvas")).toBeNull();
  });

  it("paints a product duplicate's code as the station's raster", async () => {
    const duplicate: LabelTemplateSummary = {
      ...MILK,
      name: "Дубликат 58×40",
      purpose: "product_duplicate",
    };
    const fake = session([duplicate]);
    fake.api.getTemplate.mockResolvedValue(layoutOf(duplicate, buildDuplicateLabelTemplate()));
    const { canvas, tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show("Дубликат 58×40");
    await waitFor(() =>
      expect(
        canvas.ops.filter((op) => op[0] === "fillRect" && op[1] === "#000000").length,
      ).toBeGreaterThan(50),
    );
  });

  it("keeps a layout by id and revision: the same revision is not read again, a new one is", async () => {
    const fake = session();
    fake.api.getTemplate.mockResolvedValue(layoutOf(MILK));
    const { tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show("Молоко 58×40");
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("link", { name: "Профиль" }));
    await screen.findByLabelText("Название организации");
    await openTemplates();
    // Drawn again from what was read, before the row is even on screen.
    await waitFor(() => expect(thumbOf("Молоко 58×40").querySelector("canvas")).not.toBeNull());
    show("Молоко 58×40");
    expect(fake.api.getTemplate).toHaveBeenCalledTimes(1);
    fake.api.listTemplates.mockResolvedValue([{ ...MILK, rev: 61 }, PALLET]);
    fake.api.getTemplate.mockResolvedValue(layoutOf({ ...MILK, rev: 61 }));
    fireEvent.click(screen.getByRole("link", { name: "Профиль" }));
    await screen.findByLabelText("Название организации");
    await openTemplates();
    expect(thumbOf("Молоко 58×40").querySelector("canvas")).toBeNull();
    show("Молоко 58×40");
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(2));
  });

  it("leaves an empty frame for a layout that does not load or does not read", async () => {
    const fake = session();
    fake.api.getTemplate.mockImplementation(async (_token: string, id: string) => {
      if (id === MILK.id) throw new Error("down");
      return layoutOf(PALLET, { widthMm: 100 });
    });
    const { canvas, tools, show } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    show("Молоко 58×40");
    show("Паллета 100×150");
    await waitFor(() => expect(fake.api.getTemplate).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(thumbOf("Молоко 58×40").querySelector("canvas")).toBeNull();
    expect(thumbOf("Паллета 100×150").querySelector("canvas")).toBeNull();
    expect(canvas.ops).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is a picture beside the name that assistive technology skips", async () => {
    const fake = session();
    const { tools } = drawingTools();
    renderOffice(fake, { labels: tools });
    await openTemplates();
    const thumb = thumbOf("Молоко 58×40");
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
    expect(thumb.parentElement?.classList.contains("template-name")).toBe(true);
    expect(thumb.nextElementSibling?.textContent).toBe("Молоко 58×40");
    const row = screen.getByText("Молоко 58×40").closest("tr");
    if (row === null) throw new Error("no row");
    expect(within(row).queryByRole("img")).toBeNull();
  });

  it("keeps the layouts out of the list's cache, each under its id and revision", async () => {
    const fake = session();
    fake.api.getTemplate.mockResolvedValue(layoutOf(MILK));
    const { tools, show } = drawingTools();
    const queryClient = createOfficeQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <OfficeSessionProvider value={fake}>
          <LabelRenderingProvider value={tools}>
            <MemoryRouter>
              <TemplatesPage />
            </MemoryRouter>
          </LabelRenderingProvider>
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Молоко 58×40");
    show("Молоко 58×40");
    await waitFor(() =>
      expect(queryClient.getQueryData(officeKeys.templateLayout(MILK.id, 60))).toStrictEqual(
        layoutOf(MILK),
      ),
    );
    expect(queryClient.getQueryData(officeKeys.templates)).toStrictEqual([MILK, PALLET]);
  });
});
```

2. В `apps/standalone/test/support/office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
/**
 * Label drawing that stays still in jsdom: no canvas, a rasterizer that
 * refuses as the webview does without one, and a font check that never
 * answers, so no warning arrives after a test has looked.
 */
```

заменить на

<!-- prettier-ignore -->
```tsx
/**
 * Label drawing that stays still in jsdom: no canvas, a rasterizer that
 * refuses as the webview does without one, a font check that never answers,
 * so no warning arrives after a test has looked, and no thumbnail ever on
 * screen, so «Шаблоны» reads no layout.
 */
```

3. В `apps/standalone/test/support/office.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    checkFamilyCoverage: () => new Promise<boolean>(() => undefined),
  };
```

заменить на

<!-- prettier-ignore -->
```tsx
    checkFamilyCoverage: () => new Promise<boolean>(() => undefined),
    whenVisible: () => () => undefined,
  };
```

4. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
/** The names column, top to bottom, without the «Типовой» tag. */
function names(): (string | null | undefined)[] {
  return rows().map(
    (row) => within(row).getAllByRole("cell")[0]?.firstElementChild?.firstElementChild?.textContent,
  );
}
```

заменить на

<!-- prettier-ignore -->
```tsx
/** The names column, top to bottom, without the thumbnail and the «Типовой» tag. */
function names(): (string | null | undefined)[] {
  return rows().map(
    (row) =>
      within(row).getAllByRole("cell")[0]?.querySelector(".template-name__text")?.textContent,
  );
}
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-thumbs.test.tsx test/templates-page.test.tsx`
Expected: FAIL — `Tests  11 failed | 45 passed (56)`; падают: `× reads a row's layout once the row is on screen, and draws it with the purpose's sample`, `× paints a product duplicate's code as the station's raster`, `× keeps a layout by id and revision: the same revision is not read again, a new one is`, `× leaves an empty frame for a layout that does not load or does not read`, `× is a picture beside the name that assistive technology skips`, `× keeps the layouts out of the list's cache, each under its id and revision`, `× lists the templates by name with numbers by value, whatever order the host sends`, `× finds templates by name, without case and spaces around the search`, `× keeps one purpose or one state with the filters, and both together`, `× ignores the spaces on both sides of the search and keeps the ones inside it`, `× keeps what was typed and picked in the search and both filters through a failed reload and its retry`. Последние пять — тесты `templates-page.test.tsx` с помощником `names()`: имени в `span.template-name__text` ещё нет.

- [ ] **Step 3: Кэш макета, наблюдение видимости и миниатюра**

1. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
} as const;
```

заменить на

<!-- prettier-ignore -->
```ts
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
   * A template's layout for its thumbnail on «Шаблоны»: one revision of it,
   * which no write changes (each write gives a new revision).
   */
  templateLayout: (id: string, rev: number) => ["office", "template-layout", id, rev],
} as const;
```

2. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
  staleTime?: number;
}
```

заменить на

<!-- prettier-ignore -->
```ts
  staleTime?: number;
  /** Whether to read at all; `true` by default. A read held back keeps what is cached. */
  enabled?: boolean;
}
```

3. В `apps/standalone/src/office/office-query.ts`, фрагмент

<!-- prettier-ignore -->
```ts
    staleTime: options.staleTime ?? 0,
  });
```

заменить на

<!-- prettier-ignore -->
```ts
    staleTime: options.staleTime ?? 0,
    enabled: options.enabled ?? true,
  });
```

4. В `apps/standalone/src/office/catalog-queries.ts`, фрагмент

<!-- prettier-ignore -->
```ts
import { officeKeys, useOfficeQuery } from "./office-query.js";
```

заменить на

<!-- prettier-ignore -->
```ts
import type { LabelTemplateSummary } from "../host/protocol.js";
import { officeKeys, useOfficeQuery } from "./office-query.js";
```

5. В `apps/standalone/src/office/catalog-queries.ts`, фрагмент

<!-- prettier-ignore -->
```ts
/**
 * The templates' defaults (`GET /v1/office/template-defaults`): one document,
```

заменить на

<!-- prettier-ignore -->
```ts
/**
 * A template with its layout for its thumbnail (`GET /v1/office/templates/{id}`),
 * kept by id and revision and never read again while cached
 * (`staleTime: Infinity`): any write gives a new revision, so the pair never
 * goes stale. Read only once `enabled` (the row is on screen).
 */
export function useTemplateLayout(
  template: Pick<LabelTemplateSummary, "id" | "rev">,
  enabled: boolean,
) {
  return useOfficeQuery(
    officeKeys.templateLayout(template.id, template.rev),
    (api, token) => api.getTemplate(token, template.id),
    { staleTime: Infinity, enabled },
  );
}

/**
 * The templates' defaults (`GET /v1/office/template-defaults`): one document,
```

6. В `apps/standalone/src/office/templates/label-rendering.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * What the office draws labels with: a canvas's 2D context, the text
 * rasterizer and the font coverage check. The webview's own by default; a
 * test passes its own (jsdom has no canvas, and a font file is not fetched
 * there), as the cloud's `LabelEditorPage` takes `rasterizeText` and
 * `checkFamilyCoverage` as props.
```

заменить на

<!-- prettier-ignore -->
```tsx
 * What the office draws labels with: a canvas's 2D context, the text
 * rasterizer, the font coverage check and a way to tell when a thumbnail
 * comes on screen. The webview's own by default; a test passes its own
 * (jsdom has no canvas, and a font file is not fetched there), as the
 * cloud's `LabelEditorPage` takes `rasterizeText` and `checkFamilyCoverage`
 * as props.
```

7. В `apps/standalone/src/office/templates/label-rendering.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  checkFamilyCoverage: (family: LabelFontFamily) => Promise<boolean>;
}
```

заменить на

<!-- prettier-ignore -->
```tsx
  checkFamilyCoverage: (family: LabelFontFamily) => Promise<boolean>;
  /** Calls `onVisible` once the element comes near the screen; returns what stops watching. */
  whenVisible: (element: Element, onVisible: () => void) => () => void;
}

/**
 * Watches with an `IntersectionObserver`, 200 px ahead of the screen; a
 * webview without one shows every thumbnail at once.
 */
function whenVisible(element: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      onVisible();
    },
    { rootMargin: "200px" },
  );
  observer.observe(element);
  return () => observer.disconnect();
}
```

8. В `apps/standalone/src/office/templates/label-rendering.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    return checkFamilyCoverage(family);
  },
};
```

заменить на

<!-- prettier-ignore -->
```tsx
    return checkFamilyCoverage(family);
  },
  whenVisible,
};
```

9. Создать `apps/standalone/src/office/templates/TemplateThumb.tsx`:

<!-- prettier-ignore -->
```tsx
import { useEffect, useMemo, useRef, useState } from "react";

import type { LabelTemplateSummary } from "../../host/protocol.js";
import { useTemplateLayout } from "../catalog-queries.js";
import { readSpec } from "./editor-model.js";
import { drawLabel, paintCodeRasters } from "./label-renderer.js";
import { useLabelRendering } from "./label-rendering.js";
import { labelRenderOptions, labelSampleData } from "./label-samples.js";

/** The box a thumbnail sits in; the label keeps its own proportions inside it. */
const BOX_WIDTH_PX = 64;
const BOX_HEIGHT_PX = 48;

/**
 * A row's thumbnail on «Шаблоны», after the cloud's `TemplateThumb`: the
 * layout is read only once the row comes on screen (`whenVisible`), and kept
 * by id and revision (`useTemplateLayout`), so the list's summaries never
 * hold a layout. It is drawn with the purpose's sample data; until then, and
 * for a layout that does not load or does not read, the box stays empty. It
 * is decorative: the name beside it says what it is, so assistive technology
 * skips it (`aria-hidden`).
 */
export function TemplateThumb({ template }: { template: LabelTemplateSummary }) {
  const { context, whenVisible } = useLabelRendering();
  const frame = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const layout = useTemplateLayout(template, visible);
  const spec = useMemo(
    () => (layout.data === undefined ? null : readSpec(layout.data.spec)),
    [layout.data],
  );
  const scale =
    spec === null ? 0 : Math.min(BOX_WIDTH_PX / spec.widthMm, BOX_HEIGHT_PX / spec.heightMm);

  useEffect(() => {
    const element = frame.current;
    if (element === null || visible) return undefined;
    return whenVisible(element, () => setVisible(true));
  }, [whenVisible, visible]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const drawing = canvas === null || spec === null ? null : context(canvas);
    if (drawing === null || spec === null) return undefined;
    const data = labelSampleData(template.purpose);
    const options = labelRenderOptions(template.purpose);
    drawLabel(spec, drawing, scale, data, options);
    let cancelled = false;
    void paintCodeRasters(spec, drawing, scale, data, options, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [context, spec, scale, template.purpose]);

  return (
    <span ref={frame} className="template-thumb" aria-hidden="true">
      {spec !== null && (
        <canvas
          ref={canvasRef}
          className="template-thumb__label"
          width={Math.round(spec.widthMm * scale)}
          height={Math.round(spec.heightMm * scale)}
        />
      )}
    </span>
  );
}
```

10. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
import { TemplateStateDialog } from "./TemplateStateDialog.js";
```

заменить на

<!-- prettier-ignore -->
```tsx
import { TemplateStateDialog } from "./TemplateStateDialog.js";
import { TemplateThumb } from "./TemplateThumb.js";
```

11. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards with
 * thumbnails (no layout is drawn before plan 1e4b). The host sends the whole
```

заменить на

<!-- prettier-ignore -->
```tsx
 * The label templates (spec §4.3, §5.5): a table, not the cloud's cards, with
 * a thumbnail beside each name (`TemplateThumb`). The host sends the whole
```

12. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        <span className="template-name">
          <span>{template.name}</span>
```

заменить на

<!-- prettier-ignore -->
```tsx
        <span className="template-name">
          <TemplateThumb template={template} />
          <span className="template-name__text">{template.name}</span>
```

13. В `apps/standalone/src/app/shell.css`, фрагмент

<!-- prettier-ignore -->
```css
/* A template's categories: the choice, the search and a list of groups that scrolls. */
```

заменить на

<!-- prettier-ignore -->
```css
/* A template's thumbnail: a fixed box on the panel tone, the label as white stock inside it. */
.template-thumb {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 48px;
  background: var(--surface-panel);
  border-radius: var(--r-1);
}

.template-thumb__label {
  background: var(--paper);
  border: 1px solid var(--line-strong);
}

/* A template's categories: the choice, the search and a list of groups that scrolls. */
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/template-thumbs.test.tsx test/templates-page.test.tsx test/template-editor.test.tsx`
Expected: PASS — 3 файла, 153 теста; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` — PASS; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/TemplateThumb.tsx` читать макет, не дожидаясь экрана: фрагмент

<!-- prettier-ignore -->
```tsx
  const layout = useTemplateLayout(template, visible);
```

заменить на

<!-- prettier-ignore -->
```tsx
  const layout = useTemplateLayout(template, true);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-thumbs.test.tsx -t "once the row is on screen"`
Expected: FAIL — `× reads a row's layout once the row is on screen, and draws it with the purpose's sample`, `AssertionError: expected "vi.fn()" to not be called at all, but actually been called 2 times`.

Мутация 2. В `apps/standalone/src/office/office-query.ts` не учитывать `enabled` в чтении офиса: фрагмент

<!-- prettier-ignore -->
```ts
    enabled: options.enabled ?? true,
```

заменить на

<!-- prettier-ignore -->
```ts
    enabled: true,
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-thumbs.test.tsx -t "once the row is on screen"`
Expected: FAIL — `× reads a row's layout once the row is on screen, and draws it with the purpose's sample`, `AssertionError: expected "vi.fn()" to not be called at all, but actually been called 2 times`.

Мутация 3. В `apps/standalone/src/office/office-query.ts` хранить макет без ревизии: фрагмент

<!-- prettier-ignore -->
```ts
  templateLayout: (id: string, rev: number) => ["office", "template-layout", id, rev],
```

заменить на

<!-- prettier-ignore -->
```ts
  templateLayout: (id: string, _rev: number) => ["office", "template-layout", id],
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-thumbs.test.tsx -t "keeps a layout by id and revision"`
Expected: FAIL — `× keeps a layout by id and revision: the same revision is not read again, a new one is`, `AssertionError: expected <canvas …(3)></canvas> to be null`.

Мутация 4. В `apps/standalone/src/office/catalog-queries.ts` перечитывать макет при каждом показе: фрагмент

<!-- prettier-ignore -->
```ts
    { staleTime: Infinity, enabled },
```

заменить на

<!-- prettier-ignore -->
```ts
    { enabled },
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-thumbs.test.tsx -t "keeps a layout by id and revision"`
Expected: FAIL — `× keeps a layout by id and revision: the same revision is not read again, a new one is`, `AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times`.

Мутация 5. В `apps/standalone/src/office/templates/TemplateThumb.tsx` показать миниатюру скринридеру: фрагмент

<!-- prettier-ignore -->
```tsx
    <span ref={frame} className="template-thumb" aria-hidden="true">
```

заменить на

<!-- prettier-ignore -->
```tsx
    <span ref={frame} className="template-thumb">
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-thumbs.test.tsx -t "assistive technology skips"`
Expected: FAIL — `× is a picture beside the name that assistive technology skips`, `AssertionError: expected null to be 'true' // Object.is equality`.

Мутация 6. В `apps/standalone/src/office/templates/TemplateThumb.tsx` не рисовать растр кода дубликата: удалить фрагмент

<!-- prettier-ignore -->
```tsx
    void paintCodeRasters(spec, drawing, scale, data, options, () => cancelled);
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/template-thumbs.test.tsx -t "paints a product duplicate's code"`
Expected: FAIL — `× paints a product duplicate's code as the station's raster`, `AssertionError: expected 0 to be greater than 50`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/office-query.ts apps/standalone/src/office/catalog-queries.ts apps/standalone/src/office/templates/label-rendering.tsx apps/standalone/src/office/templates/TemplateThumb.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/app/shell.css apps/standalone/test/template-thumbs.test.tsx apps/standalone/test/support/office.tsx apps/standalone/test/templates-page.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 59 файлов, 1331 тест.

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/office-query.ts apps/standalone/src/office/catalog-queries.ts apps/standalone/src/office/templates/label-rendering.tsx apps/standalone/src/office/templates/TemplateThumb.tsx apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/app/shell.css apps/standalone/test/template-thumbs.test.tsx apps/standalone/test/support/office.tsx apps/standalone/test/templates-page.test.tsx
git commit -m "feat(standalone): миниатюры шаблонов в списке «Шаблоны»" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Категории шаблона по названиям и для скринридера (пункт 6 очереди 1e3)

Ячейка «Категории» показывает при нескольких группах только их число («Категорий: 3»), а названия — в подсказке-`title`, которую видит только мышь (пункт 6 очереди 1e3, перенесённый в 1e4b). Теперь, когда ячейка показывает число, она прибавляет названия в `VisuallyHidden` — скринридер читает «Категорий: 3 (Молочная продукция, Упакованная вода, Код 99)»; подсказка остаётся, а одна группа и «Все категории» уже названы в самой ячейке. Клавиатурный путь к названиям для зрячих по-прежнему окно «Категории» (обе роли).

**Files:**

- Modify: `apps/standalone/src/office/templates/TemplatesPage.tsx`, `apps/standalone/src/office/templates/template-text.ts` (комментарий), `apps/standalone/src/i18n/ru.json`
- Test: `apps/standalone/test/templates-page.test.tsx` (Modify)

**Interfaces:**

- Consumes: `describeScope` — `template-text.ts` (без изменений); `VisuallyHidden` — `@markiro/ui`.
- Produces: ключ `office.templates.scope.listed` (« ({{names}})»).

- [ ] **Step 1: Тесты (падающие)**

1. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
      "58,5 × 40 мм",
      "—",
      "Категорий: 3",
      "✕Выключен",
```

заменить на

<!-- prettier-ignore -->
```tsx
      "58,5 × 40 мм",
      "—",
      "Категорий: 3 (Молочная продукция, Упакованная вода, Код 99)",
      "✕Выключен",
```

2. В `apps/standalone/test/templates-page.test.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
    expect(within(rowOf("Коробка 58×40")).getByText("Все категории").hasAttribute("title")).toBe(
      false,
    );
  });
```

заменить на

<!-- prettier-ignore -->
```tsx
    expect(within(rowOf("Коробка 58×40")).getByText("Все категории").hasAttribute("title")).toBe(
      false,
    );
  });

  it("names the counted categories for a screen reader too, not only in the title a mouse shows", async () => {
    await openTemplates(session());
    const hidden = (name: string) =>
      [...rowOf(name).querySelectorAll(".mk-visually-hidden")].map((each) => each.textContent);
    expect(hidden("Вода и молоко")).toEqual([" (Молочная продукция, Упакованная вода, Код 99)"]);
    // One category is named in the cell already; every category needs no list.
    expect(hidden("Молоко 58×40")).toEqual([]);
    expect(hidden("Коробка 58×40")).toEqual([]);
  });
```

- [ ] **Step 2: Запустить тесты — они падают**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx`
Expected: FAIL — `Tests  2 failed | 49 passed (51)`; падают: `× shows the purpose in words, the size, the layout's resolution, the categories and the state in words with its glyph, and tags a stock template`, `× names the counted categories for a screen reader too, not only in the title a mouse shows`.

- [ ] **Step 3: Названия в ячейке**

1. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
  Table,
  type TableColumn,
} from "@markiro/ui";
```

заменить на

<!-- prettier-ignore -->
```tsx
  Table,
  VisuallyHidden,
  type TableColumn,
} from "@markiro/ui";
```

2. В `apps/standalone/src/office/templates/TemplatesPage.tsx`, фрагмент

<!-- prettier-ignore -->
```tsx
        const scope = describeScope(template.chzProductGroupCodes, groups.data, t);
        return <span title={scope.title ?? undefined}>{scope.label}</span>;
```

заменить на

<!-- prettier-ignore -->
```tsx
        const scope = describeScope(template.chzProductGroupCodes, groups.data, t);
        return (
          <>
            <span title={scope.title ?? undefined}>{scope.label}</span>
            {/* A count's names, for whoever cannot hover the title (a screen reader). */}
            {scope.title !== null && scope.title !== scope.label && (
              <VisuallyHidden>
                {t("office.templates.scope.listed", { names: scope.title })}
              </VisuallyHidden>
            )}
          </>
        );
```

3. В `apps/standalone/src/office/templates/template-text.ts`, фрагмент

<!-- prettier-ignore -->
```ts
 * long. `title` carries the names whenever there is a list.
```

заменить на

<!-- prettier-ignore -->
```ts
 * long. `title` carries the names whenever there is a list; «Шаблоны» also
 * puts a count's names in the cell for a screen reader.
```

4. В `apps/standalone/src/i18n/ru.json`, фрагмент

<!-- prettier-ignore -->
```json
        "count": "Категорий: {{n}}"
      },
```

заменить на

<!-- prettier-ignore -->
```json
        "count": "Категорий: {{n}}",
        "listed": " ({{names}})"
      },
```

- [ ] **Step 4: Запустить тесты — они проходят**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/templates-page.test.tsx test/template-text.test.ts`
Expected: PASS — 2 файла, 63 теста; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` — PASS; файлы стенда удалены.

- [ ] **Step 5: Мутации — тесты ловят снятие защит**

Каждая мутация — по правилу «Заметок для исполнения»: копия файла и хеш до правки, возврат копии и тот же хеш после.

Мутация 1. В `apps/standalone/src/office/templates/TemplatesPage.tsx` повторять в ячейке и уже названную группу: фрагмент

<!-- prettier-ignore -->
```tsx
            {scope.title !== null && scope.title !== scope.label && (
```

заменить на

<!-- prettier-ignore -->
```tsx
            {scope.title !== null && (
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/templates-page.test.tsx -t "names the counted categories"`
Expected: FAIL — `× names the counted categories for a screen reader too, not only in the title a mouse shows`, `AssertionError: expected [ ' (Молочная продукция)' ] to deeply equal []`.

- [ ] **Step 6: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/office/templates/template-text.ts apps/standalone/src/i18n/ru.json apps/standalone/test/templates-page.test.tsx`; `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`
Expected: без ошибок.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 59 файлов, 1332 теста.

<!-- prettier-ignore -->
```bash
git add apps/standalone/src/office/templates/TemplatesPage.tsx apps/standalone/src/office/templates/template-text.ts apps/standalone/src/i18n/ru.json apps/standalone/test/templates-page.test.tsx
git commit -m "fix(standalone): категории шаблона по названиям и для скринридера, не только в подсказке" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Документы: предпросмотр, выгрузки кода и миниатюры в `AGENTS.md` и спецификации

Задачи 1–6 меняли только код и тесты; эта задача приводит к ним документы. `AGENTS.md` «Catalog and label templates» говорит, что вторая часть 1e4 рисует макеты, и где живут растеризатор и проверка шрифтов (`src/labels/`, их возьмёт печать станции); «Office pages» — миниатюры и названия категорий для скринридера в пункте «Шаблоны», предпросмотр, `LabelRendering` и выгрузки ZPL и TSPL в пункте о редакторе (и то, что `<a download>` в вебвью Tauri не проверен), без оговорок «до 1e4b». Спецификация §5.5 — то же по-русски. Строка §8 («1e4 (редактор шаблона)») остаётся верной и не меняется.

**Files:**

- Modify: `apps/standalone/AGENTS.md` («Catalog and label templates», «Office pages»), `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)

**Interfaces:**

- Consumes: задачи 1–6.
- Produces: документы; кода не меняет.

- [ ] **Step 1: Документы**

1. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
1e4 added the template editor («Office pages»), which calls `getTemplate`,
`createTemplate`, `updateTemplate` with a layout and `deleteTemplate`, and
checks a layout against `labelTemplateSpecSchema` before it saves. Its first
part draws no layout: the preview, the ZPL and TSPL downloads and the list's
thumbnails come with its second part (1e4b), with the rasterizer and the
`opentype.js` dependency.

## Reference sync
```

заменить на

<!-- prettier-ignore -->
```text
1e4 added the template editor («Office pages»), which calls `getTemplate`,
`createTemplate`, `updateTemplate` with a layout and `deleteTemplate`, and
checks a layout against `labelTemplateSpecSchema` before it saves. Its second
part (1e4b) draws layouts: the editor's preview, the ZPL and TSPL downloads
and the list's thumbnails. The text rasterizer (`src/labels/rasterizer.ts`, a
port of the cloud's that must behave as it does, so a previewed template
prints the same bitmap) and the font coverage check
(`src/labels/font-coverage.ts`, with `opentype.js` 2.0.0 and the hand-written
`opentype.d.ts`) live outside the office: the station's printing (plan 2a) is
to take the rasterizer too.

## Reference sync
```

2. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  the templates are read again whenever a dialog opens.
- «Шаблоны» (section «Каталог») lists every label template, disabled ones
  included, and every role reads it: a table, not the cloud's cards with
  thumbnails (no layout is drawn before 1e4b), by name with numbers by value
  (`templatesByName`). A row shows the purpose as a word on a category tag (the
  cloud's tones: box violet, pallet magenta, product duplicate teal), the size
  («58 × 40 мм») and the layout's resolution («203 dpi») as the summary has
  them, «—» where it has none, the categories (every category, one group's name,
  or «Категорий: N» with the names in a `title`; a code where the lookup lacks
  the group or did not load, and a failed lookup leaves the list in place and
  offers to read it again, but when the templates fail too, only their error
```

заменить на

<!-- prettier-ignore -->
```text
  the templates are read again whenever a dialog opens.
- «Шаблоны» (section «Каталог») lists every label template, disabled ones
  included, and every role reads it: a table, not the cloud's cards, with a
  thumbnail beside each name (below), by name with numbers by value
  (`templatesByName`). A row shows the purpose as a word on a category tag (the
  cloud's tones: box violet, pallet magenta, product duplicate teal), the size
  («58 × 40 мм») and the layout's resolution («203 dpi») as the summary has
  them, «—» where it has none, the categories (every category, one group's name,
  or «Категорий: N» with the names in a `title` and, for a screen reader, in
  the cell (`VisuallyHidden`, « (names)»); a code where the lookup lacks
  the group or did not load, and a failed lookup leaves the list in place and
  offers to read it again, but when the templates fail too, only their error
```

3. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  refused with `not_found` (the template was deleted on another workstation)
  says the template is gone, stays open and reads the list again, which drops
  the row.
- The template editor (plan 1e4; `/templates/new`, `/templates/:id` and
  `/templates/:id/copy`, pages without a menu item of their own, so the
```

заменить на

<!-- prettier-ignore -->
```text
  refused with `not_found` (the template was deleted on another workstation)
  says the template is gone, stays open and reads the list again, which drops
  the row. The thumbnail (`TemplateThumb`, after the cloud's) draws the layout
  with the purpose's sample data in a 64 × 48 px box: it is read with
  `getTemplate` only once its row comes near the screen (`whenVisible`, an
  `IntersectionObserver` 200 px ahead) and kept by id and revision
  (`useTemplateLayout`, `officeKeys.templateLayout`, `staleTime: Infinity`:
  any write gives a new revision), so the list's cache never holds a layout and
  a layout read once is drawn again at once; until then, and for a layout that
  does not load or does not read, the box stays empty. It is decorative
  (`aria-hidden`): the name beside it says what it is.
- The template editor (plan 1e4; `/templates/new`, `/templates/:id` and
  `/templates/:id/copy`, pages without a menu item of their own, so the
```

4. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  (`CategoryScopeField`, with the cloud's warning that the EGAIS field prints
  empty on categories without beer) and a layout, which only an import puts
  on the label. The import dialog takes ZPL or TSPL at a chosen resolution or
  the model's own JSON (`{ name, purpose, spec }` or a bare layout), checks
  it (`analyzeImport`: the domain's parsers, then every element moved inside
```

заменить на

<!-- prettier-ignore -->
```text
  (`CategoryScopeField`, with the cloud's warning that the EGAIS field prints
  empty on categories without beer) and a layout, which only an import puts
  on the label and the preview shows as it prints (`PreviewPane`, after the
  cloud's): drawn at 3 px per millimetre with the purpose's sample data and
  again whenever the layout changes (`drawLabel`), every text the print
  rasterizes (anything but printable ASCII, Cyrillic above all) covered with
  the print's own bitmap, asked of the rasterizer with the options the
  domain's generators give it and painted where the printer puts it
  (`compositeTextRasters`); codes are schematic, except a product duplicate's,
  which is the station's raster. While the layout has such text the editor
  checks that the bundled font has Cyrillic (`checkFamilyCoverage`: opentype.js
  reads the app's own IBM Plex `.woff` files, the Latin and the Cyrillic
  subset, since 2.0.0 cannot read WOFF2; no network) and warns when it lacks it
  or could not be checked. The canvas is an image named by the label's size.
  The office draws through `LabelRendering` (`Office`'s `labels`: a canvas
  context, the rasterizer, the font check and the thumbnails' `whenVisible`),
  the webview's own by default; tests pass `quietLabelRendering` or a
  recording canvas, since jsdom has no canvas (`test/setup.ts` quiets its
  `getContext`) and fetches no font file. The import dialog takes ZPL or TSPL
  at a chosen resolution or
  the model's own JSON (`{ name, purpose, spec }` or a bare layout), checks
  it (`analyzeImport`: the domain's parsers, then every element moved inside
```

5. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  must keep the domain's duplicate rule (`assertDuplicateTemplate`): while it
  does not, «Сохранить» is off (a form submitted another way sends nothing)
  and the editor offers the domain's duplicate 58×40 back. «Скачать JSON»
  saves `{ name, purpose, spec }` through a blob URL and `<a download>` under
  a file name made of the template's name, Cyrillic letters kept; only jsdom
  has run it, not the Tauri webview (WebView2, WKWebView), so a webview that
  refuses the download would need a save-file command of the shell. Nothing
  reaches the host before «Сохранить»: the layout goes as
  `labelTemplateSpecSchema` makes it (`checkedSpec`), the categories as
```

заменить на

<!-- prettier-ignore -->
```text
  must keep the domain's duplicate rule (`assertDuplicateTemplate`): while it
  does not, «Сохранить» is off (a form submitted another way sends nothing)
  and the editor offers the domain's duplicate 58×40 back. «Скачать ZPL»,
  «Скачать TSPL (TSC)» and «Скачать JSON» save through a blob URL and
  `<a download>` under a file name made of the template's name, Cyrillic
  letters kept. A code file is the domain's `generateZpl` or `generateTspl` of
  the layout with the purpose's sample data, its Cyrillic as the print's
  bitmaps, written byte for byte (`latin1Bytes`: a `Blob` of the text would
  write each character from 0x80 up, TSPL's bitmap bytes among them, as two);
  both code downloads are off while a file is being made and while a duplicate
  breaks its rule, and a file whose text cannot be drawn is not saved and says
  so. The JSON is `{ name, purpose, spec }`. Only jsdom has run the downloads,
  not the Tauri webview (WebView2, WKWebView), so a webview that refuses them
  would need a save-file command of the shell. Nothing
  reaches the host before «Сохранить»: the layout goes as
  `labelTemplateSpecSchema` makes it (`checkedSpec`), the categories as
```

6. В `apps/standalone/AGENTS.md`, фрагмент

<!-- prettier-ignore -->
```text
  (`useBlocker`), except right after a save or a delete; the end of the
  session unmounts the office without asking, and closing the window is not
  guarded either (that would be the shell's). The preview, the ZPL and TSPL
  downloads and the thumbnails come with plan 1e4b.
- «Умолчания шаблонов» (section «Каталог») edits the one defaults document
  (`GET/PUT /v1/office/template-defaults`): the page reads it whenever it opens
```

заменить на

<!-- prettier-ignore -->
```text
  (`useBlocker`), except right after a save or a delete; the end of the
  session unmounts the office without asking, and closing the window is not
  guarded either (that would be the shell's).
- «Умолчания шаблонов» (section «Каталог») edits the one defaults document
  (`GET/PUT /v1/office/template-defaults`): the page reads it whenever it opens
```

7. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
- Шаблоны (план 1e3): список видят все роли — все шаблоны, выключенные тоже,
  таблицей по названию с числами по значению, затем по идентификатору, как в каждом
  выборе шаблона (карточек с миниатюрами, как в облаке, нет: макет здесь не рисуется
  до плана 1e4b); в строке — назначение словом, размер и разрешение
  макета из сводки («—», где их нет), категории (все, одна по названию или
  «Категорий: N» с полным списком в подсказке; код, если справочник групп не
  загрузился или кода в нём нет), состояние словом и метка «Типовой». Поиск по
  названию и отбор по назначению и состоянию — в самом экране: хост отдаёт список
```

заменить на

<!-- prettier-ignore -->
```text
- Шаблоны (план 1e3): список видят все роли — все шаблоны, выключенные тоже,
  таблицей по названию с числами по значению, затем по идентификатору, как в каждом
  выборе шаблона (не карточками, как в облаке, а строками с миниатюрой у названия); в
  строке — назначение словом, размер и разрешение макета из сводки («—», где их нет),
  категории (все, одна по названию или «Категорий: N» с полным списком в подсказке и,
  для скринридера, в самой ячейке; код, если справочник групп не
  загрузился или кода в нём нет), состояние словом и метка «Типовой». Поиск по
  названию и отбор по назначению и состоянию — в самом экране: хост отдаёт список
```

8. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  типового шаблона, «Копировать». Окно, которому хост ответил `not_found` (шаблон
  удалили на другом рабочем месте), говорит об этом, остаётся открытым и перечитывает
  список.
- Редактор шаблона (план 1e4): страницы нового шаблона, правки и копии без своего
  пункта меню (пункт «Шаблоны» на них подсвечен, «Умолчания шаблонов» — нет);
```

заменить на

<!-- prettier-ignore -->
```text
  типового шаблона, «Копировать». Окно, которому хост ответил `not_found` (шаблон
  удалили на другом рабочем месте), говорит об этом, остаётся открытым и перечитывает
  список. Миниатюра (план 1e4b) рисует макет с образцом назначения; макет читается,
  только когда строка подходит к экрану, и хранится по паре «идентификатор, ревизия»
  (любая запись даёт новую ревизию), поэтому сводки списка макетов не держат; пока
  макет не прочитан, не загрузился или не читается, рамка пуста. Миниатюра
  декоративна: что это за шаблон, говорит название рядом.
- Редактор шаблона (план 1e4): страницы нового шаблона, правки и копии без своего
  пункта меню (пункт «Шаблоны» на них подсвечен, «Умолчания шаблонов» — нет);
```

9. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  роли. Название (обрезанное, 1–200 символов), назначение, признак «Включён»,
  категории на `CategoryScopeField` с подсказкой облака про поле ЕГАИС и макет,
  который на этикетку кладёт только импорт: ZPL или TSPL в выбранном разрешении или
  JSON модели, проверка разборщиками домена и подгонка элементов в пределы этикетки,
  список отброшенного с подтверждением; имя из JSON получает шаблон без имени;
```

заменить на

<!-- prettier-ignore -->
```text
  роли. Название (обрезанное, 1–200 символов), назначение, признак «Включён»,
  категории на `CategoryScopeField` с подсказкой облака про поле ЕГАИС и макет,
  который на этикетку кладёт только импорт, а предпросмотр (план 1e4b) показывает
  таким, каким он печатается: с образцом назначения, заново при каждом изменении
  макета, русский текст — тем же растром, что уйдёт на принтер, и там же, где его
  поставит принтер, коды — схемой, кроме кода дубликата (растр станции). Пока в макете
  есть такой текст, редактор проверяет, что во вложенном шрифте IBM Plex есть кириллица
  (opentype.js читает файлы `.woff` самого приложения, без сети), и предупреждает, если
  её нет или проверить не удалось. Импорт: ZPL или TSPL в выбранном разрешении или
  JSON модели, проверка разборщиками домена и подгонка элементов в пределы этикетки,
  список отброшенного с подтверждением; имя из JSON получает шаблон без имени;
```

10. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  ввода, поэтому на заготовке его выбор ничего не меняет. Дубликат держит правило
  домена, иначе «Сохранить» выключена (форма, отправленная иначе, ничего не шлёт) и
  предлагается макет дубликата 58 × 40. «Скачать JSON» отдаёт
  `{ name, purpose, spec }` с именем файла из названия (кириллица остаётся); выгрузку
  проверял только jsdom, в вебвью Tauri (WebView2, WKWebView) она не запускалась, и
  если вебвью её не пропустит, понадобится сохранение файла вызовом оболочки. До
  «Сохранить» на хост ничего не уходит; макет проверяется `labelTemplateSpecSchema` и
  уходит в его разборе. Новый шаблон и копия («<название> — копия») создаются; шаблон
```

заменить на

<!-- prettier-ignore -->
```text
  ввода, поэтому на заготовке его выбор ничего не меняет. Дубликат держит правило
  домена, иначе «Сохранить» выключена (форма, отправленная иначе, ничего не шлёт) и
  предлагается макет дубликата 58 × 40. «Скачать ZPL», «Скачать TSPL (TSC)» и «Скачать
  JSON» сохраняют файл с именем из названия (кириллица остаётся): ZPL и TSPL — документ
  домена (`generateZpl`, `generateTspl`) с образцом назначения и русским текстом растром,
  байт в байт; пока файл собирается или дубликат нарушает правило, выгрузки кода
  выключены, а файл, текст которого не удалось нарисовать, не сохраняется, и редактор
  говорит об этом; JSON — `{ name, purpose, spec }`. Выгрузки проверял только jsdom, в
  вебвью Tauri (WebView2, WKWebView) они не запускались, и если вебвью их не пропустит,
  понадобится сохранение файла вызовом оболочки. До
  «Сохранить» на хост ничего не уходит; макет проверяется `labelTemplateSpecSchema` и
  уходит в его разборе. Новый шаблон и копия («<название> — копия») создаются; шаблон
```

11. В `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`, фрагмент

<!-- prettier-ignore -->
```text
  пользовался); уход со страницы с несохранёнными правками спрашивает подтверждение, а
  закрытие окна, как и конец сеанса, не спрашивает (это было бы делом оболочки).
  Предпросмотр, выгрузки ZPL и TSPL и миниатюры в списке — вторая часть плана (1e4b)
  вместе с растеризатором, покрытием шрифтов и зависимостью `opentype.js`.
- Умолчания шаблонов (план 1e3): один документ
  (`GET/PUT /v1/office/template-defaults`), его видят и меняют обе роли. Умолчание
```

заменить на

<!-- prettier-ignore -->
```text
  пользовался); уход со страницы с несохранёнными правками спрашивает подтверждение, а
  закрытие окна, как и конец сеанса, не спрашивает (это было бы делом оболочки).
  Растеризатор текста и проверка покрытия шрифтов (зависимость `opentype.js`) лежат
  вне офиса, в `src/labels/`: растеризатор возьмёт и печать станции (план 2a).
- Умолчания шаблонов (план 1e3): один документ
  (`GET/PUT /v1/office/template-defaults`), его видят и меняют обе роли. Умолчание
```

- [ ] **Step 2: Перечитать**

Перечитать в `AGENTS.md` «Catalog and label templates» и в «Office pages» пункты «Шаблоны» и о редакторе, в спецификации — §5.5 целиком: нигде не осталось «до 1e4b», «come with plan 1e4b» или «no layout is drawn»; предпросмотр, выгрузки ZPL и TSPL, миниатюры, `src/labels/` и непроверенная выгрузка в вебвью названы.

- [ ] **Step 3: Проверки и коммит**

Run: `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check`; `grep -rn '1e4b' apps/standalone/src apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
Expected: чисто; `grep` находит три строки, каждая называет 1e4b сделанной частью: `AGENTS.md` («Its second part (1e4b) draws layouts») и две в спецификации («Миниатюра (план 1e4b)», «предпросмотр (план 1e4b)»).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 59 файлов, 1332 теста (без изменений).

<!-- prettier-ignore -->
```bash
git add apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "docs(standalone): план 1e4b — предпросмотр, выгрузки кода и миниатюры в документах" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Итоговая проверка плана

- [ ] **Step 1: Вебвью**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`
Expected: PASS — 59 файлов, 1332 теста (до плана 54 и 1295).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose test/label-raster.test.ts test/label-renderer.test.ts test/template-preview.test.tsx test/template-code-downloads.test.tsx test/template-thumbs.test.tsx test/templates-page.test.tsx test/template-editor.test.tsx test/office.test.tsx test/template-text.test.ts`
Expected: PASS — 9 файлов, 221 тест; stderr пуст. Затем те же файлы под стендом с задержкой `setImmediate` (см. «Заметки для исполнения») — PASS; файлы стенда удалены.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`; `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`
Expected: без ошибок; у `typecheck` и `lint` нет предупреждений, у `build` — только прежнее предупреждение Vite о чанках больше 500 kB. Главный чанк `index-*.js` вырос с 864,49 до 875,82 kB; новые чанки — `label-print-*.js` (7,16 kB), `font-coverage-*.js` (opentype.js, 237,41 kB) и `bwip-js-gen-*.js` (925,37 kB: кодировщик, который раньше жил в чанке `PairingDataMatrix-*.js`, теперь общий у окна сопряжения и печати). Файлы `.woff`, которые читает проверка шрифта, — те же ассеты, что у `@font-face`: в `dist/assets` по одному `ibm-plex-sans-cyrillic-400-normal-*.woff` и `ibm-plex-sans-latin-400-normal-*.woff`.

Run: `ls apps/standalone/dist/assets | grep -c 'ibm-plex-sans-cyrillic-400-normal-.*\.woff$'`
Expected: `1`.

- [ ] **Step 2: Cargo**

Rust план не меняет (шаг 3 это проверяет), поэтому наборы Cargo не перезапускаются: 41 набор, 453 теста. Оболочка встраивает сборку вебвью из шага 1 (`apps/standalone/dist`), поэтому проверка сборки идёт после неё.

Run: `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`; `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`
Expected: чисто, без предупреждений (на копии репозитория `cargo check` прошёл за 53 с).

- [ ] **Step 3: Чистота**

Run: `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`; `git diff --check 564cec314`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`
Expected: чисто; `grep` находит только `src/host/pairing-code.ts:66`.

Run: `git diff --stat 564cec314 -- apps/station packages apps/standalone/host apps/standalone/proto apps/standalone/src-tauri pnpm-lock.yaml apps/standalone/package.json`
Expected: пусто (D5, D8).

- [ ] **Step 4: Что не проверить в песочнице и без Windows**

Записать в отчёт, что не проверено (а не «проверено»):

- настоящее рисование: canvas в jsdom нет, поэтому тесты проверяют вызовы записывающего контекста (`LabelCanvas`), а не пиксели; вид предпросмотра и миниатюр, чёткость растра при 3 px/мм (точка 0,375 px при 203 dpi) и границы этикетки на экране — только глазами в вебвью;
- растеризатор в вебвью Tauri: загрузку IBM Plex через `document.fonts.load` с кириллицей и совпадение растра предпросмотра с напечатанным на Zebra и TSC; в тестах растеризатор подменён;
- проверка шрифта в вебвью: `fetch` ассета `.woff` по протоколу оболочки (`tauri://localhost` или `http://tauri.localhost`) и динамическая загрузка чанков `label-print`, `font-coverage` и `bwip-js-gen` оттуда же; в тестах — чтение тех же файлов с диска;
- `IntersectionObserver` в WebView2 и WKWebView (ленивые миниатюры); в тестах видимость подменена;
- выгрузки ZPL, TSPL и JSON через `<a download>` в WebView2 и WKWebView: в jsdom проверено, что blob создан с нужными байтами и типом, ссылка нажата и URL отозван. Если вебвью файл не сохранит, нужна команда оболочки с диалогом сохранения, через которую пойдут все три выгрузки, — изменение `src-tauri` и решение владельца;
- печать выгруженного файла на настоящих Zebra и TSC.

---

## Перенесено

- Выгрузки через команду оболочки, если `<a download>` не работает в WebView2 или WKWebView: команда `src-tauri` с диалогом сохранения и записью байтов (`Uint8Array` → `Vec<u8>`), `downloadFile` вызывает её вместо ссылки, тесты подменяют `invoke`; изменение оболочки и её прав — решение владельца. Проверить вживую на Windows раньше, чем на них опереться.
- Перенос `fitSpecElements` и образцов назначения в `@markiro/domain` (решение владельца из плана 1e4) — теперь у образцов три потребителя в приложении (подгонка, предпросмотр, миниатюры); рисование (`label-renderer.ts`) остаётся в приложении: canvas — не дело домена.
- Растеризатор существует в трёх одинаковых копиях (`apps/admin`, `apps/station`, `apps/standalone/src/labels`): общий пакет с DOM-зависимостью — вопрос владельцу; пока копии сверяет комментарий «must behave as they do».
- Проверка покрытия смотрит только начертание 400 (как облако); загрузка своего шрифта — вне MVP.
- Возврат к редактору после сохранения вместо списка (вопрос 3 итогового ревью 1e4): с предпросмотром правка макета стала частой; по-прежнему решение владельца.
- Перевод сообщений разборщиков кода и «Строка N», фокус после неудачного «Применить», общая нормализация поиска, две «Повторить» на странице умолчаний, объявление ошибок полей на уровне `FormDialog` — план полировки, как в плане 1e4.
- Длинное название источника плюс « — копия», кнопка засева типовых шаблонов, закрытие окна с несохранёнными правками, случаи дубликата с категориями в `proto/fixtures/template-eligibility.json`, комментарий-пример в `src-tauri/tests/local_db.rs` — без изменений с плана 1e4.
- План 2a (смена и печать на станции) берёт растеризатор `src/labels/rasterizer.ts` и чанк печати; план 5 (политика версий протокола) — без изменений.

## Отклонения при исполнении
