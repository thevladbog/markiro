# Печатные инструкции оператора (MKR-INS-01) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Первая печатная инструкция оператора — MKR-INS-01 «Станция сканирования: вход оператора и старт смены» — как новый вид документа в конвейере `packages/legal-documents`: RU-страница на лендинге со скриншотами шагов + неизменяемый PDF/A-артефакт.

**Architecture:** Расширяем существующий пакет `@markiro/legal-documents` категорией документа `instruction` (RU-only локали, блоки `step`/`callout`), скриншоты снимаются из dev-галереи станции и живут в `packages/legal-documents/assets/instructions/mkr-ins-01/` как единый источник для DOCX и лендинга. DOCX-рендерер получает встраивание PNG через `ImageRun` из библиотеки `docx`; дальше без изменений: LibreOffice → PDF/A-2b → veraPDF → канонический манифест.

**Tech Stack:** TypeScript (ESM, `.js`-суффиксы у импортов), `docx@9.7.1`, `fflate`, Astro (лендинг), Vitest, LibreOffice 26.2.5 + veraPDF 1.30.2 (docker) для артефактов, Playwright MCP для скриншотов.

**Спека:** `docs/superpowers/specs/2026-08-21-operator-instructions-design.md`.

**Отклонение от спеки (утверждённое здесь):** новый вид артефакта `instruction-pdf` НЕ вводится. Инструкционный PDF — это тот же `legal-pdf` / `pdfa-2b` (он и есть PDF/A-2b); различие только в лимите размера, который берётся по категории кода (`maxLegalPdfBytes(code)`). Это убирает изменения схемы манифеста в трёх местах и UI. Task 8 синхронизирует спеку.

## Global Constraints

