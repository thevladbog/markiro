# MKR-INS-04 «Настройка рабочего места» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Финальная инструкция серии — MKR-INS-04 «Станция сканирования: настройка рабочего места» (аудитория — наладчик): RU-страница + PDF/A-артефакт с аттестацией.

**Architecture:** Контентная итерация по конвейеру MKR-INS-01…03. Четыре задачи: аудит фикстур `pairing-*`/`setup-*`/`update-*` + скриншоты → контент + реестр + CLI → лендинг → артефакт + аттестация. Финальному whole-branch ревью задаётся явная линза «текст ↔ скриншоты ↔ i18n» (урок MKR-INS-03: две Critical-ошибки печатного документа видны только на этом уровне).

**Tech Stack:** TypeScript (ESM), Astro, Vitest, node:test, LibreOffice 26.2.5 + veraPDF 1.30.2 (docker), Playwright MCP.

**Спека:** `docs/superpowers/specs/2026-08-22-mkr-ins-04-workstation-setup-design.md`. Ветка: `claude/mkr-ins-04-workstation-setup` (от origin/main, включает MKR-INS-01…03).

## Global Constraints

- Код `MKR-INS-04`, ревизия `2026.08/01`, effectiveDate `2026-08-22`, статус `active`, RU-only.
- Маршрут: `/instruktsii/nastroyka-rabochego-mesta/`. Артефакт: `markiro_mkr-ins-04_2026.08-01_ru.pdf`, kind `pdfa-2b`.
- Аттестация: release id `MKR-LEGAL-2026.08-04-2026-08-22`; прежние 15 файлов в `apps/landing/public/legal` байт-в-байт.
- Аудитория — наладчик/администратор (текст назначения это фиксирует); сервисные потоки — кратко, без шагов; кабинетская часть привязки — текстом, без скринов админки.
- Цитаты интерфейса — строго из `apps/station/src/i18n/ru.json` (секции `enroll`, `setup`, `updates`, `work`).
- Генераторы: docx 9.7.1, LibreOffice 26.2.5, veraPDF 1.30.2; TTF IBM Plex установлены.
- Prettier `--write` только на затронутые файлы; этот план уже в `.prettierignore`.
- Vitest-фильтр: `pnpm --filter <pkg> exec vitest run <path>`. Коммиты с трейлером `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Аудит фикстур pairing/setup/updates и восемь скриншотов

**Files:**
- Possibly modify: `apps/station/src/dev/StationScreenGallery.tsx`, `apps/station/src/dev/gallery-fixtures.ts`, `apps/station/test/screen-gallery.test.tsx` (только при расхождении с реальным UI)
- Create: `packages/legal-documents/assets/instructions/mkr-ins-04/{pairing-waiting,pairing-success,setup-scanner,setup-printer,setup-sound,update-current,update-warn,update-active-shift}.png`

**Interfaces:**
- Consumes: dev-галерея `http://localhost:5273/?gallery=1&state=<id>&locale=ru`.
- Produces: восемь PNG 1280×800; id = имя файла без `.png` (ссылки контента Task 2).

Соответствие файлов состояниям галереи:

| Файл | `state=` | Что должно быть на экране |
| --- | --- | --- |
| pairing-waiting.png | `pairing-waiting` | «Подключение станции»: клавиатура кода, «Введите восьмизначный код из кабинета или отсканируйте его настроенным сканером», три шага |
| pairing-success.png | `pairing-success` | «Станция подключена» |
| setup-scanner.png | `setup-scanner` | «Настройка рабочего места» → блок «Сканер»: порт, «Скорость (бод)», «Подключить сканер» |
| setup-printer.png | `setup-printer` | Блок «Принтер»: «Подключение принтера» (Без принтера / Сеть (TCP) / COM-порт / Windows (USB)), «Язык принтера», «Тестовая печать», галка «Проверять каждую распечатанную этикетку сканированием» |
| setup-sound.png | `setup-sound` | Блок «Звук» |
| update-current.png | `update-current` | «Обновления станции»: «На станции установлена актуальная версия.» |
| update-warn.png | `update-warn` | Доступная версия + «Релиз вышел более 7 дней назад», «Скачать и установить» |
| update-active-shift.png | `update-active-shift` | Блокер «Завершите активную смену перед установкой» |

- [ ] **Step 1: Сверить фикстуры с реальным UI**

