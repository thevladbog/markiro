# EN-версии кабинетных инструкций MKR-INS-06…09 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выпустить английские версии четырёх кабинетных инструкций: параметризовать съёмочные спеки локалью, снять 43 EN-кадра, перевести содержание и опубликовать четыре EN-PDF.

**Architecture:** Кабинетный харнес учит `?locale=`; обе visual-спеки берут селекторы из настоящих словарей админки и снимают кадры в `<code>/<locale>/`; переводы пишутся по EN-кадрам с линзой по `apps/admin/src/i18n/en.json`; релиз растёт 27 → 31 файл.

**Tech Stack:** TypeScript (ESM), Playwright (`tools/production-browser`, `--ignore-workspace`), Astro, vitest, LibreOffice 26.2.5 + veraPDF (docker), пиненные IBM Plex.

**Spec:** `docs/superpowers/specs/2026-09-02-instructions-en-cabinet-design.md`

## Global Constraints

- EN-маршруты: 06 `/en/instructions/inventory-preparation/`, 07 `/en/instructions/inventory-closing/`, 08 `/en/instructions/shift-planning/`, 09 `/en/instructions/shift-closing/`.
- Ревизии не меняются: 06/07 — `2026.08/03`, 08 — `2026.09/01`, 09 — `2026.09/02`. Обе локали живут под одной ревизией.
- MKR-INS-10 остаётся ru-only: в `INSTRUCTION_EN_PUBLISHED` его не добавлять.
- Существующие 27 файлов релиза остаются байт-в-байт; добавляются ровно 4 EN-PDF.
- Кадры: 06=8, 07=11, 08=14, 09=10 — те же image id, что в `ru/`.
- EN-цитаты берутся дословно из `apps/admin/src/i18n/en.json` и видны на EN-кадре своего шага; EN-текст содержит «Markiro», не содержит «Маркиро», и начинается с оговорки «This is an informational translation. The matching Russian revision is authoritative.»
- **RU-кадры не должны измениться содержательно.** Дрейф отличать по `magick compare -metric PAE` (дрейф — единицы из 255) и откатывать `git checkout --`.
- Перед браузерными спеками: `pnpm --filter @markiro/platform-contracts build`.
- Playwright, docker и `gh` — вне песочницы (`dangerouslyDisableSandbox: true`).
- Генерация: `SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate`; сверка — тот же CLI с `--check`.
- Не использовать `git stash`; перед коммитами — `pnpm format:check`.

---

### Task 1: Харнес и словарь селекторов

**Files:**

- Modify: `apps/admin/test/browser/cabinet-harness.tsx`
- Create: `tools/production-browser/tests/admin-i18n.ts`

**Interfaces:**

- Produces: харнес принимает `?locale=ru|en`; `adminI18n(locale)` возвращает `{ t(key, params?) }` поверх настоящих словарей админки. Обе спеки в Task 2 и 3 используют этот хелпер.

- [ ] **Step 1: Локаль в харнесе**

В `cabinet-harness.tsx` заменить side-effect импорт на именованный и переключить язык до рендера:

```tsx
import i18n from "../../src/i18n/index.js";

const params = new URLSearchParams(window.location.search);
const initialEntry = params.get("route") ?? "/";
// The cabinet evidence suites shoot both locales from the same harness;
// `changeLanguage` before render keeps the first paint in the right
// language and syncs <html lang> through the listener in src/i18n.
const locale = params.get("locale") === "en" ? "en" : "ru";
void i18n.changeLanguage(locale);
```

Синтетическая сессия харнеса тоже локале-зависима: оператор «Игорь Волков» → «Igor Volkov», организация «Марка Ко» → «Marka Co» (точные поля посмотреть в самом файле).

- [ ] **Step 2: Хелпер словаря**