- Код документа: `MKR-INS-01`, ревизия `2026.08/01`, effectiveDate `2026-08-21`, статус `active`.
- Маршрут RU-страницы: `/instruktsii/stantsiya-vkhod-i-start-smeny/`. EN-маршрута и EN-контента НЕТ.
- Имя артефакта: `markiro_mkr-ins-01_2026.08-01_ru.pdf` (существующая схема имён).
- Лимит PDF для инструкций: 12 MiB (`MAX_INSTRUCTION_PDF_BYTES`); для остальных — прежние 5 MiB.
- Версии генераторов не меняются: docx `9.7.1`, LibreOffice `26.2.5`, veraPDF `1.30.2`.
- Все импорты внутри пакета — с суффиксом `.js` (ESM). Комментарии в коде — по-английски, в стиле окружения.
- НЕ запускать `prettier --write .` (только затронутые файлы); НЕ форматировать prettier'ом этот план.
- В свежем worktree перед тестами: `pnpm install`; для тестов станции/лендинга может понадобиться `pnpm --filter @markiro/domain build`, `pnpm --filter @markiro/ui build`, `pnpm --filter @markiro/db build`.
- Фильтрация vitest по файлу: `pnpm --filter <pkg> exec vitest run <path>` (НЕ `test -- <path>`).
- Коммиты: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` в конце сообщения.

---

### Task 1: Типы, категория документа и RU-only валидация реестра

**Files:**
- Modify: `packages/legal-documents/src/types.ts`
- Modify: `packages/legal-documents/src/registry.ts`
- Modify: `packages/legal-documents/src/index.ts`
- Test: `packages/legal-documents/test/registry.test.ts`

**Interfaces:**
- Consumes: существующие `LegalIdentity`, `parseLegalRevision`.
- Produces (используется всеми последующими задачами):
  - `type LegalDocumentCode` — добавлен `"MKR-INS-01"`.
  - `type LegalDocumentKind = "legal" | "template" | "instruction"`.
  - `LegalBlock` — добавлены варианты `step` и `callout` (сигнатуры ниже).
  - `LegalDocumentSource.content: { ru: LegalDocumentLocaleContent; en?: LegalDocumentLocaleContent }`.
  - `LegalDocumentRelease.routes: { ru: \`/${string}/\`; en?: \`/en/${string}/\` }`.
  - `legalDocumentKind(code): LegalDocumentKind`
  - `legalReleaseLocales(code): readonly LegalLocale[]` — `["ru"]` для instruction, иначе `["ru","en"]`.
  - `requireLegalContent(source, locale): LegalDocumentLocaleContent` — бросает, если локали нет.

- [ ] **Step 1: Написать падающий тест валидации RU-only**

Добавить в конец `packages/legal-documents/test/registry.test.ts` (внутри `describe("legal document registry", ...)`):

```ts
  it("classifies document kinds and release locales", async () => {
    const { legalDocumentKind, legalReleaseLocales } = await import("../src/index.js");
    expect(legalDocumentKind("MKR-PD-01")).toBe("legal");
    expect(legalDocumentKind("MKR-DPA-01")).toBe("template");
    expect(legalDocumentKind("MKR-INS-01")).toBe("instruction");
    expect(legalReleaseLocales("MKR-BRD-01")).toEqual(["ru", "en"]);
    expect(legalReleaseLocales("MKR-INS-01")).toEqual(["ru"]);
  });

  it("accepts a Russian-only instruction release and rejects Russian-only legal releases", () => {
    const instructionRelease = {
      code: "MKR-INS-01",
      revision: "2026.08/01",
      effectiveDate: "2026-08-21",
      status: "draft",
      operatorProfileId: "operator-2026-08-15",
      routes: { ru: "/instruktsii/stantsiya-vkhod-i-start-smeny/" },
    } as unknown as LegalDocumentRelease;
    expect(() => validateLegalRegistry([...cloneReleases(), instructionRelease])).not.toThrow();

    const ruOnlyLegal = cloneReleases();
    delete (ruOnlyLegal[0] as { routes: { en?: string } }).routes.en;
    expect(() => validateLegalRegistry(ruOnlyLegal)).toThrow(/must define routes exactly for/);

    const instructionWithEn = {
      ...instructionRelease,
      routes: {
        ru: "/instruktsii/stantsiya-vkhod-i-start-smeny/",
        en: "/en/instructions/station-shift-start/",
      },
    } as unknown as LegalDocumentRelease;
    expect(() => validateLegalRegistry([...cloneReleases(), instructionWithEn])).toThrow(
      /must define routes exactly for/,
    );
  });
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/registry.test.ts`
Expected: FAIL — `legalDocumentKind` не экспортируется / `MKR-INS-01` не является валидным кодом.

- [ ] **Step 3: Обновить `types.ts`**

Заменить в `packages/legal-documents/src/types.ts`:

```ts
export type LegalDocumentCode =
  | "MKR-PD-01"
  | "MKR-PD-02"
  | "MKR-DPA-01"
  | "MKR-BRD-01"
  | "MKR-INS-01";

export type LegalDocumentKind = "legal" | "template" | "instruction";
```

`LegalBlock` заменить на:

```ts
export type LegalBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "ordered-list" | "unordered-list"; readonly items: readonly string[] }
  | {
      readonly kind: "definition-list";
      readonly items: readonly { readonly term: string; readonly detail: string }[];
    }
  | {
      readonly kind: "step";
      readonly title: string;
      readonly text: string;
      readonly image?: { readonly id: string; readonly caption: string };
      readonly expected?: string;
    }
  | { readonly kind: "callout"; readonly tone: "info" | "warning"; readonly text: string };
```

`LegalDocumentRelease.routes` и `LegalDocumentSource.content` заменить на:

```ts
  readonly routes: { readonly ru: `/${string}/`; readonly en?: `/en/${string}/` };
```

```ts
export interface LegalDocumentSource {
  readonly releaseKey: `${LegalDocumentCode}/${LegalRevision}`;
  readonly content: {
    readonly ru: LegalDocumentLocaleContent;
    readonly en?: LegalDocumentLocaleContent;
  };
}
```

- [ ] **Step 4: Обновить `registry.ts`**

После `LEGAL_DOCUMENT_STATUSES` добавить:

```ts
export const LEGAL_DOCUMENT_KIND_BY_CODE = {
  "MKR-PD-01": "legal",
  "MKR-PD-02": "legal",
  "MKR-DPA-01": "template",
  "MKR-BRD-01": "template",
  "MKR-INS-01": "instruction",
} as const satisfies Record<LegalDocumentCode, LegalDocumentKind>;

export function legalDocumentKind(code: LegalDocumentCode): LegalDocumentKind {
  return LEGAL_DOCUMENT_KIND_BY_CODE[code];
}

export function legalReleaseLocales(code: LegalDocumentCode): readonly LegalLocale[] {
  return legalDocumentKind(code) === "instruction" ? ["ru"] : ["ru", "en"];
}

export function requireLegalContent(
  source: LegalDocumentSource,
  locale: LegalLocale,
): LegalDocumentLocaleContent {
  const content = source.content[locale];
  if (!content) throw new Error(`Legal document has no ${locale} content: ${source.releaseKey}`);
  return content;
}
```

Импорты типов дополнить `LegalDocumentKind`, `LegalDocumentLocaleContent`. В `LEGAL_DOCUMENT_CODES` добавить `"MKR-INS-01"`.

`assertLocaleRoutes` заменить на (учитывает kind):

```ts
function assertLocaleRoutes(
  code: LegalDocumentCode,
  routes: LegalDocumentRelease["routes"],
): void {
  const expectedLocales = legalReleaseLocales(code);
  const entries = Object.entries(routes) as [LegalLocale, string][];
  if (
    entries.length !== expectedLocales.length ||
    expectedLocales.some((locale) => !(locale in routes))
  ) {
    throw new Error(
      `Legal release ${code} must define routes exactly for: ${expectedLocales.join(", ")}`,
    );
  }

  for (const [locale, route] of entries) {
    if (!route.startsWith("/") || !route.endsWith("/") || route.includes("://")) {
      throw new Error(`Invalid external legal route: ${route}`);
    }
    if (locale === "en" && !route.startsWith("/en/")) {
      throw new Error(`English route must start with /en/: ${route}`);
    }
    if (locale === "ru" && route.startsWith("/en/")) {
      throw new Error(`Russian route must not start with /en/: ${route}`);
    }
  }
}
```

Единственный вызов внутри `validateLegalRegistry` поменять на `assertLocaleRoutes(release.code, release.routes);`.

- [ ] **Step 5: Экспортировать новое из `index.ts`**

В блок реэкспортов из `./registry.js` добавить `LEGAL_DOCUMENT_KIND_BY_CODE, legalDocumentKind, legalReleaseLocales, requireLegalContent`; в блок типов из `./types.js` добавить `LegalDocumentKind`.

- [ ] **Step 6: Прогнать тесты пакета**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/registry.test.ts`
Expected: PASS. Затем `pnpm --filter @markiro/legal-documents typecheck` — если `content[locale]`/`routes[locale]` где-то дают ошибки типов в других файлах пакета, НЕ чинить здесь: это зона задач 4–5 (допустимо временно оставить typecheck красным до Task 5; но `vitest run test/registry.test.ts` обязан быть зелёным).

- [ ] **Step 7: Commit**

```bash
git add packages/legal-documents/src/types.ts packages/legal-documents/src/registry.ts packages/legal-documents/src/index.ts packages/legal-documents/test/registry.test.ts
git commit -m "feat(legal-documents): instruction document kind with RU-only locales"
```

---

### Task 2: Скриншоты из dev-галереи станции

**Files:**
- Create: `packages/legal-documents/assets/instructions/mkr-ins-01/login-badge.png`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-01/login-pin.png`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-01/login-name-search.png`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-01/shift-select.png`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-01/new-shift.png`
- Create: `packages/legal-documents/assets/instructions/mkr-ins-01/work-start.png`

**Interfaces:**
- Produces: шесть PNG-файлов; идентификатор изображения = имя файла без `.png`. На эти id ссылается контент в Task 3 и тест синхронизации ассетов.

**Контекст:** dev-галерея станции рендерит фикстурные экраны по URL `http://localhost:5273/?gallery=1&state=<id>&locale=ru` (см. `apps/station/src/dev/gallery-fixtures.ts`, `resolveGalleryRequest`). Галерея работает только в dev-режиме vite. В `.claude/launch.json` уже есть конфигурация `station` (порт 5273).

Соответствие файлов состояниям галереи:

| Файл | `state=` |
| --- | --- |
| login-badge.png | `login-badge` |
| login-pin.png | `login-pin` |
| login-name-search.png | `login-name-search` |
| shift-select.png | `shift-page-1` |
| new-shift.png | `new-shift-input` |
| work-start.png | `work-validation` |

- [ ] **Step 1: Создать каталог ассетов**

```bash
mkdir -p packages/legal-documents/assets/instructions/mkr-ins-01
```

- [ ] **Step 2: Запустить dev-сервер станции**

Запустить preview-сервер `station` (Claude Browser `preview_start` c `name: "station"`, либо Playwright MCP + вручную `pnpm --filter @markiro/station dev` в фоне). Дождаться готовности vite на `http://localhost:5273`.

- [ ] **Step 3: Снять шесть скриншотов**

Через Playwright MCP (`browser_resize` → `browser_navigate` → `browser_take_screenshot`) для каждой строки таблицы выше:

1. `browser_resize` до 1280×800.
2. `browser_navigate` на `http://localhost:5273/?gallery=1&state=<id>&locale=ru`.
3. Подождать полной отрисовки (`browser_wait_for` 1s или до появления текста экрана).
4. `browser_take_screenshot` c `type: "png"`, `fullPage: false`, `filename: "<имя>.png"`.
5. Скопировать сохранённый файл из каталога вывода Playwright MCP (путь возвращается в ответе инструмента) в `packages/legal-documents/assets/instructions/mkr-ins-01/<имя>.png`.

Если Playwright MCP недоступен — снять через Claude Browser (`resize_window` 1280×800, `navigate`, `computer {action: "screenshot"}`) нельзя сохранить в файл; тогда fallback: `pnpm dlx playwright@1.57.0 screenshot --viewport-size=1280,800 "http://localhost:5273/?gallery=1&state=<id>&locale=ru" packages/legal-documents/assets/instructions/mkr-ins-01/<имя>.png` (шесть вызовов).

- [ ] **Step 4: Проверить результат**

Run: `file packages/legal-documents/assets/instructions/mkr-ins-01/*.png && ls -la packages/legal-documents/assets/instructions/mkr-ins-01/`
Expected: шесть файлов `PNG image data, 1280 x 800` (допустим 2560×1600 при retina — тогда пересжать: `sips -Z 1280 <file>`), каждый < 600 KB. Визуально открыть каждый (Read) и убедиться: это нужный экран, без пустых/loading-состояний.

- [ ] **Step 5: Остановить dev-сервер и закоммитить**

```bash
git add packages/legal-documents/assets/instructions/mkr-ins-01
git commit -m "feat(legal-documents): MKR-INS-01 step screenshots from station gallery"
```

---

### Task 3: Контент MKR-INS-01 и релиз в реестре

**Files:**
- Create: `packages/legal-documents/src/documents/station-operator-shift.ts`
- Modify: `packages/legal-documents/src/registry.ts`
- Modify: `packages/legal-documents/test/registry.test.ts` (обновить pinned-список кодов)
- Modify: `packages/legal-documents/test/content-contract.test.ts`
- Test: `packages/legal-documents/test/instruction-assets.test.ts` (новый)

**Interfaces:**
- Consumes: типы из Task 1; PNG-ассеты из Task 2.
- Produces: `STATION_OPERATOR_SHIFT_CONTENT: LegalDocumentSource["content"]`; релиз `MKR-INS-01/2026.08/01` в `LEGAL_RELEASES`; источник в `LEGAL_DOCUMENTS` c `releaseKey: "MKR-INS-01/2026.08/01"`.

- [ ] **Step 1: Написать падающий тест синхронизации ассетов**

Создать `packages/legal-documents/test/instruction-assets.test.ts`:

```ts
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LEGAL_RELEASES,
  findLegalDocument,
  legalDocumentKind,
  requireLegalContent,
} from "../src/index.js";

const ASSETS_ROOT = fileURLToPath(new URL("../assets/instructions/", import.meta.url));

const instructionReleases = LEGAL_RELEASES.filter(
  ({ code, status }) => legalDocumentKind(code) === "instruction" && status === "active",
);

describe("instruction assets", () => {
  it("covers at least the first instruction", () => {
    expect(instructionReleases.map(({ code }) => code)).toContain("MKR-INS-01");
  });

  it.each(instructionReleases.map(({ code }) => code))(
    "keeps %s content image ids and asset files in sync",
    (code) => {
      const content = requireLegalContent(findLegalDocument(code), "ru");
      const referenced = content.sections
        .flatMap(({ blocks }) => blocks)
        .flatMap((block) => (block.kind === "step" && block.image ? [block.image.id] : []));
      expect(referenced.length).toBeGreaterThan(0);
      expect(new Set(referenced).size).toBe(referenced.length);

      const files = readdirSync(path.join(ASSETS_ROOT, code.toLowerCase()))
        .filter((name) => name.endsWith(".png"))
        .map((name) => name.slice(0, -".png".length));
      expect([...referenced].sort()).toEqual([...files].sort());
    },
  );
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/instruction-assets.test.ts`
Expected: FAIL — `MKR-INS-01` отсутствует в `LEGAL_RELEASES`.

- [ ] **Step 3: Написать контент**

Создать `packages/legal-documents/src/documents/station-operator-shift.ts`:

```ts
import type { LegalDocumentSource } from "../types.js";

export const STATION_OPERATOR_SHIFT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: вход оператора и старт смены",
    summary:
      "Пошаговая инструкция оператора: вход на станцию по бейджу, выбор или создание смены и начало работы.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает ежедневный вход оператора на станцию сканирования Маркиро и старт смены: от считывания бейджа до готового к работе экрана. Инструкция предназначена для операторов линии; настройка оборудования и привязка станции описаны в отдельных документах.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия продуктов, номера смен и имена на вашей станции будут отличаться.",
          },
        ],
      },
      {
        id: "preparation",
        heading: "2. Подготовка к работе",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "Станция включена, приложение станции запущено.",
              "Сканер и принтер этикеток подключены: в строке состояния нет значков ошибок оборудования.",
              "У вас есть личный бейдж оператора и PIN-код.",
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если станция показывает экран привязки (код сопряжения) или ошибку подключения — не продолжайте работу, позовите наладчика или администратора.",
          },
        ],
      },
      {
        id: "login",
        heading: "3. Вход по бейджу",
        blocks: [
          {
            kind: "step",
            title: "Поднесите бейдж к сканеру",
            text: "На экране входа поднесите личный бейдж к сканеру штрихкодов. Держите бейдж в 10–20 см от сканера до звукового сигнала.",
            image: { id: "login-badge", caption: "Экран входа: станция ожидает бейдж оператора" },
            expected: "Станция распознала бейдж и показала ваше имя.",
          },
          {
            kind: "step",
            title: "Введите PIN-код",
            text: "Наберите личный PIN-код на экранной клавиатуре и подтвердите ввод.",
            image: { id: "login-pin", caption: "Ввод PIN-кода оператора" },
            expected: "Открылся экран выбора смены.",
          },
          {
            kind: "step",
            title: "Если бейдж не читается — найдите себя по имени",
            text: "Нажмите «Найти по имени», начните вводить фамилию и выберите себя в списке, затем введите PIN-код. После смены сообщите о неисправном бейдже администратору.",
            image: { id: "login-name-search", caption: "Поиск оператора по имени" },
          },
        ],
      },
      {
        id: "shift-select",
        heading: "4. Выбор существующей смены",
        blocks: [
          {
            kind: "paragraph",
            text: "Если смена уже создана (например, вы возвращаетесь после перерыва или смену подготовил мастер), выберите её из списка.",
          },
          {
            kind: "step",
            title: "Выберите смену из списка",
            text: "На экране выбора смены найдите нужную смену по номеру, продукту и дате производства и нажмите на её карточку. Открытые смены отображаются первыми.",
            image: { id: "shift-select", caption: "Список смен: карточки с номером, продуктом и датой" },
            expected: "Открылся рабочий экран выбранной смены.",
          },
        ],
      },
      {
        id: "new-shift",
        heading: "5. Создание новой смены",
        blocks: [
          {
            kind: "step",
            title: "Создайте новую смену",
            text: "Если нужной смены нет в списке, нажмите «Новая смена». Отсканируйте код продукта с упаковки или выберите продукт вручную, проверьте дату производства и подтвердите создание.",
            image: { id: "new-shift", caption: "Создание смены: выбор продукта и даты производства" },
            expected: "Станция создала смену и открыла рабочий экран.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Проверьте продукт и дату производства до подтверждения: они печатаются на этикетках коробов. Если ошиблись — закройте смену и создайте новую, сообщив мастеру.",
          },
        ],
      },
      {
        id: "work-start",
        heading: "6. Начало работы",
        blocks: [
          {
            kind: "step",
            title: "Проверьте рабочий экран",
            text: "Перед первым сканированием убедитесь: в шапке — ваша смена и продукт; счётчики обнулены или соответствуют уже сделанному; в строке состояния нет предупреждений о сканере, принтере или связи.",
            image: { id: "work-start", caption: "Рабочий экран: смена открыта, станция готова к сканированию" },
            expected: "Станция готова: отсканируйте первый код маркировки — результат появится на экране.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "7. Частые проблемы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Бейдж не читается",
                detail: "Используйте вход через поиск по имени (раздел 3, шаг 3) и сообщите администратору о замене бейджа.",
              },
              {
                term: "Станция не принимает PIN-код",
                detail: "Проверьте раскладку и повторите ввод. После нескольких неверных попыток обратитесь к администратору для сброса PIN-кода.",
              },
              {
                term: "Нужной смены нет в списке",
                detail: "Создайте новую смену (раздел 5) или уточните у мастера, на какой станции была открыта смена.",
              },
              {
                term: "Строка состояния показывает ошибку оборудования",
                detail: "Не начинайте сканирование. Проверьте кабели сканера и принтера; если ошибка не ушла — позовите наладчика.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "Если проблема не описана выше, обратитесь к администратору вашей организации или в поддержку Маркиро: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
```

- [ ] **Step 4: Зарегистрировать релиз и источник**

В `packages/legal-documents/src/registry.ts`:

1. Импорт: `import { STATION_OPERATOR_SHIFT_CONTENT } from "./documents/station-operator-shift.js";`
2. В `LEGAL_RELEASES` добавить последним элементом:

```ts
  {
    code: "MKR-INS-01",
    revision: "2026.08/01",
    effectiveDate: "2026-08-21",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/stantsiya-vkhod-i-start-smeny/" },
  },
```

3. В `LEGAL_DOCUMENTS` добавить:

```ts
  { releaseKey: "MKR-INS-01/2026.08/01", content: STATION_OPERATOR_SHIFT_CONTENT },
```

- [ ] **Step 5: Обновить существующие тесты пакета**

1. `test/registry.test.ts`: в pinned-тесте список кодов дополнить `"MKR-INS-01"`:

```ts
    expect(LEGAL_RELEASES.map(({ code }) => code)).toEqual([
      "MKR-PD-01",
      "MKR-PD-02",
      "MKR-DPA-01",
      "MKR-BRD-01",
      "MKR-INS-01",
    ]);
```

2. `test/content-contract.test.ts`: локальный `blockText` дополнить новыми kinds — заменить тело на:

```ts
const blockText = (block: LegalBlock): string => {
  if (block.kind === "paragraph") return block.text;
  if (block.kind === "definition-list") {
    return block.items.map(({ term, detail }) => `${term} — ${detail}`).join(" ");
  }
  if (block.kind === "step") {
    return [block.title, block.text, block.image?.caption, block.expected]
      .filter(Boolean)
      .join(" ");
  }
  if (block.kind === "callout") return block.text;
  return block.items.join(" ");
};
```

3. Там же: любые места, где тест перебирает `["ru","en"]` для всех кодов или обращается к `content[locale]` безусловно, перевести на `legalReleaseLocales(code)` (импортировать из `../src/index.js`) и `requireLegalContent(findLegalDocument(code), locale)`. Прогнать тест и починить все падения таким способом — содержательные ожидания (структура секций, уникальность id и т.п.) должны просто начать перебирать только доступные локали.

- [ ] **Step 6: Прогнать тесты**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/instruction-assets.test.ts test/registry.test.ts test/content-contract.test.ts`
Expected: PASS (все три файла).

- [ ] **Step 7: Commit**

```bash
git add packages/legal-documents/src/documents/station-operator-shift.ts packages/legal-documents/src/registry.ts packages/legal-documents/test
git commit -m "feat(legal-documents): MKR-INS-01 station shift-start instruction content"
```

---

### Task 4: DOCX — блоки step/callout и встраивание PNG

**Files:**
- Modify: `packages/legal-documents/src/artifacts/docx.ts`
- Test: `packages/legal-documents/test/docx.test.ts`

**Interfaces:**
- Consumes: `requireLegalContent`, `legalDocumentKind` из Task 1; контент из Task 3.
- Produces: `renderLegalDocx(input: LegalArtifactRequest, assets?: LegalDocxAssets): Promise<Uint8Array>`, где `export interface LegalDocxAssets { readonly images?: ReadonlyMap<string, Uint8Array> }`. Изображение шага ищется в `assets.images` по `block.image.id`; отсутствие — ошибка.

- [ ] **Step 1: Написать падающий тест**

Добавить в `packages/legal-documents/test/docx.test.ts` (использовать уже применяемые в файле хелперы распаковки; если их нет — `unzipSync` из `fflate` уже в devDeps):

```ts
describe("instruction rendering", () => {
  const instructionRequest = {
    code: "MKR-INS-01",
    revision: "2026.08/01",
    effectiveDate: "2026-08-21",
    locale: "ru",
    kind: "legal-pdf",
    verificationUrl: legalVerificationUrl(findLegalRelease("MKR-INS-01")),
  } as const;

  // Minimal valid 1x1 PNG (89 PNG header + IHDR/IDAT/IEND).
  const onePxPng = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    ),
    (char) => char.charCodeAt(0),
  );

  const instructionImages = () => {
    const content = requireLegalContent(findLegalDocument("MKR-INS-01"), "ru");
    const ids = content.sections
      .flatMap(({ blocks }) => blocks)
      .flatMap((block) => (block.kind === "step" && block.image ? [block.image.id] : []));
    return new Map(ids.map((id) => [id, onePxPng]));
  };

  it("embeds one PNG media part per referenced step image", async () => {
    const images = instructionImages();
    const bytes = await renderLegalDocx(instructionRequest, { images });
    const entries = unzipSync(bytes);
    const media = Object.keys(entries).filter((name) => /^word\/media\/.*\.png$/.test(name));
    // Header brand mark ships as SVG with a PNG fallback, so at least
    // every instruction image adds a distinct PNG part.
    expect(media.length).toBeGreaterThanOrEqual(images.size);
    const documentXml = new TextDecoder().decode(entries["word/document.xml"]);
    expect(documentXml).toContain("Шаг 1.");
    expect(documentXml).toContain("Ожидаемый результат");
    expect(documentXml).toContain("Важно");
  });

  it("rejects rendering when a step image is missing", async () => {
    await expect(renderLegalDocx(instructionRequest, { images: new Map() })).rejects.toThrow(
      /Missing instruction image/,
    );
  });
});
```

Импорты в шапке теста дополнить: `findLegalDocument, findLegalRelease, legalVerificationUrl, requireLegalContent` из `../src/index.js`, `renderLegalDocx` из `../src/artifacts/index.js` (или как уже импортируется в файле), `unzipSync` из `fflate`.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/docx.test.ts`
Expected: FAIL — `renderLegalDocx` не принимает второй аргумент / `names.ts` отвергает `MKR-INS-01` (это нормально: тогда сначала выполнить Step 3 Task 5 для `names.ts` — см. примечание ниже).