Прочитать реальные компоненты: `apps/station/src/pages/Enrollment.tsx`, `apps/station/src/pages/WorkstationSetup.tsx`, `apps/station/src/pages/UpdateCenter.tsx` (и как App.tsx их монтирует; хром FloorShell/StationScreen), затем фикстуры `PairingFixture`/`SetupFixture`/`UpdatesFixture` (или как они называются) в `StationScreenGallery.tsx`. Для каждого из восьми состояний — диф-лист «реальный экран vs фикстура». Эти состояния НЕ аудировались; прецеденты починок: `git show bf183bc14 16c171345 859cf17d7 438670bbf -- apps/station/src/dev` (re-platforming на реальные компоненты с синтетическими пропсами, общий предикат хрома).

- [ ] **Step 2: Починить расхождения (если есть)**

Реальные компоненты + синтетические данные (Демо-станция 01, версии вида 1.4.2, admin.markiro.app из i18n). Продакшен-код не менять (максимум export) — иначе BLOCKED. Нет расхождений — зафиксировать в отчёте.

- [ ] **Step 3: Гейты станции (если менялись фикстуры)**

Run: `pnpm --filter @markiro/station typecheck && pnpm --filter @markiro/station lint && pnpm --filter @markiro/station test`
Expected: всё PASS; prettier на изменённые файлы.

- [ ] **Step 4: Снять скриншоты**

```bash
mkdir -p packages/legal-documents/assets/instructions/mkr-ins-04
```

`pnpm --filter @markiro/station dev` в фоне (порт 5273, дождаться 200). Для каждой строки таблицы: Playwright MCP `browser_resize` 1280×800 → `browser_navigate` → дождаться отрисовки → `browser_take_screenshot` (png) → скопировать в целевой файл; retina → `sips -Z 1280`. Сервер убить.

- [ ] **Step 5: Проверить результат**

Run: `file packages/legal-documents/assets/instructions/mkr-ins-04/*.png`
Expected: восемь `PNG image data, 1280 x 800`, каждый < 600 KB. Открыть каждый через Read и сверить с колонкой таблицы; пустые/loading переснять.

- [ ] **Step 6: Commit**

```bash
git add apps/station packages/legal-documents/assets/instructions/mkr-ins-04
git commit -m "feat(legal-documents): MKR-INS-04 workstation setup screenshots from station gallery"
```

(Фикстурные починки — отдельным первым коммитом `fix(station): sync setup gallery fixtures with the current UI`.)

---

### Task 2: Пакет — код MKR-INS-04, контент, релиз, CLI-перечисления

**Files:**
- Modify: `packages/legal-documents/src/types.ts`, `packages/legal-documents/src/registry.ts`, `packages/legal-documents/src/cli/verify-artifacts.ts`
- Create: `packages/legal-documents/src/documents/station-workstation-setup.ts`
- Test: `packages/legal-documents/test/registry.test.ts`, `packages/legal-documents/test/artifact-manifest.test.ts`

**Interfaces:**
- Consumes: PNG-ассеты Task 1 (восемь id из таблицы Task 1); helpers `legalDocumentKind`/`legalReleaseLocales`/`requireLegalContent`, блоки `step`/`callout`.
- Produces: `STATION_WORKSTATION_SETUP_CONTENT`; активный релиз `MKR-INS-04/2026.08/01` с маршрутом `/instruktsii/nastroyka-rabochego-mesta/`; `artifactFileName(...)` → `markiro_mkr-ins-04_2026.08-01_ru.pdf`.

- [ ] **Step 1: Базовая линия**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/instruction-assets.test.ts`
Expected: PASS (MKR-INS-04 ещё не зарегистрирован); после Step 2–3 тест обязан пройти уже с четырьмя инструкциями.

- [ ] **Step 2: Типы, реестр, CLI**

1. `types.ts`: в union `LegalDocumentCode` добавить `"MKR-INS-04"` (prettier сам перенесёт строку при >100 символов).
2. `registry.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-04"`; `LEGAL_DOCUMENT_KIND_BY_CODE` + `"MKR-INS-04": "instruction",`; импорт `STATION_WORKSTATION_SETUP_CONTENT` из `./documents/station-workstation-setup.js`; в `LEGAL_RELEASES` последним:

```ts
  {
    code: "MKR-INS-04",
    revision: "2026.08/01",
    effectiveDate: "2026-08-22",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/nastroyka-rabochego-mesta/" },
  },
```

и в `LEGAL_DOCUMENTS`:

```ts
  { releaseKey: "MKR-INS-04/2026.08/01", content: STATION_WORKSTATION_SETUP_CONTENT },
```

3. `verify-artifacts.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-04"`; `SAFE_FILE_NAME` → `ins-0[1234]`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-01|pd-02|dpa-01|brd-01|ins-0[1234])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 3: Контент**

Создать `packages/legal-documents/src/documents/station-workstation-setup.ts`:

```ts
import type { LegalDocumentSource } from "../types.js";

export const STATION_WORKSTATION_SETUP_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: настройка рабочего места",
    summary:
      "Инструкция наладчика: привязка станции к кабинету, подключение сканера и принтера, звук и обновления станции.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция предназначена для наладчика или администратора и описывает подготовку рабочего места станции сканирования: привязку станции к кабинету, подключение сканера и принтера этикеток, звук и обновления. Выполняется при вводе нового рабочего места в строй или при замене оборудования.",
          },
          {
            kind: "paragraph",
            text: "Ежедневная работа оператора описана в отдельных инструкциях: вход и старт смены (MKR-INS-01), рабочий цикл (MKR-INS-02), исключения (MKR-INS-03).",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Адреса, номера версий и названия на вашей станции будут отличаться.",
          },
        ],
      },
      {
        id: "pairing",
        heading: "2. Привязка станции",
        blocks: [
          {
            kind: "step",
            title: "Создайте код подключения в кабинете",
            text: "Откройте страницу станции в кабинете администратора и создайте восьмизначный код подключения для этой линии. Код одноразовый и действует ограниченное время.",
          },
          {
            kind: "step",
            title: "Введите код на станции",
            text: "На экране «Подключение станции» введите восьмизначный код из кабинета или отсканируйте его настроенным сканером и нажмите «Подключить станцию». Станция покажет «Подключаем…» — идёт проверка кода и загрузка настроек.",
            image: { id: "pairing-waiting", caption: "Экран «Подключение станции»: ввод кода из кабинета" },
            expected: "Станция показала «Станция подключена».",
          },
          {
            kind: "step",
            title: "Перейдите к настройке оборудования",
            text: "После подтверждения нажмите «Настройка оборудования» и настройте сканер, принтер и звук (разделы 3–5).",
            image: { id: "pairing-success", caption: "Станция подключена к кабинету" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если станция сообщает «Этот код подключения недействителен» или «Срок действия кода подключения истёк» — создайте новый код подключения в кабинете и введите его здесь. Старый код повторно не сработает.",
          },
        ],
      },
      {
        id: "scanner",
        heading: "3. Сканер",
        blocks: [
          {
            kind: "step",
            title: "Подключите и проверьте сканер",
            text: "В блоке «Сканер» выберите порт и «Скорость (бод)» по паспорту сканера, затем нажмите «Подключить сканер». Станция откроет подключение и попросит отсканировать любой код для проверки — дождитесь сообщения «Проверка сканера пройдена». Поле «Последний скан» показывает принятые данные.",
            image: { id: "setup-scanner", caption: "Настройка сканера: порт, скорость, проверка тест-сканом" },
            expected: "«Проверка сканера пройдена», последний скан отображается.",
          },
          {
            kind: "paragraph",
            text: "Если сканер работает в режиме клавиатуры (эмуляция ввода), выберите «Без последовательного сканера (клавиатурный)» — порт и скорость в этом режиме не настраиваются.",
          },
        ],
      },
      {
        id: "printer",
        heading: "4. Принтер",
        blocks: [
          {
            kind: "step",
            title: "Выберите подключение принтера",
            text: "В блоке «Принтер» укажите «Подключение принтера»: «Сеть (TCP)» — адрес и TCP-порт принтера; «COM-порт» — порт и скорость; «Windows (USB)» — выберите установленный принтер Windows из списка (кнопка «Обновить список» перечитывает его). Затем выберите «Язык принтера» — ZPL или TSPL, по документации принтера. Если на этом рабочем месте этикетки не печатают, оставьте «Без принтера».",
            image: { id: "setup-printer", caption: "Настройка принтера: подключение, язык, тестовая печать" },
          },
          {
            kind: "step",
            title: "Сделайте тестовую печать",
            text: "Нажмите «Тестовая печать» и убедитесь, что этикетка физически вышла из принтера и пропечатана читаемо. Сообщение «Тестовая этикетка отправлена на принтер» подтверждает только отправку — результат проверяйте на самой этикетке.",
            expected: "Тестовая этикетка напечатана и читается.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Флажок «Проверять каждую распечатанную этикетку сканированием» включает обязательную сверку этикетки короба после печати (описана в инструкции по рабочему циклу). Рекомендуется держать включённым на местах агрегации.",
          },
        ],
      },
      {
        id: "sound",
        heading: "5. Звук",
        blocks: [
          {
            kind: "step",
            title: "Включите звук станции",
            text: "В блоке «Звук» включите звуковые сигналы. Операторы на линии полагаются на звук вердиктов сканирования — без него легко пропустить дубль или ошибку, не глядя на экран.",
            image: { id: "setup-sound", caption: "Настройка звука станции" },
          },
        ],
      },
      {
        id: "updates",
        heading: "6. Обновления станции",
        blocks: [
          {
            kind: "step",
            title: "Проверьте версию станции",
            text: "Откройте «Обновления станции» (индикатор «Обновления» на экране выбора смены) и нажмите «Проверить обновления». Если версия актуальна, станция сообщит: «На станции установлена актуальная версия.»",
            image: { id: "update-current", caption: "Центр обновлений: версия актуальна" },
          },
          {
            kind: "step",
            title: "Установите доступное обновление",
            text: "Если доступна новая версия, станция показывает её возраст: «Релиз вышел недавно», «Релиз вышел более 7 дней назад» или «Релиз вышел более 30 дней назад; обновите при удобном случае». Нажмите «Скачать и установить» и подтвердите — версия будет скачана, затем станция перезапустится. Обновление выполняется только вручную.",
            image: { id: "update-warn", caption: "Доступно обновление: возраст релиза и установка" },
            expected: "Станция перезапустилась на новой версии.",
          },
          {
            kind: "step",
            title: "Не обновляйте станцию во время смены",
            text: "При активной смене установка заблокирована: «Завершите активную смену перед установкой». Дождитесь закрытия смены оператором; неотправленные операции тоже должны уйти на сервер.",
            image: { id: "update-active-shift", caption: "Установка заблокирована активной сменой" },
          },
        ],
      },
      {
        id: "service",
        heading: "7. Сервисные операции",
        blocks: [
          {
            kind: "paragraph",
            text: "«Повторная привязка станции» используется только когда сервисному пользователю нужно повторно привязать эту же станцию: ключ устройства будет удалён, локальные производственные записи останутся на станции. «Сервисное подключение» — отдельный путь с учётными данными от сервиса; он не заменяет обычное подключение кодом.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Обе операции — редкие и выполняются только вместе с поддержкой Маркиро. Не запускайте их для решения обычных проблем со связью или оборудованием.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "8. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "У сканера или принтера подпись «настроен, не обнаружен»",
                detail: "Сохранённое устройство не найдено на этой машине: проверьте кабель и питание, затем заново выберите порт или принтер в настройке.",
              },
              {
                term: "Установленные принтеры Windows не найдены",
                detail: "Установите драйвер принтера средствами Windows, затем нажмите «Обновить список» в блоке «Принтер».",
              },
              {
                term: "Тестовая этикетка не вышла",
                detail: "Сообщение об отправке не гарантирует печать. Проверьте адрес/порт подключения, язык принтера (ZPL/TSPL по документации) и ленту, затем повторите «Тестовая печать».",
              },
              {
                term: "Срок действия кода подключения истёк",
                detail: "Коды одноразовые и ограничены по времени. Создайте новый код в кабинете администратора и введите его на станции.",
              },
              {
                term: "Нужно перенести станцию на другую линию",
                detail: "Обратитесь в поддержку Маркиро — самостоятельная повторная привязка без сопровождения не рекомендуется.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "Если проблема не описана выше, обратитесь в поддержку Маркиро: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
```

