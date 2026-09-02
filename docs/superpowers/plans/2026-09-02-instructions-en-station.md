# EN-версии станционных инструкций MKR-INS-01…05 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Опубликовать EN-версии пяти станционных инструкций: перевод контента, EN-скриншоты из галереи станции, EN-страницы лендинга, +5 EN-PDF в релиз и аттестацию.

**Architecture:** Ворота локалей — точечный Set в `legalReleaseLocales`; ассеты переезжают в `{ru,en}/` подпапки; переводы в `en:`-контенте пяти модулей с линзой по `apps/station/src/i18n/en.json`; хром `InstructionDocument.astro` локализуется картой копий; релиз растёт 21→26 файлов без изменения старых байтов.

**Tech Stack:** TypeScript (ESM), Astro, vitest, Playwright (tools/production-browser, `--ignore-workspace`), LibreOffice 26.2.5 + veraPDF (docker), пиненные IBM Plex (PR #436).

**Spec:** `docs/superpowers/specs/2026-09-02-instructions-en-station-design.md`

## Global Constraints

- Существующие 21 файл релиза (`apps/landing/public/legal/files/*`) остаются байт-в-байт; RU-контент, RU-кадры и ревизии не меняются. Переиздания нет.
- EN-маршруты (точно): 01 `/en/instructions/station-sign-in-and-shift-start/`, 02 `/en/instructions/scanning-and-aggregation-work-cycle/`, 03 `/en/instructions/exceptions-and-recovery/`, 04 `/en/instructions/workstation-setup/`, 05 `/en/instructions/terminal-inventory-count/`.
- EN-цитаты UI — дословно из `apps/station/src/i18n/en.json` и видны на EN-кадре своего шага; EN-текст содержит «Markiro», не содержит «Маркиро».
- Кадры: 01=6, 02=8, 03=8, 04=8, 05=16 (те же image id, что в RU).
- Генерация: `SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)"` + `pnpm --filter @markiro/legal-documents artifacts:generate` / `artifacts:verify`; сверка без публикации — CLI с `--check`.
- Не использовать `git stash`; временные скрипты съёмки — только в `tools/production-browser`, удалить до коммита.
- Перед коммитами: `pnpm format:check` (чинить `pnpm format`).

---

### Task 1: Раскладка ассетов `{ru}/` + локаль в загрузчике

**Files:**

- Move: `packages/legal-documents/assets/instructions/mkr-ins-0[1-9]/*.png` → `…/mkr-ins-0X/ru/*.png` (79 файлов, `git mv`)
- Modify: `packages/legal-documents/src/cli/generate-artifacts.ts` (`loadInstructionImages`)
- Modify: `packages/legal-documents/test/instruction-assets.test.ts`
- Modify: 9 RU-страниц `apps/landing/src/pages/instruktsii/*/index.astro` (пути импортов)

**Interfaces:**

- Produces: `loadInstructionImages(code: LegalDocumentCode, locale: LegalLocale)` читает `assets/instructions/<code>/<locale>/`. Task 9 полагается на per-locale чтение.

- [ ] **Step 1: Переложить RU-кадры**

```bash
for d in packages/legal-documents/assets/instructions/mkr-ins-0*; do
  mkdir "$d/ru" && git mv "$d"/*.png "$d/ru/"
done
git status --short | head -5
```

Expected: 79 renamed-записей.

- [ ] **Step 2: Локаль в загрузчике**

В `generate-artifacts.ts`:

```ts
async function loadInstructionImages(
  code: LegalDocumentCode,
  locale: LegalLocale,
): Promise<ReadonlyMap<string, Uint8Array> | undefined> {
  if (legalDocumentKind(code) !== "instruction") return undefined;
  const directory = path.join(INSTRUCTION_ASSETS_ROOT, code.toLowerCase(), locale);
  // …остальное без изменений…
```

Вызов в `createDefaultDependencies().renderDocx`: `loadInstructionImages(request.code, request.locale)`. Сообщение об отсутствии: включить локаль (`Instruction assets are missing for ${code}/${locale}`).

- [ ] **Step 3: Пер-локальный тест ассетов**

В `instruction-assets.test.ts` заменить one-shot сверку на итерацию локалей:

```ts
const localeCases = instructionReleases.flatMap(({ code }) =>
  legalReleaseLocales(code).map((locale) => ({ code, locale })),
);

it.each(localeCases)(
  "keeps $code/$locale content image ids and asset files in sync",
  ({ code, locale }) => {
    const content = requireLegalContent(findLegalDocument(code), locale);
    // …как раньше, но readdirSync(path.join(ASSETS_ROOT, code.toLowerCase(), locale))
  },
);
```

(`legalReleaseLocales` добавить в импорт из `../src/index.js`.)

- [ ] **Step 4: Прочие читатели путей**

```bash
grep -rn "assets/instructions" packages apps --include="*.ts" --include="*.tsx" --include="*.astro" -l
```

Всех найденных (ожидаются: сам генератор, тест ассетов, 9 страниц `instruktsii/*/index.astro`) перевести на `…/mkr-ins-0X/ru/<id>.png`. Для страниц:

```bash
sed -i '' -E 's#(assets/instructions/mkr-ins-0[0-9]+)/#\1/ru/#' apps/landing/src/pages/instruktsii/*/index.astro
```

- [ ] **Step 5: Прогнать тесты и сборку**

Run: `pnpm --filter @markiro/legal-documents build && pnpm --filter @markiro/legal-documents test && pnpm --filter @markiro/landing test`
Expected: всё PASS (ворота ещё ru-only, en-подпапок нет — тест их не требует).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(legal): move instruction frames into per-locale ru/ directories"
```

---

### Task 2: Утечки RU в фикстурах галереи

**Files:**

- Modify: `apps/station/src/dev/StationScreenGallery.tsx`

**Interfaces:**

- Produces: EN-рендер галереи без русских литералов в данных; RU-ветки дословно прежние (RU-кадры не меняются).

- [ ] **Step 1: Локализовать литералы**

`InventoryFixture` получает `locale: GalleryLocale` (передать из рендера состояния — образец `FloorHeaderFixture`), внутри `const ru = locale === "ru";`. Заменить:

- `productName: "Вода питьевая 0,5 л / Drinking water 0.5 L"` → `ru ? "Вода питьевая 0,5 л / Drinking water 0.5 L" : "Drinking water 0.5 L"`
- `productPrintName: "Вода 0,5 л"` → `ru ? "Вода 0,5 л" : "Water 0.5 L"`
- `lineName: "Тестовая линия А"` (в `GALLERY_INVENTORY_TASK` — сделать функцией/выбором от locale) → `ru ? "Тестовая линия А" : "Test line A"`
- `currentLineName="Тестовая линия А"` → `ru ? "Тестовая линия А" : "Test line A"`; `"Тестовая линия Б"` → `ru ? "Тестовая линия Б" : "Test line B"`
- `deviceId: "ТЕРМИНАЛ-02"` → `ru ? "ТЕРМИНАЛ-02" : "TERMINAL-02"`

- [ ] **Step 2: Тесты станции**

Run: `pnpm --filter @markiro/station test`
Expected: PASS.

- [ ] **Step 3: Контракт галереи (обе локали)**

```bash
pnpm --dir tools/production-browser --ignore-workspace exec playwright test station-inventory-tests/gallery.spec.ts
```

Expected: PASS (4 теста; RU-пины, включая «Продолжить INVENTORY-26-0047», не задеты).

- [ ] **Step 4: Commit**

```bash
git add apps/station && git commit -m "fix(station): localize the remaining Russian literals in gallery fixtures"
```

---

### Task 3: Съёмка 46 EN-кадров

**Files:**

- Create: `packages/legal-documents/assets/instructions/mkr-ins-0{1..5}/en/*.png` (6+8+8+8+16)
- Временный скрипт в `tools/production-browser` (удалить до коммита)

Соответствие кадр→`state=` (из RU-съёмок; `locale=en`):

- **01**: login-badge, login-pin, login-name-search — одноимённые; shift-select→`shift-page-1`; new-shift→`new-shift-input`; work-start→`work-validation`.
- **02**: box-full, offline, print-verification, work-aggregation — одноимённые; scan-duplicate→`work-duplicate`; scan-error→`work-error`; scan-ok→`work-ok`; work-scan-wait→`work-validation`.
- **03**: exception-* и print-mismatch — одноимённые; box-print-failed→`box-print-transport-failed`; conflicts→`conflicts-page-1`.
- **04**: все восемь одноимённые (pairing-waiting, pairing-success, setup-scanner, setup-printer, setup-sound, update-current, update-warn, update-active-shift).
- **05**: состояния `inventory-*` — точную пару кадр→state взять из таблицы соответствия в плане MKR-INS-05 (`docs/superpowers/plans/2026-08-2*-mkr-ins-05*.md`) и `INVENTORY_GALLERY_STATE_IDS` в `apps/station/src/dev/gallery-fixtures.ts` (пример: repack-old-box→`inventory-repack-awaiting-old-box`).

- [ ] **Step 1: Дев-сервер станции** — preview_start конфигом станции (порт 5273).

- [ ] **Step 2: Скрипт съёмки** — временный `tools/production-browser/shoot-en.mjs` по образцу прошлых съёмок: для каждой пары (dir, frame, state) открыть `http://localhost:5273/?gallery=1&state=<state>&locale=en`, дождаться `[data-testid="station-screen-gallery"]` + settle (rAF, шрифты, отключить каретку/скроллбары), снять контейнер галереи в `…/mkr-ins-0X/en/<frame>.png`.

- [ ] **Step 3: Прогнать и проверить количество**

```bash
for d in packages/legal-documents/assets/instructions/mkr-ins-0{1,2,3,4,5}; do echo "$d/en: $(ls "$d/en" | wc -l)"; done
```

Expected: 6/8/8/8/16.

- [ ] **Step 4: Визуальная сверка** — открыть каждый EN-кадр (Read), убедиться: интерфейс английский, состояние соответствует RU-аналогу, нет русских строк данных (кроме легитимных: номера смен `AUG26-…`, ФИО в ростере — ростер локализован, проверить).

- [ ] **Step 5: Удалить скрипт, закоммитить кадры**

```bash
rm tools/production-browser/shoot-en.mjs
git add packages/legal-documents/assets && git commit -m "feat(legal): capture English gallery frames for MKR-INS-01..05"
```

---

### Tasks 4–8: Переводы MKR-INS-01…05 (по одному документу на задачу)

**Files (на задачу):**

- Modify: соответствующий модуль `packages/legal-documents/src/documents/…`:
  4→`station-operator-shift.ts`, 5→`station-work-cycle.ts`, 6→`station-exceptions.ts`, 7→`station-workstation-setup.ts`, 8→`station-inventory-count.ts`

Для каждого документа:

- [ ] **Step 1: Выписать RU-цитаты** — все «guillemet»-цитаты RU-контента и их ключи в `apps/station/src/i18n/ru.json`; для каждого ключа взять EN-строку из `en.json` (дословно).

- [ ] **Step 2: Написать `en:`-контент** — полный перевод (title, summary, все секции), те же image id и порядок шагов, подписи кадров переведены, плашка о демо-данных переведена, «Markiro» вместо «Маркиро», e-mail hello@v-b.tech без изменений.

- [ ] **Step 3: Линза** — каждая EN-цитата: (а) есть в `en.json` дословно (скриптовая проверка вхождения), (б) видна на EN-кадре шага (Read кадра). Отклонения — только в утверждённых классах исключений; зафиксировать список для отчёта PR.

- [ ] **Step 4: Тесты пакета**

Run: `pnpm --filter @markiro/legal-documents test`
Expected: PASS (content-contract подхватывает en-контент автоматически; ассет-тест en ещё не требует — ворота не переключены).

- [ ] **Step 5: Commit** — `feat(legal): add the English edition of MKR-INS-0X content`.

---

### Task 9: Публикация — ворота, маршруты, артефакты, аттестация

**Files:**

- Modify: `packages/legal-documents/src/registry.ts` (Set + 5 `en`-маршрутов)
- Modify: `packages/legal-documents/test/registry.test.ts` (локали 01–05 → `["ru","en"]`)
- Modify: `packages/legal-documents/test/artifact-manifest.test.ts` (+5 EN-записей в фикстуры, счётчики)
- Modify: `apps/landing/public/legal/` (5 новых PDF + artifacts.json)
- Modify: `apps/landing/src/lib/legal-artifacts.test.ts` (21→26, 17→22; EN-rejection фикстура → MKR-INS-06)
- Modify: `deploy/production/legal-artifacts-attestation.json`, `verify-legal-artifacts.mjs`, `test/legal-artifact-attestation.test.mjs`

- [ ] **Step 1: Ворота + маршруты** — Set `INSTRUCTION_EN_PUBLISHED` (код из спека) + `en`-маршруты пяти релизов из Global Constraints.

- [ ] **Step 2: Тесты реестра** — обновить пины `legalReleaseLocales` (01–05 en, 06–09 ru); прогнать пакетные тесты, убедиться что падают ТОЛЬКО ожидаемые (манифест: 26≠21) до перегенерации.

- [ ] **Step 3: Перегенерация релиза**

```bash
rm -rf apps/landing/public/legal
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
git status --short apps/landing/public/legal | grep -cv "^??"
```

Expected: «Validated 26 immutable legal artifacts»; git-статус: ровно 5 untracked PDF + modified artifacts.json; НИ ОДИН из 21 старых файлов не modified (иначе STOP — RU-байты изменились, разбираться).

- [ ] **Step 4: Verify + манифестные тесты** — `artifacts:verify` (26); обновить фикстуры `artifact-manifest.test.ts` (+5 EN-записей по образцу существующих ru-инструкций: locale "en", имена `markiro_mkr-ins-0X_<rev>_en.pdf`) и счётчики; лендинг-тест: 26/22/4 и EN-rejection → MKR-INS-06 (имя файла в фикстуре `markiro_mkr-ins-06_2026.08-03_en.pdf`).

- [ ] **Step 5: Аттестация** — по процедуре прошлых переизданий: в `legal-artifacts-attestation.json` +5 записей (имя+sha из artifacts.json), новый releaseId по текущей конвенции (посмотреть текущий), новый manifestSha (`shasum -a 256 apps/landing/public/legal/artifacts.json`); `EXPECTED_PDFS` в `verify-legal-artifacts.mjs` +5 имён (лексикографический порядок); счётчики в `test/legal-artifact-attestation.test.mjs`; прогнать `node --test deploy/production/test/`.

- [ ] **Step 6: Полный прогон пакетов** — legal-documents + landing тесты PASS; commit `feat(legal): publish the English editions of MKR-INS-01..05`.

---

### Task 10: Лендинг — хром, EN-страницы, реестр

**Files:**

- Modify: `apps/landing/src/components/InstructionDocument.astro`
- Create: 5 × `apps/landing/src/pages/en/instructions/<slug>/index.astro`
- Modify: `apps/landing/src/components/LegalRegistry.astro`

- [ ] **Step 1: Карта копий хрома** — в frontmatter `InstructionDocument.astro`:

```ts
const chrome = {
  ru: {
    registry: "← Реестр документов",
    registryPath: "/legal/",
    active: "Действует",
    code: "Код",
    revision: "Редакция",
    effectiveFrom: "Действует с",
    toc: "Содержание",
    warning: "Важно",
    note: "Примечание",
    step: "Шаг",
    expected: "Ожидаемый результат:",
    operatorContacts: "Контакты оператора",
  },
  en: {
    registry: "← Document registry",
    registryPath: "/en/legal/",
    active: "In force",
    code: "Code",
    revision: "Revision",
    effectiveFrom: "Effective from",
    toc: "Contents",
    warning: "Important",
    note: "Note",
    step: "Step",
    expected: "Expected result:",
    operatorContacts: "Operator contacts",
  },
}[page.locale];
```

Заменить все русские литералы разметки на `{chrome.…}` (включая `aria-label={chrome.toc}` / `aria-label={chrome.operatorContacts}` и `Шаг {n}.` → `{chrome.step} {n}.`).

- [ ] **Step 2: Пять EN-страниц** — по образцу RU (пример 01):

```astro
---
import loginBadge from "@markiro/legal-documents/assets/instructions/mkr-ins-01/en/login-badge.png?url";
/* …остальные 5 импортов… */
import { getLegalDocumentPage } from "../../../../content/legal-pages";
import InstructionDocument from "../../../../components/InstructionDocument.astro";

const images = { "login-badge": loginBadge /* … */ };
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-01", "en")} images={images} />
```

(Глубина `../../../../` — на один уровень больше RU-страниц.)

- [ ] **Step 3: Реестр** — в `LegalRegistry.astro` фильтр инструкций: вместо «только ru» — `legalReleaseLocales(release.code).includes(metadata.locale)`; ссылка `release.routes[metadata.locale]`, описание своей локали из `DESCRIPTION_BY_CODE`; заголовок секции инструкций — локализовать по образцу остального компонента (посмотреть, как он локализует другие заголовки).

- [ ] **Step 4: Сборка и тесты**

Run: `pnpm --filter @markiro/landing test && pnpm --filter @markiro/landing build`
Expected: тесты PASS; build успешен (все `/en/instructions/*` собраны).

- [ ] **Step 5: Commit** — `feat(landing): serve the English station instructions`.

---

### Task 11: Финальная верификация

- [ ] **Step 1**: `pnpm format:check` (чинить `pnpm format`), `pnpm --filter @markiro/legal-documents lint`, `pnpm --filter @markiro/landing lint` (если есть).
- [ ] **Step 2**: полные тесты: legal-documents, landing, station; контракт галереи ещё раз (обе локали).
- [ ] **Step 3**: `--check`-сверка релиза (26 байт-в-байт), `git status` чист.
- [ ] **Step 4**: собрать отчёт линзы (цитаты/ключи/кадры/исключения) для PR.