**Примечание о связке с Task 5:** `assertLegalArtifactRequest` в `names.ts` валидирует локали через `Object.keys` реестра — после Task 1/3 `MKR-INS-01` уже валиден для `legal-pdf`/`ru`, менять `names.ts` не требуется (набор kinds не расширяется). Если тест падает именно в `names.ts` — прочитать сообщение и убедиться, что это не про локаль `en`.

- [ ] **Step 3: Реализация в `docx.ts`**

1. Импорты: добавить `legalDocumentKind, requireLegalContent` в импорт из `../registry.js`.

2. Добавить тип и константы (после существующих констант):

```ts
export interface LegalDocxAssets {
  readonly images?: ReadonlyMap<string, Uint8Array>;
}

// Instruction screenshots render at the full text column: the A4 content
// width (11906 - 2 * 1134 twips) is ~642 px at 96 DPI; 600 px leaves slack
// for LibreOffice rounding during PDF export.
const INSTRUCTION_IMAGE_WIDTH = 600;
```

3. Расширить `copy` (обе локали, чтобы тип остался полным):

```ts
  ru: {
    ...существующие ключи...,
    instructionClass: "РАБОЧАЯ ИНСТРУКЦИЯ",
    step: "Шаг",
    expected: "Ожидаемый результат",
    calloutInfo: "Примечание",
    calloutWarning: "Важно",
  },
  en: {
    ...существующие ключи...,
    instructionClass: "WORK INSTRUCTION",
    step: "Step",
    expected: "Expected result",
    calloutInfo: "Note",
    calloutWarning: "Important",
  },
```