Примечание для исполнителя: перед коммитом свериться с фактическими экранами Task 1 — точные подписи блоков и кнопок в контенте обязаны совпадать с i18n (`enroll.*`, `setup.*`, `updates.*`); если реальный экран называет что-то иначе (например, вход в центр обновлений), поправить формулировку по факту и зафиксировать в отчёте.

- [ ] **Step 4: Pinned-тесты пакета**

1. `test/registry.test.ts`: pinned-список кодов + `"MKR-INS-04"`; счётчик маршрутов 11 → 12.
2. `test/artifact-manifest.test.ts`: фикстурная запись MKR-INS-04 (`ru`/`pdfa-2b`, файл `markiro_mkr-ins-04_2026.08-01_ru.pdf`, effectiveDate `2026-08-22` в per-code ветвлении `artifactEntry()`); счётчики 15 → 16 записей, PDF 11 → 12.
Править по фактическим падениям, не ослабляя.

- [ ] **Step 5: Гейты пакета**

Run: `pnpm --filter @markiro/legal-documents test && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents lint`
Expected: всё PASS (instruction-assets — четыре инструкции). Prettier на затронутые файлы.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal-documents): MKR-INS-04 workstation setup instruction content"
```

---

### Task 3: Лендинг — страница и перечисления

**Files:**
- Modify: `apps/landing/src/content/legal-pages.ts`, `apps/landing/src/lib/legal-artifacts.ts`
- Create: `apps/landing/src/pages/instruktsii/nastroyka-rabochego-mesta/index.astro`
- Test: `apps/landing/src/lib/legal-artifacts.test.ts`, `apps/landing/src/lib/seo.test.ts`, `apps/landing/test/legal-rendered-page.test.ts` (по фактическим падениям)

**Interfaces:**
- Consumes: релиз/контент Task 2; `InstructionDocument.astro` (`{ page, images: Record<string, string> }`).
- Produces: страница `/instruktsii/nastroyka-rabochego-mesta/`; загрузчик принимает `ins-04`.

- [ ] **Step 1: Базовая линия падений**

Run: `pnpm --filter @markiro/landing test`
Expected: FAIL — `DESCRIPTION_BY_CODE` без MKR-INS-04 (satisfies), pinned-счётчики, completeness против реального `public/legal` (красный до Task 4 вместе с build-зависимыми сьютами).

- [ ] **Step 2: `DESCRIPTION_BY_CODE`**

```ts
  "MKR-INS-04": {
    ru: "Печатная инструкция наладчика: привязка станции к кабинету, подключение сканера и принтера, звук и обновления станции.",
    en: "Printable technician instruction: pairing the station with the cabinet, connecting the scanner and printer, sound, and station updates.",
  },