Создать `tools/production-browser/tests/admin-i18n.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Selector text for the cabinet suites comes from the app's own dictionaries
 * rather than a hand-kept copy: the same key then resolves to whatever the
 * cabinet actually renders in that locale, and a renamed string breaks the
 * test instead of silently shooting the wrong screen. Read as JSON because
 * this project runs with `--ignore-workspace` and cannot import the app.
 */
export type AdminLocale = "ru" | "en";

const DICTIONARIES = new Map<AdminLocale, Record<string, unknown>>();

function dictionary(locale: AdminLocale): Record<string, unknown> {
  const cached = DICTIONARIES.get(locale);
  if (cached) return cached;
  const source = readFileSync(
    join(import.meta.dirname, `../../../apps/admin/src/i18n/${locale}.json`),
    "utf8",
  );
  const parsed = JSON.parse(source) as Record<string, unknown>;
  DICTIONARIES.set(locale, parsed);
  return parsed;
}

export function adminI18n(locale: AdminLocale) {
  const dict = dictionary(locale);
  return {
    t(key: string, params: Record<string, string | number> = {}): string {
      const value = key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], dict);
      if (typeof value !== "string") throw new Error(`Missing admin i18n key: ${locale}/${key}`);
      return value.replaceAll(/\{\{(\w+)\}\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match,
      );
    },
  };
}
```

- [ ] **Step 3: Проверить хелпер**

```bash
cd tools/production-browser && node --input-type=module -e "
import { adminI18n } from './tests/admin-i18n.ts';
" 2>/dev/null || node --experimental-strip-types --input-type=module -e "
import { adminI18n } from './tests/admin-i18n.js';
console.log(adminI18n('ru').t('pages.shifts.details.action'), '|', adminI18n('en').t('pages.shifts.details.action'));
"
```