4. Сигнатура: `export async function renderLegalDocx(input: LegalArtifactRequest, assets: LegalDocxAssets = {}): Promise<Uint8Array>`. Строку получения контента заменить на:

```ts
  const source = requireLegalContent(findLegalDocument(input.code, input.revision), input.locale);
```

5. Метка класса документа: перед `new Document(...)` вычислить

```ts
  const classLabel =
    legalDocumentKind(input.code) === "instruction"
      ? copy[input.locale].instructionClass
      : copy[input.locale].documentClass;
```

и передавать `classLabel` в оба вызова `createHeader(...)` вместо `copy[input.locale].documentClass`.

6. Рендер секций: заменить `...source.sections.flatMap((section) => [...])` на

```ts
          ...source.sections.flatMap((section) => {
            let stepNumber = 0;
            return [
              new Paragraph({
                heading: HeadingLevel.HEADING_1,
                children: [new TextRun(section.heading)],
              }),
              ...section.blocks.flatMap((block) => {
                if (block.kind === "step") {
                  stepNumber += 1;
                  return renderStep(block, stepNumber, input.locale, assets);
                }
                return renderBlock(block, input.locale);
              }),
            ];
          }),
```

7. `renderBlock` получает второй параметр `locale: LegalLocale` (импортировать тип из `../types.js`) и новый case:

```ts
    case "callout":
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: `${block.tone === "warning" ? copy[locale].calloutWarning : copy[locale].calloutInfo}: `,
              bold: true,
            }),
            new TextRun(block.text),
          ],
        }),
      ];
    case "step":
      throw new Error("Step blocks are rendered with their section-scoped number");
```

8. Новые функции (рядом с `renderBlock`):

```ts
function renderStep(
  block: Extract<LegalBlock, { kind: "step" }>,
  stepNumber: number,
  locale: LegalLocale,
  assets: LegalDocxAssets,
): readonly FileChild[] {
  const children: FileChild[] = [
    new Paragraph({
      spacing: { before: 160, after: 60 },
      keepNext: true,
      children: [
        new TextRun({ text: `${copy[locale].step} ${stepNumber}. ${block.title}`, bold: true }),
      ],
    }),
    new Paragraph({ children: [new TextRun(block.text)] }),
  ];

  if (block.image) {
    const data = assets.images?.get(block.image.id);
    if (!data) {
      throw new Error(`Missing instruction image: ${block.image.id}`);
    }
    const { width, height } = readPngDimensions(data, block.image.id);
    const displayHeight = Math.max(1, Math.round((height / width) * INSTRUCTION_IMAGE_WIDTH));
    children.push(
      new Paragraph({
        keepNext: true,
        spacing: { before: 60, after: 40 },
        children: [
          new ImageRun({
            type: "png",
            data,
            transformation: { width: INSTRUCTION_IMAGE_WIDTH, height: displayHeight },
            altText: {
              name: block.image.id,
              description: block.image.caption,
              title: block.image.caption,
            },
          }),
        ],
      }),
      new Paragraph({
        style: "DocumentSummary",
        spacing: { after: 120 },
        children: [new TextRun(block.image.caption)],
      }),
    );
  }

  if (block.expected) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${copy[locale].expected}: `, bold: true }),
          new TextRun(block.expected),
        ],
      }),
    );
  }
  return children;
}