```

- [ ] **Step 3: Страница**

Создать `apps/landing/src/pages/instruktsii/nastroyka-rabochego-mesta/index.astro` (зеркало соседних страниц в `apps/landing/src/pages/instruktsii/`):

```astro
---
import pairingWaiting from "@markiro/legal-documents/assets/instructions/mkr-ins-04/pairing-waiting.png?url";
import pairingSuccess from "@markiro/legal-documents/assets/instructions/mkr-ins-04/pairing-success.png?url";
import setupScanner from "@markiro/legal-documents/assets/instructions/mkr-ins-04/setup-scanner.png?url";
import setupPrinter from "@markiro/legal-documents/assets/instructions/mkr-ins-04/setup-printer.png?url";
import setupSound from "@markiro/legal-documents/assets/instructions/mkr-ins-04/setup-sound.png?url";
import updateCurrent from "@markiro/legal-documents/assets/instructions/mkr-ins-04/update-current.png?url";
import updateWarn from "@markiro/legal-documents/assets/instructions/mkr-ins-04/update-warn.png?url";
import updateActiveShift from "@markiro/legal-documents/assets/instructions/mkr-ins-04/update-active-shift.png?url";

import { getLegalDocumentPage } from "../../../content/legal-pages";
import InstructionDocument from "../../../components/InstructionDocument.astro";

const images = {
  "pairing-waiting": pairingWaiting,
  "pairing-success": pairingSuccess,
  "setup-scanner": setupScanner,
  "setup-printer": setupPrinter,
  "setup-sound": setupSound,
  "update-current": updateCurrent,
  "update-warn": updateWarn,
  "update-active-shift": updateActiveShift,
};
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-04", "ru")} images={images} />
```

- [ ] **Step 4: Загрузчик артефактов**

`apps/landing/src/lib/legal-artifacts.ts`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01|ins-0[1234])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 5: Pinned-тесты лендинга**

Ожидаемая арифметика (править по фактическим падениям; расхождение — investigate):
- `legal-artifacts.test.ts`: запись MKR-INS-04; 15 → 16 всего, `pdfa-2b` 11 → 12, `template-docx` 4.
- `legal-rendered-page.test.ts`: список кодов + MKR-INS-04; `/legal/`: PDF 7 → 8, SHA 9 → 10; `/en/legal/` без изменений.
- `seo.test.ts`: sitemap 36 → 38.

- [ ] **Step 6: Гейты лендинга**

Run: `pnpm --filter @markiro/landing test && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing lint`
Expected: PASS, кроме известных красных (completeness + build-зависимые — до Task 4). Build не запускать. Prettier на затронутые файлы.

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src apps/landing/test
git commit -m "feat(landing): MKR-INS-04 workstation setup instruction page"
```