Expected: «Подробнее | Details» (или фактический перевод). Если запуск через node неудобен — проверить хелпер первым же прогоном спеки в Task 2.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/test/browser/cabinet-harness.tsx tools/production-browser/tests/admin-i18n.ts
git commit -m "test(cabinet): teach the harness a locale and read selectors from the app dictionaries"
```

---

### Task 2: Инвентаризационная спека на двух локалях (кадры 06/07)

**Files:**

- Modify: `tools/production-browser/tests/inventory.visual.spec.ts`

**Interfaces:**

- Consumes: `adminI18n`, `?locale=` из Task 1.
- Produces: 19 EN-кадров (06=8, 07=11) в `en/`; RU-кадры не меняются содержательно.

- [ ] **Step 1: Параметризовать пути и URL**

Константы каталогов принимают локаль: `…/mkr-ins-06/${locale}`. URL харнеса получает `&locale=${locale}`. Обернуть набор тестов в `for (const locale of ["ru", "en"] as const) { … }` — по образцу `station-inventory-tests/gallery.spec.ts:33`, где то же самое уже сделано для галереи.

- [ ] **Step 2: Селекторы через словарь**

Каждое русское акцессибл-имя заменить на `t("<ключ>")`. Ключ искать по значению в `apps/admin/src/i18n/ru.json` — например:

```ts
const { t } = adminI18n(locale);
await page.getByRole("button", { name: t("pages.inventory.snapshot.check") }).click();
```

Если строки нет в словаре (доменный каталог вроде меток выгрузок), оставить дословный литерал и пометить комментарием, что это доменная строка, одинаковая в обеих локалях.

- [ ] **Step 3: Мок-данные по локали**

Профиль, организация, продукты, линии, шаблоны, операторы, терминалы — вынести в функцию от локали. RU-ветки оставить дословно прежними, чтобы RU-кадры не поехали. Английские значения: «Igor Volkov», «Marka Co», «Cranberry syrup, 0.5 L», «Line 1», «Box 100×150», «Maria Kuznetsova», «Pyotr Smirnov», «Terminal 1/2».

- [ ] **Step 4: Прогон**

```bash
pnpm --filter @markiro/platform-contracts build
cd tools/production-browser && pnpm --ignore-workspace test:inventory
```

Expected: все тесты PASS на обеих локалях; появились каталоги `mkr-ins-06/en` и `mkr-ins-07/en`.

- [ ] **Step 5: Проверить, что RU не поехал**

```bash
ls packages/legal-documents/assets/instructions/mkr-ins-0{6,7}/en | wc -l
git status --short packages/legal-documents/assets/instructions/mkr-ins-0{6,7}/ru
```

Expected: 19 EN-кадров; каждый изменившийся RU-кадр проверить на дрейф (PAE) и откатить.

- [ ] **Step 6: Посмотреть EN-кадры** — открыть выборочно (`Read`): интерфейс английский, данные английские, состояния совпадают с RU-аналогами.

- [ ] **Step 7: Commit** — `test(inventory): shoot the cabinet inventory evidence in both locales`.

---

### Task 3: Производственная спека на двух локалях (кадры 08/09)

**Files:**

- Modify: `tools/production-browser/tests/production.visual.spec.ts`

**Interfaces:**

- Consumes: `adminI18n`, `?locale=`.
- Produces: 24 EN-кадра (08=14, 09=10).

- [ ] **Step 1–3:** то же, что в Task 2, но для этой спеки: параметризовать `SCREENSHOT_DIR`/`SCREENSHOT_DIR_09`, `openHarness`, `openShiftDetails` (заголовок панели — `t("pages.shifts.details.title", { number })`), селекторы и мок-данные (продукты, линии, контрагент «ООО «Ягодный дом»» → «Berry House LLC», причина закрытия, шаблоны, история этикеток).

Отдельно проверить строки, которые приходят не из админского словаря:

- метки форматов отчётов — из `packages/domain/src/shift-exports.ts`; посмотреть, локализованы ли они там, и если нет — оставить как есть, пометив комментарием;
- тексты ошибок выгрузок (`exports.errors.*`) — из админского словаря, переводятся ключами.

- [ ] **Step 4: Прогон**

```bash
cd tools/production-browser && pnpm --ignore-workspace test:production
```

Expected: все тесты PASS на обеих локалях; 24 EN-кадра.

- [ ] **Step 5: Отсев дрейфа и просмотр** — как в Task 2 Step 5–6.

- [ ] **Step 6: Commit** — `test(shifts): shoot the cabinet shift evidence in both locales`.

---

### Tasks 4–7: Переводы MKR-INS-06, 07, 08, 09

Одна задача на документ: 4 → `cabinet-inventory-prep.ts`, 5 → `cabinet-inventory-close.ts`, 6 → `cabinet-shift-planning.ts`, 7 → `cabinet-shift-close.ts`.

Для каждого документа:

- [ ] **Step 1: Выписать цитаты и ключи**

Пройти по RU-контенту, для каждой «guillemet»-цитаты найти ключ в `ru.json` и взять EN-строку из `en.json`. Строки, которых в словаре нет (доменные каталоги), перевести по факту того, что видно на EN-кадре.

- [ ] **Step 2: Написать `en:`-контент**

По образцу станционных переводов (PR #439): `title`, `summary` с оговоркой об аутентичности русской редакции, те же секции с теми же id, те же image id и порядок шагов, переведённые подписи кадров, «Markiro» вместо «Маркиро», контакты `hello@v-b.tech` без изменений.

- [ ] **Step 3: Линза**

Каждая EN-цитата: есть в `en.json` дословно и видна на EN-кадре своего шага. Отклонения — только в утверждённых классах (параметризованные шаблоны, составные подписи, доменные каталоги); зафиксировать список для отчёта PR.

- [ ] **Step 4: Тесты пакета**

Run: `pnpm --filter @markiro/legal-documents test`
Expected: `content-contract` зелёный. `instruction-assets` для EN начнёт проверяться только после включения ворот (Task 8) — до этого он смотрит лишь `ru`.

- [ ] **Step 5: Commit** — `feat(legal): add the English edition of MKR-INS-0X content`.

---

### Task 8: Публикация

**Files:**

- Modify: `packages/legal-documents/src/registry.ts`, `test/registry.test.ts`, `test/artifact-manifest.test.ts`
- Create: 4 × `apps/landing/src/pages/en/instructions/<slug>/index.astro`
- Modify: `apps/landing/src/lib/legal-artifacts.test.ts`, `apps/landing/test/legal-rendered-page.test.ts`, `apps/landing/test/rendered-page.test.ts`, `apps/landing/src/lib/seo.test.ts`
- Modify: `apps/landing/public/legal/`, `deploy/production/*`

- [ ] **Step 1: Ворота и маршруты**

В `INSTRUCTION_EN_PUBLISHED` добавить `"MKR-INS-06"`, `"MKR-INS-07"`, `"MKR-INS-08"`, `"MKR-INS-09"`; четырём релизам добавить `en`-маршруты из Global Constraints.

- [ ] **Step 2: Тесты реестра**

`legalReleaseLocales` для 06–09 → `["ru","en"]`, для 10 остаётся `["ru"]`; счётчик маршрутов `23` → `27`. В тесте «accepts a Russian-only cabinet instruction release…» заменить код в фикстуре с `MKR-INS-06` на `MKR-INS-10` — единственную оставшуюся ru-only инструкцию.

- [ ] **Step 3: Страницы лендинга**

Четыре страницы по образцу станционных EN-страниц: импорт-карта PNG из `…/mkr-ins-0X/en/`, `getLegalDocumentPage("MKR-INS-0X", "en")`. Глубина импортов — `../../../../`.

- [ ] **Step 4: Перегенерация релиза**

```bash
rm -rf apps/landing/public/legal
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
git status --short apps/landing/public/legal
```

Expected: «Validated 31 immutable legal artifacts»; ровно 4 новых файла и изменённый манифест, старые 27 не тронуты (иначе STOP).

- [ ] **Step 5: Тесты и пины**

`artifact-manifest.test.ts` — +4 EN-записи (ревизии 06/07 `2026.08/03`, 08 `2026.09/01`, 09 `2026.09/02`), счётчики 27→31 и 23→27, +4 строки ожидаемых запросов. `legal-artifacts.test.ts` — 27→31, 23→27, в тесте про ru-only заменить код на MKR-INS-10. `legal-rendered-page.test.ts` — EN-реестр +4 кода, pdfCount en 9→13, shaCount en 11→15. `rendered-page.test.ts` — EN-хаб 5→9. `seo.test.ts` — 63→67.

- [ ] **Step 6: Аттестация**

`releaseId` → `MKR-LEGAL-2026.09-19-<дата генерации>`, новый `manifestSha256`, +4 записи в `pdfs`, +4 имени в `EXPECTED_PDFS`, счётчики deploy-тестов 23→27 и edge-contract 27→31.

- [ ] **Step 7: Прогоны**

```bash
pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing test
node --test deploy/production/test/*.mjs
```

Expected: всё зелёное.

- [ ] **Step 8: Commit** — `feat(legal): publish the English editions of MKR-INS-06..09`.

---

### Task 9: Финальная верификация

- [ ] **Step 1:** `pnpm format:check`, линт пакета и лендинга.
- [ ] **Step 2:** сборка лендинга; проверить, что EN-хаб `/en/instructions/` перечисляет девять инструкций и что четыре новые страницы собрались.
- [ ] **Step 3:** `--check`-сверка релиза (31 файл), дерево чистое.
- [ ] **Step 4:** повторный прогон обеих кабинетных спек — зелёные, RU-кадры не изменились.
- [ ] **Step 5:** отчёт линзы по четырём документам (цитата → ключ → кадр) и список принятых исключений.