function readPngDimensions(
  data: Uint8Array,
  imageId: string,
): { readonly width: number; readonly height: number } {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length < 24 || PNG_SIGNATURE.some((byte, index) => data[index] !== byte)) {
    throw new Error(`Instruction image is not a PNG: ${imageId}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) {
    throw new Error(`Instruction image has invalid dimensions: ${imageId}`);
  }
  return { width, height };
}
```

Импорт `LegalBlock` уже есть; добавить `LegalLocale` из `../types.js`.

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/docx.test.ts`
Expected: PASS, включая существующие тесты юридических документов (они рендерятся без `assets`).

- [ ] **Step 5: Commit**

```bash
git add packages/legal-documents/src/artifacts/docx.ts packages/legal-documents/test/docx.test.ts
git commit -m "feat(legal-documents): render step and callout blocks with embedded PNG screenshots"
```

---

### Task 5: CLI генерации и верификации артефактов

**Files:**
- Modify: `packages/legal-documents/src/artifacts/names.ts`
- Modify: `packages/legal-documents/src/cli/verify-artifacts.ts`
- Modify: `packages/legal-documents/src/cli/generate-artifacts.ts`
- Test: `packages/legal-documents/test/artifact-manifest.test.ts`

**Interfaces:**
- Consumes: `legalDocumentKind`, `legalReleaseLocales` (Task 1), `renderLegalDocx(input, assets)` (Task 4), PNG-ассеты (Task 2).
- Produces:
  - `MAX_INSTRUCTION_PDF_BYTES = 12 * 1024 * 1024` и `maxLegalPdfBytes(code: LegalDocumentCode): number` — экспорт из `verify-artifacts.ts`.
  - `currentRequests()` выдаёт для MKR-INS-01 ровно один запрос: `legal-pdf` / `ru`.
  - Ожидаемый набор артефактов везде считается через `legalReleaseLocales`.

- [ ] **Step 1: Написать падающие тесты**

В `packages/legal-documents/test/artifact-manifest.test.ts` добавить:

```ts
describe("instruction artifact bounds", () => {
  it("expects a Russian-only PDF for MKR-INS-01", () => {
    const release = findLegalRelease("MKR-INS-01");
    expect(
      artifactFileName({
        code: "MKR-INS-01",
        revision: release.revision,
        effectiveDate: release.effectiveDate,
        locale: "ru",
        kind: "legal-pdf",
        verificationUrl: legalVerificationUrl(release),
      }),
    ).toBe("markiro_mkr-ins-01_2026.08-01_ru.pdf");
    expect(() =>
      artifactFileName({
        code: "MKR-INS-01",
        revision: release.revision,
        effectiveDate: release.effectiveDate,
        locale: "en",
        kind: "legal-pdf",
        verificationUrl: legalVerificationUrl(release),
      }),
    ).toThrow(/locale/i);
    expect(() =>
      artifactFileName({
        code: "MKR-INS-01",
        revision: release.revision,
        effectiveDate: release.effectiveDate,
        locale: "ru",
        kind: "template-docx",
        verificationUrl: legalVerificationUrl(release),
      }),
    ).toThrow(/not a downloadable template/);
  });

  it("gives instructions a wider PDF bound", () => {
    expect(maxLegalPdfBytes("MKR-PD-01")).toBe(MAX_LEGAL_PDF_BYTES);
    expect(maxLegalPdfBytes("MKR-INS-01")).toBe(MAX_INSTRUCTION_PDF_BYTES);
    expect(MAX_INSTRUCTION_PDF_BYTES).toBe(12 * 1024 * 1024);
  });
});
```

(импорты дополнить: `findLegalRelease, legalVerificationUrl` из `../src/index.js`; `artifactFileName` из `../src/artifacts/names.js`; `MAX_LEGAL_PDF_BYTES, MAX_INSTRUCTION_PDF_BYTES, maxLegalPdfBytes` из `../src/cli/verify-artifacts.js` — как уже импортируется в этом файле).

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/artifact-manifest.test.ts`
Expected: FAIL — `maxLegalPdfBytes` не существует; локаль `en` для MKR-INS-01 не отвергается.

- [ ] **Step 3: `names.ts` — локали по категории**

В `assertLegalArtifactRequest`:

1. Импорт: `import { findLegalRelease, legalDocumentKind, legalReleaseLocales } from "../registry.js";`
2. Заменить локальную проверку `if (input.locale !== "ru" && input.locale !== "en")` — оставить как есть (первичная), а ПОСЛЕ получения `release` добавить:

```ts
  if (!legalReleaseLocales(input.code).includes(input.locale)) {
    throw new Error(`Invalid legal artifact locale for ${input.code}: ${input.locale}`);
  }
```

3. Заменить `const TEMPLATE_CODES = new Set<LegalDocumentCode>(["MKR-DPA-01", "MKR-BRD-01"]);` и его использование на проверку через kind:

```ts
  if (input.kind === "template-docx" && legalDocumentKind(input.code) !== "template") {
    throw new Error(`Legal artifact is not a downloadable template: ${input.code}`);
  }
```

- [ ] **Step 4: `verify-artifacts.ts`**

1. Импорты: добавить `legalDocumentKind, legalReleaseLocales` из `../registry.js` и тип `LegalDocumentCode` уже есть.
2. Рядом с `MAX_LEGAL_PDF_BYTES` добавить:

```ts
export const MAX_INSTRUCTION_PDF_BYTES = 12 * 1024 * 1024;

export function maxLegalPdfBytes(code: LegalDocumentCode): number {
  return legalDocumentKind(code) === "instruction" ? MAX_INSTRUCTION_PDF_BYTES : MAX_LEGAL_PDF_BYTES;
}
```

3. `LEGAL_DOCUMENT_CODES` дополнить `"MKR-INS-01"`.
4. `SAFE_FILE_NAME` заменить на:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-01|pd-02|dpa-01|brd-01|ins-01)_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

5. Удалить локальный `TEMPLATE_CODES`; в `parseArtifact` заменить проверку шаблона на `if (kind === "template-docx" && legalDocumentKind(code) !== "template")` и после определения `release` добавить:

```ts
  if (!legalReleaseLocales(code).includes(locale)) {
    throw new Error(`Artifact locale is not published for ${code}: ${locale}`);
  }
```

6. `expectedArtifactKeys()` — заменить внутренний перебор локалей:

```ts
    for (const locale of legalReleaseLocales(release.code)) {
      keys.add(`${release.code}|${release.revision}|${locale}|pdfa-2b`);
      if (legalDocumentKind(release.code) === "template") {
        keys.add(`${release.code}|${release.revision}|${locale}|template-docx`);
      }
    }
```

7. Проверку размера в `verifyArtifactManifest` заменить:

```ts
    if (entry.kind === "pdfa-2b" && stats.size > maxLegalPdfBytes(entry.code)) {
      throw new Error(`Legal PDF exceeds its release size bound: ${entry.fileName}`);
    }
```

- [ ] **Step 5: `generate-artifacts.ts`**

1. Импорты: `legalDocumentKind, legalReleaseLocales` из `../registry.js`; `maxLegalPdfBytes` добавить в импорт из `./verify-artifacts.js` (существующий импорт `MAX_LEGAL_PDF_BYTES` можно оставить, если он используется в других местах — проверить grep'ом и убрать, если остался только в size-проверке).
2. Локальный `const TEMPLATE_CODES = ...` (строка ~46) заменить использования на `legalDocumentKind(release.code) === "template"` (в `currentRequests`) и удалить константу.
3. `currentRequests()` — перебор локалей заменить на `legalReleaseLocales(release.code)`:

```ts
function currentRequests(): readonly LegalArtifactRequest[] {
  return LEGAL_RELEASES.filter(({ status }) => status === "active").flatMap((release) =>
    legalReleaseLocales(release.code).flatMap((locale) => [
      {
        code: release.code,
        revision: release.revision,
        effectiveDate: release.effectiveDate,
        locale,
        kind: "legal-pdf" as const,
        verificationUrl: legalVerificationUrl(release),
      },
      ...(legalDocumentKind(release.code) === "template"
        ? [
            {
              code: release.code,
              revision: release.revision,
              effectiveDate: release.effectiveDate,
              locale,
              kind: "template-docx" as const,
              verificationUrl: legalVerificationUrl(release),
            },
          ]
        : []),
    ]),
  );
}
```

4. `blockText` (строка ~851) — добавить cases:

```ts
    case "step":
      return [block.title, block.text, block.image?.caption, block.expected]
        .filter((part): part is string => Boolean(part))
        .join(" ");
    case "callout":
      return block.text;
```

5. Проверку размера в `validatePdf` (строка ~958) заменить:

```ts
      if (pdfStats.size > maxLegalPdfBytes(request.code)) {
        throw new Error(`Generated PDF exceeds its release size bound: ${pdfPath}`);
      }
```

6. Загрузка картинок для рендера. Рядом с `createDefaultDependencies` добавить:

```ts
// dist/cli/../../assets and src/cli/../../assets both resolve to the package
// root, so the loader works compiled and under vitest alike.
const INSTRUCTION_ASSETS_ROOT = fileURLToPath(new URL("../../assets/instructions/", import.meta.url));

async function loadInstructionImages(
  code: LegalDocumentCode,
): Promise<ReadonlyMap<string, Uint8Array> | undefined> {
  if (legalDocumentKind(code) !== "instruction") return undefined;
  const directory = path.join(INSTRUCTION_ASSETS_ROOT, code.toLowerCase());
  const entries = await readdir(directory, { withFileTypes: true });
  const images = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".png")) {
      throw new Error(`Unexpected instruction asset entry: ${entry.name}`);
    }
    images.set(entry.name.slice(0, -".png".length), await readFile(path.join(directory, entry.name)));
  }
  if (images.size === 0) throw new Error(`Instruction assets are missing for ${code}`);
  return images;
}
```

и в `createDefaultDependencies()` заменить `renderDocx: renderLegalDocx,` на:

```ts
    renderDocx: async (request) =>
      renderLegalDocx(request, { images: await loadInstructionImages(request.code) }),
```

Если тип `ArtifactGenerationDependencies.renderDocx` описан как `typeof renderLegalDocx` — поменять на `(request: LegalArtifactRequest) => Promise<Uint8Array>`.

- [ ] **Step 6: Прогнать тесты и typecheck пакета**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/artifact-manifest.test.ts`
Expected: сначала, вероятно, FAIL в других местах этого файла (48K — он пинит перечни кодов/наборов). Починить по сообщениям: везде, где тест жёстко перечисляет ожидаемые дескрипторы/файлы/ключи, добавить `MKR-INS-01`-запись только для `ru`/`pdfa-2b` (файл `markiro_mkr-ins-01_2026.08-01_ru.pdf`), пользуясь уже существующими в тесте фабриками фикстур. Затем:

Run: `pnpm --filter @markiro/legal-documents test && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents lint`
Expected: всё PASS (typecheck пакета к этому моменту обязан стать зелёным).

- [ ] **Step 7: Commit**

```bash
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal-documents): generate and verify the RU-only instruction PDF artifact"
```

---

### Task 6: Лендинг — загрузчик артефактов

**Files:**
- Modify: `apps/landing/src/lib/legal-artifacts.ts`
- Test: `apps/landing/src/lib/legal-artifacts.test.ts`

**Interfaces:**
- Consumes: `legalDocumentKind`, `legalReleaseLocales` из `@markiro/legal-documents` (Task 1); типы без изменений.
- Produces: `loadLegalArtifacts()` принимает и требует RU-only набор для инструкций; `PublishedLegalArtifactKind` НЕ меняется.

- [ ] **Step 1: Обновить `legal-artifacts.ts`**

1. Импорт из `@markiro/legal-documents` дополнить `legalDocumentKind, legalReleaseLocales`.
2. `SAFE_FILE_NAME` заменить на:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01|ins-01)_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

3. Удалить локальный `TEMPLATE_CODES`; в `parseArtifact` заменить `TEMPLATE_CODES.has(release.code)` на `legalDocumentKind(release.code) === "template"` и после строки валидации локали добавить:

```ts
  if (!legalReleaseLocales(release.code).includes(value.locale)) {
    fail("locale is not published for this code");
  }
```

4. `assertCompleteReleaseSet` — перебор локалей заменить:

```ts
  for (const release of PUBLISHED_RELEASES) {
    for (const locale of legalReleaseLocales(release.code)) {
      expected.add(descriptorKey({ ...release, locale, kind: "pdfa-2b" }));
      if (legalDocumentKind(release.code) === "template") {
        expected.add(descriptorKey({ ...release, locale, kind: "template-docx" }));
      }
    }
  }
```

- [ ] **Step 2: Прогнать и починить тест лендинга**

Run: `pnpm --filter @markiro/landing exec vitest run src/lib/legal-artifacts.test.ts`
Expected: вероятный FAIL — тест строит фикстурный манифест из полного набора релизов. Дополнить фикстуры записью для `MKR-INS-01` (`ru`, `pdfa-2b`, `markiro_mkr-ins-01_2026.08-01_ru.pdf`) по образцу существующих записей и убедиться, что негативные сценарии (неполный набор, лишняя локаль) продолжают проверяться. Добавить один новый негативный кейс:

```ts
  it("rejects an English artifact for a Russian-only instruction", async () => {
    // Клонировать валидную фикстуру манифеста, добавить запись
    // markiro_mkr-ins-01_2026.08-01_en.pdf и ожидать reject с
    // /locale is not published/.
  });
```

(реализовать по образцу соседних негативных тестов файла — они уже умеют собирать временный public-каталог).

Run повторно: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/landing/src/lib/legal-artifacts.ts apps/landing/src/lib/legal-artifacts.test.ts
git commit -m "feat(landing): accept the RU-only instruction artifact set"
```

---

### Task 7: Лендинг — страница инструкции, реестр, стили

**Files:**
- Modify: `packages/legal-documents/package.json` (exports для assets)
- Modify: `apps/landing/src/content/legal-pages.ts`
- Create: `apps/landing/src/components/InstructionDocument.astro`
- Create: `apps/landing/src/pages/instruktsii/stantsiya-vkhod-i-start-smeny/index.astro`
- Modify: `apps/landing/src/components/LegalRegistry.astro`
- Modify: `apps/landing/src/components/LegalVerification.astro`
- Modify: `apps/landing/src/components/LegalArtifactControls.astro`
- Modify: `apps/landing/src/components/LegalDocument.astro`
- Modify: `apps/landing/src/styles/landing.css`

**Interfaces:**
- Consumes: `requireLegalContent`, `legalReleaseLocales`, `legalDocumentKind`, релиз MKR-INS-01; артефакты из Task 6.
- Produces: страница `/instruktsii/stantsiya-vkhod-i-start-smeny/`; группа «Инструкции» в `/legal/`; `InstructionDocument.astro` с props `{ page: LegalDocumentPageDefinition; images: Record<string, string> }` (id картинки → URL).

- [ ] **Step 1: Экспортировать assets из пакета**

В `packages/legal-documents/package.json` в `exports` добавить:

```json
    "./assets/*": "./assets/*"
```

- [ ] **Step 2: `legal-pages.ts` — RU-only определения**

1. В `DESCRIPTION_BY_CODE` добавить:

```ts
  "MKR-INS-01": {
    ru: "Печатная инструкция оператора станции сканирования: вход по бейджу, выбор или создание смены, начало работы.",
    en: "Printable scanning-station operator instruction: badge sign-in, shift selection or creation, and starting work.",
  },
```

2. `getLegalDocumentPage` — заменить получение контента и alternatePath:

```ts
  const release = findLegalRelease(code);
  const source = findLegalDocument(code);
  const content = requireLegalContent(source, locale);
  const route = release.routes[locale];
  if (!route) throw new Error(`Legal route is not published for ${code}/${locale}`);
  return {
    code,
    locale,
    metadata: {
      path: route,
      alternatePath: release.routes[locale === "ru" ? "en" : "ru"] ?? route,
      ...остальное без изменений...
    },
  };
```

(импортировать `requireLegalContent` из `@markiro/legal-documents`).

3. `LEGAL_SEARCH_PAGES` — оба flatMap по локалям заменить на перебор `legalReleaseLocales(release.code)` (импортировать), а `navigationLabel` считать через `requireLegalContent(findLegalDocument(release.code), locale).title`.

- [ ] **Step 3: `InstructionDocument.astro`**

Создать `apps/landing/src/components/InstructionDocument.astro` на базе `LegalDocument.astro` (скопировать и изменить). Полный листинг:

```astro
---
import {
  OPERATOR_PROFILES,
  formatLegalEffectiveDate,
  findLegalDocument,
  findLegalRelease,
  requireLegalContent,
  type LegalBlock,
} from "@markiro/legal-documents";

import type { LegalDocumentPageDefinition } from "../content/legal-pages";
import { buildLegalPageGraph } from "../lib/seo";
import { readPublicSiteConfig } from "../lib/site-config";
import { artifactsForRelease, loadLegalArtifacts } from "../lib/legal-artifacts";
import BaseLayout from "../layouts/BaseLayout.astro";
import LandingFooter from "./LandingFooter.astro";
import LandingHeader from "./LandingHeader.astro";
import LegalArtifactControls from "./LegalArtifactControls.astro";

interface Props {
  page: LegalDocumentPageDefinition;
  images: Record<string, string>;
}

const { page, images } = Astro.props;
const release = findLegalRelease(page.code);
const content = requireLegalContent(findLegalDocument(page.code), page.locale);
const operator = OPERATOR_PROFILES[release.operatorProfileId];
const registryPath = "/legal/";
const siteConfig = readPublicSiteConfig({ PUBLIC_PHONE: import.meta.env.PUBLIC_PHONE }, page.locale);
const artifacts = artifactsForRelease(await loadLegalArtifacts(), release.code, release.revision, page.locale);
const graph = buildLegalPageGraph(page.metadata, {
  published: release.effectiveDate,
  modified: release.effectiveDate,
});

const imageUrl = (id: string): string => {
  const url = images[id];
  if (!url) throw new Error(`Missing instruction image asset: ${id}`);
  return url;
};

const stepBlocks = (blocks: readonly LegalBlock[]) => {
  let stepNumber = 0;
  return blocks.map((block) => ({
    block,
    stepNumber: block.kind === "step" ? ++stepNumber : 0,
  }));
};
---

<BaseLayout metadata={page.metadata} graph={graph}>
  <LandingHeader page={page.metadata} phone={siteConfig.phone} />
  <main id="main" class="legal-page instruction-page">
    <header class="legal-hero">
      <div class="container legal-hero__inner">
        <a class="legal-backlink" href={registryPath}>← Реестр документов</a>
        <p class="section-index">{page.code}</p>
        <h1>{content.title}</h1>
        <p class="legal-hero__summary">{content.summary}</p>
      </div>
    </header>

    <div class="container legal-layout">
      <aside class="legal-sidebar">
        <div class="legal-release-card" data-legal-status={release.status}>
          <span>Действует</span>
          <dl>
            <div><dt>Код</dt><dd data-legal-code>{release.code}</dd></div>
            <div><dt>Редакция</dt><dd data-legal-revision>{release.revision}</dd></div>
            <div><dt>Действует с</dt><dd><time datetime={release.effectiveDate} data-legal-effective-date>{formatLegalEffectiveDate(release.effectiveDate, page.locale)}</time></dd></div>
          </dl>
        </div>
        <nav class="legal-toc" aria-label="Содержание">
          <p>Содержание</p>
          {content.sections.map((section) => <a href={`#${section.id}`}>{section.heading}</a>)}
        </nav>
      </aside>

      <article class="legal-document instruction-document" data-legal-document data-legal-kind="instruction">
        <LegalArtifactControls release={release} locale={page.locale} artifacts={artifacts} />
        {content.sections.map((section) => (
          <section id={section.id} aria-labelledby={`${section.id}-heading`}>
            <h2 id={`${section.id}-heading`}>{section.heading}</h2>
            {stepBlocks(section.blocks).map(({ block, stepNumber }) => (
              <>
                {block.kind === "paragraph" && <p>{block.text}</p>}
                {block.kind === "ordered-list" && <ol>{block.items.map((item) => <li>{item}</li>)}</ol>}
                {block.kind === "unordered-list" && <ul>{block.items.map((item) => <li>{item}</li>)}</ul>}
                {block.kind === "definition-list" && (
                  <dl class="legal-definitions">
                    {block.items.map(({ term, detail }) => (
                      <div>
                        <dt>{term} <span aria-hidden="true">—&nbsp;</span></dt>
                        <dd>{detail}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {block.kind === "callout" && (
                  <aside class={`instruction-callout instruction-callout--${block.tone}`} role="note">
                    <strong>{block.tone === "warning" ? "Важно" : "Примечание"}</strong>
                    <p>{block.text}</p>
                  </aside>
                )}
                {block.kind === "step" && (
                  <article class="instruction-step">
                    <h3 class="instruction-step__title">
                      <span class="instruction-step__number" aria-hidden="true">{stepNumber}</span>
                      Шаг {stepNumber}. {block.title}
                    </h3>
                    <p>{block.text}</p>
                    {block.image && (
                      <figure class="instruction-step__figure">
                        <img src={imageUrl(block.image.id)} alt={block.image.caption} loading="lazy" width="1280" height="800" />
                        <figcaption>{block.image.caption}</figcaption>
                      </figure>
                    )}
                    {block.expected && (
                      <p class="instruction-step__expected"><strong>Ожидаемый результат:</strong> {block.expected}</p>
                    )}
                  </article>
                )}
              </>
            ))}
          </section>
        ))}

        <aside class="legal-contact" aria-label="Контакты оператора">
          <h2>Контакты оператора</h2>
          <p>{operator.name}<br />{operator.address}</p>
          <p><a href={`mailto:${operator.email}`}>{operator.email}</a><br /><a href="tel:+79343551490">{operator.phone}</a></p>
        </aside>
      </article>
    </div>
  </main>
  <LandingFooter page={page.metadata} />

  <script>
    import { browserLandingRuntime, initLanding } from "../scripts/site";
    initLanding(document, browserLandingRuntime(window));
  </script>
</BaseLayout>
```

- [ ] **Step 4: Страница**

Создать `apps/landing/src/pages/instruktsii/stantsiya-vkhod-i-start-smeny/index.astro`:

```astro
---
import loginBadge from "@markiro/legal-documents/assets/instructions/mkr-ins-01/login-badge.png?url";
import loginPin from "@markiro/legal-documents/assets/instructions/mkr-ins-01/login-pin.png?url";
import loginNameSearch from "@markiro/legal-documents/assets/instructions/mkr-ins-01/login-name-search.png?url";
import shiftSelect from "@markiro/legal-documents/assets/instructions/mkr-ins-01/shift-select.png?url";
import newShift from "@markiro/legal-documents/assets/instructions/mkr-ins-01/new-shift.png?url";
import workStart from "@markiro/legal-documents/assets/instructions/mkr-ins-01/work-start.png?url";

import { getLegalDocumentPage } from "../../../content/legal-pages";
import InstructionDocument from "../../../components/InstructionDocument.astro";

const images = {
  "login-badge": loginBadge,
  "login-pin": loginPin,
  "login-name-search": loginNameSearch,
  "shift-select": shiftSelect,
  "new-shift": newShift,
  "work-start": workStart,
};
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-01", "ru")} images={images} />
```

- [ ] **Step 5: Правки существующих компонентов**

1. `LegalDocument.astro` (строка 26): `const content = documentSource.content[page.locale];` → `const content = requireLegalContent(documentSource, page.locale);` (добавить импорт `requireLegalContent`).
2. `LegalRegistry.astro`: разделить релизы и добавить группу «Инструкции». Во frontmatter:

```ts
import { legalDocumentKind, requireLegalContent } from "@markiro/legal-documents";

const documentReleases = ACTIVE_LEGAL_RELEASES.filter(
  ({ code }) => legalDocumentKind(code) !== "instruction",
);
const instructionReleases =
  metadata.locale === "ru"
    ? ACTIVE_LEGAL_RELEASES.filter(({ code }) => legalDocumentKind(code) === "instruction")
    : [];
```

В разметке существующий `.map` перевести с `ACTIVE_LEGAL_RELEASES` на `documentReleases`, а `findLegalDocument(release.code).content[metadata.locale]` внутри — на `requireLegalContent(findLegalDocument(release.code), metadata.locale)`. После закрывающего `</article>` реестра добавить (рендерится только при непустом списке):

```astro
    {instructionReleases.length > 0 && (
      <article class="container legal-registry" data-legal-document data-legal-kind="instruction-registry">
        <div class="legal-registry__heading">
          <p class="section-index">Инструкции</p>
          <h2>Печатные инструкции</h2>
        </div>
        <div class="legal-registry__list">
          {instructionReleases.map((release) => {
            const content = requireLegalContent(findLegalDocument(release.code), "ru");
            return (
              <article class="legal-registry__entry" data-legal-status={release.status}>
                <a class="legal-registry__item" href={release.routes.ru}>
                  <span class="legal-registry__code" data-registry-code data-legal-code>{release.code}</span>
                  <span class="legal-registry__title">{content.title}</span>
                  <span class="legal-registry__meta">
                    <span data-legal-revision>{release.revision}</span>
                    <span aria-hidden="true">·</span>
                    <time datetime={release.effectiveDate} data-legal-effective-date>{formatLegalEffectiveDate(release.effectiveDate, "ru")}</time>
                  </span>
                  <span class="legal-registry__arrow" aria-hidden="true">→</span>
                </a>
                <LegalArtifactControls
                  release={release}
                  locale="ru"
                  artifacts={artifactsForRelease(publishedArtifacts, release.code, release.revision, "ru")}
                  compact
                />
              </article>
            );
          })}
        </div>
      </article>
    )}
```

3. `LegalVerification.astro`: EN-секцию обернуть условием. Во frontmatter добавить `const enContent = source.content.en; const enRoute = release.routes.en;`, RU-заголовок брать как `source.content.ru.title` (без изменений), а весь `<section lang="en">…</section>` рендерить только при `{enContent && enRoute && (…)}` с `enContent.title` и `enRoute` внутри.
4. `LegalArtifactControls.astro`: заменить финальную ссылку перевода:

```astro
{release.routes[otherLocale] && (
  <a class="legal-artifacts__translation" href={release.routes[otherLocale]} hreflang={otherLocale} lang={otherLocale}>
    {locale === "ru" ? "Matching English translation" : "Соответствующая русская редакция"}
  </a>
)}
```

- [ ] **Step 6: Стили**

В конец `apps/landing/src/styles/landing.css` добавить блок (использовать существующие css-переменные файла; проверить их имена grep'ом `--ink\|--paper\|--line` и подставить фактические):

```css
/* Instruction documents (MKR-INS-*) */
.instruction-step {
  margin: 1.5rem 0;
  padding-left: 1rem;
  border-left: 3px solid var(--line, #d8d4cc);
}
.instruction-step__title {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  font-size: 1.05rem;
}
.instruction-step__number {
  flex: none;
  inline-size: 1.7rem;
  block-size: 1.7rem;
  border-radius: 50%;
  background: var(--ink, #191712);
  color: var(--paper, #f7f5f0);
  font-size: 0.85rem;
  display: grid;
  place-items: center;
}
.instruction-step__figure {
  margin: 0.75rem 0;
}
.instruction-step__figure img {
  inline-size: 100%;
  block-size: auto;
  border: 1px solid var(--line, #d8d4cc);
  border-radius: 6px;
}
.instruction-step__figure figcaption {
  margin-top: 0.35rem;
  font-size: 0.85rem;
  color: var(--muted, #6b675e);
}
.instruction-step__expected {
  font-size: 0.95rem;
}
.instruction-callout {
  margin: 1rem 0;
  padding: 0.75rem 1rem;
  border: 1px solid var(--line, #d8d4cc);
  border-radius: 6px;
}
.instruction-callout--warning {
  border-color: #b4540a;
}
.instruction-callout strong {
  display: block;
  margin-bottom: 0.25rem;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
@media print {
  .instruction-step {
    break-inside: avoid;
  }
}
```

- [ ] **Step 7: Тесты и сборка лендинга**

Run: `pnpm --filter @markiro/landing test`
Expected: PASS (в т.ч. `pages.test.ts`, `seo.test.ts`; если какой-то тест пинит полный список поисковых страниц — добавить `/instruktsii/stantsiya-vkhod-i-start-smeny/` RU-only записью).

Сборку (`astro build`) НЕ гонять до Task 8: `loadLegalArtifacts` требует полного набора артефактов, а PDF инструкции появится только после генерации.

- [ ] **Step 8: Commit**

```bash
git add packages/legal-documents/package.json apps/landing/src
git commit -m "feat(landing): MKR-INS-01 instruction page, registry group, and styles"
```

---

### Task 8: Генерация артефактов, финальные гейты, синхронизация спеки

**Files:**
- Modify: `apps/landing/public/legal/artifacts.json` (генерируется)
- Create: `apps/landing/public/legal/files/markiro_mkr-ins-01_2026.08-01_ru.pdf` (генерируется)
- Modify: `docs/superpowers/specs/2026-08-21-operator-instructions-design.md`

**Interfaces:**
- Consumes: всё из задач 1–7; локальный тулчейн: `/opt/homebrew/bin/soffice` (LibreOffice 26.2.5.2 — соответствует пину), Docker.

- [ ] **Step 1: Сгенерировать артефакты**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
```

Expected: успешное завершение; в `apps/landing/public/legal/files/` появился `markiro_mkr-ins-01_2026.08-01_ru.pdf`, `artifacts.json` пересобран канонически. Прежние PDF/DOCX должны остаться бай-в-байт неизменными (`git status` покажет только два файла: manifest + новый pdf). Если изменились чужие файлы — остановиться и разобраться (это признак недетерминизма, не коммитить).

- [ ] **Step 2: Верифицировать**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: `Verified 9 immutable legal artifacts ...` (было 8 PDF + 4 DOCX = 12; стало 13 — фактическое число возьмётся из вывода; главное — успех). Открыть PDF (Read с pages) и глазами проверить: скриншоты на месте, подписи и «Шаг N» отрисованы, размер файла в пределах 12 MiB.

- [ ] **Step 3: Собрать лендинг**

```bash
pnpm --filter @markiro/landing build
```

Expected: сборка зелёная (`loadLegalArtifacts` принял новый набор). Затем открыть превью (Claude Browser / `astro preview`) на `/instruktsii/stantsiya-vkhod-i-start-smeny/` и `/legal/`: страница инструкции рендерит шаги со скриншотами, реестр показывает группу «Инструкции», `/en/legal/` группу НЕ показывает; сделать скриншот страницы для отчёта.

- [ ] **Step 4: Полные гейты**

```bash
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
```

Expected: всё PASS. Прогнать prettier только по затронутым файлам: `pnpm exec prettier --check <изменённые файлы>` (НЕ `--write .`).

- [ ] **Step 5: Синхронизировать спеку**

В `docs/superpowers/specs/2026-08-21-operator-instructions-design.md` в разделе «4. Печатный артефакт» заменить пункт про `instruction-pdf` на фактическое решение: вид артефакта остаётся `legal-pdf`/`pdfa-2b`, различие — только лимит размера `maxLegalPdfBytes(code)` (12 MiB для инструкций); маршрут в разделе 3 поправить на `/instruktsii/stantsiya-vkhod-i-start-smeny/` (в спеке упомянут `/d/mkr-ins-01/`, но `/d/…` — это адреса проверки ревизий, а не страниц).

- [ ] **Step 6: Финальный коммит**

```bash
git add apps/landing/public/legal docs/superpowers/specs/2026-08-21-operator-instructions-design.md
git commit -m "feat(legal): publish MKR-INS-01 instruction artifact and sync the design spec"
```

---

## Self-Review Notes

- Spec coverage: типы/kind (Task 1), скриншоты (Task 2), контент+реестр (Task 3), DOCX+PNG (Task 4), конвейер PDF (Task 5), лендинг-загрузчик (Task 6), страница/реестр/стили/print (Task 7), генерация+верификация+тесты (задачи 5–8). EN и последующие инструкции — за рамками, как в спеке.
- Отклонения от спеки: (1) без нового вида артефакта `instruction-pdf`; (2) маршрут `/instruktsii/...` вместо `/d/mkr-ins-01/`. Оба фиксируются в спеке в Task 8 Step 5.
- Большие пиновые тесты (`artifact-manifest.test.ts`, фикстуры `legal-artifacts.test.ts`) правятся по фактическим сообщениям падений — это ожидаемый режим для snapshot-подобных тестов, содержательные ожидания заданы в плане точно (какие записи добавить и для каких локалей).