---

### Task 4: Артефакт, аттестация, полные гейты

**Files:**
- Modify (генерируется): `apps/landing/public/legal/artifacts.json`; Create: `apps/landing/public/legal/files/markiro_mkr-ins-04_2026.08-01_ru.pdf`
- Modify: `deploy/production/legal-artifacts-attestation.json`, `deploy/production/verify-legal-artifacts.mjs`
- Test: `deploy/production/test/legal-artifact-attestation.test.mjs`, `deploy/production/test/edge-contract.test.mjs`

**Interfaces:**
- Consumes: задачи 1–3; тулчейн SOFFICE_BIN=/opt/homebrew/bin/soffice, VERAPDF_CONTAINER_RUNTIME=docker (sandbox off для docker-команд; таймауты до 600000 мс). Прецедент аттестации: `git show f26f1d3f1 3c2b11320 -- deploy/production`.
- Produces: набор из 16 артефактов; аттестация `MKR-LEGAL-2026.08-04-2026-08-22`.

- [ ] **Step 1: Генерация**

Удалить `apps/landing/public/legal` целиком, затем:

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
```

- [ ] **Step 2: Гейт детерминизма**

`git status --porcelain apps/landing/public/legal` → ТОЛЬКО artifacts.json (M) + новый PDF (A); diff манифеста — одна вставка, старые хеши нетронуты. Иначе restore + BLOCKED с `pdffonts`.

- [ ] **Step 3: Верификация и просмотр**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: `Verified 16 immutable legal artifacts`. Read PDF (страницы 1–5): титул «Станция сканирования: настройка рабочего места», шапка «РАБОЧАЯ ИНСТРУКЦИЯ · MKR-INS-04», 8 скриншотов с подписями, «Шаг N.», < 12 MiB.

- [ ] **Step 4: Аттестация**

1. `shasum -a 256 apps/landing/public/legal/artifacts.json apps/landing/public/legal/files/markiro_mkr-ins-04_2026.08-01_ru.pdf`
2. `legal-artifacts-attestation.json`: `releaseId` → `"MKR-LEGAL-2026.08-04-2026-08-22"`, `manifestSha256` → новый, запись ins-04 после ins-03 (лексикографический порядок), фактический sha256.
3. `verify-legal-artifacts.mjs`: `RELEASE_ID` → тот же id; `EXPECTED_PDFS` + `"markiro_mkr-ins-04_2026.08-01_ru.pdf"` после ins-03.
4. `legal-artifact-attestation.test.mjs`: `releaseId`, `manifestSha256`, `releasedPdfNames` (+ins-04), счётчики 11 → 12.
5. `edge-contract.test.mjs`: `artifacts.length` 15 → 16.

- [ ] **Step 5: Полные гейты**

```bash
pnpm test:production-bundle:contract
pnpm --filter @markiro/landing build
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
pnpm format:check
```

Expected: всё PASS. В dist: новая страница 8 `<img>` / 8 `<figcaption>`; `/legal/index.html` содержит MKR-INS-01…04.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/public/legal deploy/production
git commit -m "feat(legal): publish MKR-INS-04 artifact and attest the new release set"
```

---

## Self-Review Notes

- Spec coverage: фикстуры+скрины (T1), документ/контент/CLI (T2, аудитория-наладчик и сервис-кратко в контенте), лендинг (T3), артефакт+аттестация (T4). Кабинетская часть — текстом (T2 контент, шаг 1 раздела 2 без image).
- Числа: маршруты 12; артефакты 16 (12 PDF + 4 DOCX); лендинг 16/12/4; `/legal/` PDF 8 / SHA 10; sitemap 38; аттестация 12 PDF; edge-contract 16.
- Image ids: все восемь используются (pairing-waiting/success, setup-scanner/printer/sound, update-current/warn/active-shift).
- Контент имеет явное стоп-условие сверки с фактическими экранами Task 1 (вход в центр обновлений и подписи блоков).
- Процессное требование спеки: финальному whole-branch ревью — линза «текст ↔ скриншоты ↔ i18n» по каждому шагу с картинкой (задаётся контролёром при диспатче финального ревью).
