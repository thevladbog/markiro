# MKR-INS-03 «Исключения и восстановление» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Третья печатная инструкция оператора — MKR-INS-03 «Станция сканирования: исключения и восстановление» — по конвейеру MKR-INS-01/02: RU-страница + PDF/A-артефакт с аттестацией.

**Architecture:** Контентная итерация по готовому конвейеру категории `instruction`. Четыре задачи: аудит фикстур + скриншоты → контент + реестр + CLI-перечисления → лендинг → артефакт + аттестация. Доменная семантика расформирования сверена с кодом (`disassembleBox` в `apps/station/src/lib/boxes.ts`: освобождает коды короба, SSCC аннулируется навсегда, переупаковка = новый короб с новым SSCC через повторное сканирование).

**Tech Stack:** TypeScript (ESM), Astro, Vitest, node:test, LibreOffice 26.2.5 + veraPDF 1.30.2 (docker), Playwright MCP.

**Спека:** `docs/superpowers/specs/2026-08-22-mkr-ins-03-exceptions-design.md`. Ветка: `claude/mkr-ins-03-exceptions` (от origin/main, включает MKR-INS-01/02).

## Global Constraints

- Код `MKR-INS-03`, ревизия `2026.08/01`, effectiveDate `2026-08-22`, статус `active`, RU-only.
- Маршрут: `/instruktsii/isklyucheniya-i-vosstanovlenie/`. Артефакт: `markiro_mkr-ins-03_2026.08-01_ru.pdf`, kind `pdfa-2b`.
- Аттестация: release id `MKR-LEGAL-2026.08-03-2026-08-22`; прежние 14 файлов в `apps/landing/public/legal` байт-в-байт.
- Цитаты интерфейса — строго из `apps/station/src/i18n/ru.json` (секции `box`, `conflicts`, `work`, `signal`).
- Расформирование подаётся как штатный инструмент оператора (решение владельца), необратимость — словами UI.
- Генераторы: docx 9.7.1, LibreOffice 26.2.5, veraPDF 1.30.2; TTF IBM Plex установлены.
- Prettier `--write` только на затронутые файлы; этот план уже в `.prettierignore`.
- Vitest-фильтр: `pnpm --filter <pkg> exec vitest run <path>`. Коммиты с трейлером `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Аудит фикстур exception/print/conflicts и восемь скриншотов

**Files:**
- Possibly modify: `apps/station/src/dev/StationScreenGallery.tsx`, `apps/station/src/dev/gallery-fixtures.ts`, `apps/station/test/screen-gallery.test.tsx` (только при расхождении с реальным UI)
- Create: `packages/legal-documents/assets/instructions/mkr-ins-03/{exception-action,exception-target,exception-reason,exception-confirm,exception-result,box-print-failed,print-mismatch,conflicts}.png`

**Interfaces:**
- Consumes: dev-галерея `http://localhost:5273/?gallery=1&state=<id>&locale=ru`.
- Produces: восемь PNG 1280×800; id = имя файла без `.png` (ссылки контента Task 2).

Соответствие файлов состояниям галереи:

| Файл | `state=` | Что должно быть на экране |
| --- | --- | --- |
| exception-action.png | `exception-action` | Выбор действия: «Перепечатать этикетку» / «Расформировать короб» |
| exception-target.png | `exception-target` | Выбор закрытого короба: «Отсканируйте этикетку короба или выберите его из списка» |
| exception-reason.png | `exception-reason` | Справочник причин («Выберите причину») |
| exception-confirm.png | `exception-confirm` | Подтверждение расформирования: «Действие необратимо» / «Расформировать безвозвратно» |
| exception-result.png | `exception-result` | Результат: «Действие выполнено» |
| box-print-failed.png | `box-print-transport-failed` | «Этикетка короба не напечатана», «Печатать заново» / «Продолжить без этикетки» |
| print-mismatch.png | `print-mismatch` | Сверка печати: «Это другая этикетка» |
| conflicts.png | `conflicts-page-1` | «Коды, занятые другим терминалом», «Закреплён за … в …» |

- [ ] **Step 1: Сверить фикстуры с реальным UI**

Прочитать реальные компоненты: `apps/station/src/pages/ExceptionFlow.tsx`, `apps/station/src/ui/BoxPrintRecovery.tsx`, `apps/station/src/ui/PrintVerification.tsx`, `apps/station/src/ui/ConflictList.tsx` (и как WorkScreen их монтирует), затем соответствующие фикстуры в `StationScreenGallery.tsx`. Для каждого из восьми состояний — диф-лист «реальный экран vs фикстура» (обёртка/хром, подписи, кнопки, данные). Прецеденты починок: `git show bf183bc14 16c171345 859cf17d7 -- apps/station/src/dev` (re-platforming на реальные компоненты, единый предикат хрома). Отдельно проверить: `exception-confirm` должен показывать именно расформирование (двойное подтверждение необратимости), а не перепечатку — если фикстура показывает перепечатку, переключить её variant/данные на расформирование.

- [ ] **Step 2: Починить расхождения (если есть)**

Фикстуры рендерят текущий реальный UI через реальные компоненты с синтетическими пропсами; данные вымышленные (Демо-станция 01, SSCC вида 046012345600000016, DEMO-SERIAL-…). Продакшен-код не менять (максимум export) — иначе BLOCKED. Нет расхождений — зафиксировать это в отчёте.

- [ ] **Step 3: Гейты станции (если менялись фикстуры)**

Run: `pnpm --filter @markiro/station typecheck && pnpm --filter @markiro/station lint && pnpm --filter @markiro/station test`
Expected: всё PASS; prettier на изменённые файлы.

- [ ] **Step 4: Снять скриншоты**

```bash
mkdir -p packages/legal-documents/assets/instructions/mkr-ins-03
```

`pnpm --filter @markiro/station dev` в фоне (порт 5273, дождаться 200). Для каждой строки таблицы: Playwright MCP `browser_resize` 1280×800 → `browser_navigate` → дождаться отрисовки → `browser_take_screenshot` (png) → скопировать в целевой файл; retina → `sips -Z 1280`. Сервер убить.

- [ ] **Step 5: Проверить результат**

Run: `file packages/legal-documents/assets/instructions/mkr-ins-03/*.png`
Expected: восемь `PNG image data, 1280 x 800`, каждый < 600 KB. Открыть каждый через Read и сверить с колонкой таблицы.

- [ ] **Step 6: Commit**

```bash
git add apps/station packages/legal-documents/assets/instructions/mkr-ins-03
git commit -m "feat(legal-documents): MKR-INS-03 exception screenshots from station gallery"
```

(Фикстурные починки — отдельным первым коммитом `fix(station): sync exception gallery fixtures with the current UI`.)

---

### Task 2: Пакет — код MKR-INS-03, контент, релиз, CLI-перечисления

**Files:**
- Modify: `packages/legal-documents/src/types.ts`, `packages/legal-documents/src/registry.ts`, `packages/legal-documents/src/cli/verify-artifacts.ts`
- Create: `packages/legal-documents/src/documents/station-exceptions.ts`
- Test: `packages/legal-documents/test/registry.test.ts`, `packages/legal-documents/test/artifact-manifest.test.ts`

**Interfaces:**
- Consumes: PNG-ассеты Task 1 (восемь id из таблицы Task 1); helpers `legalDocumentKind`/`legalReleaseLocales`/`requireLegalContent`, блоки `step`/`callout`.
- Produces: `STATION_EXCEPTIONS_CONTENT`; активный релиз `MKR-INS-03/2026.08/01` с маршрутом `/instruktsii/isklyucheniya-i-vosstanovlenie/`; `artifactFileName(...)` → `markiro_mkr-ins-03_2026.08-01_ru.pdf`.

- [ ] **Step 1: Базовая линия**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/instruction-assets.test.ts`
Expected: PASS (MKR-INS-03 ещё не зарегистрирован). После Step 2–3 тест обязан пройти уже с тремя инструкциями.

- [ ] **Step 2: Типы, реестр, CLI**

1. `types.ts`: в union `LegalDocumentCode` добавить `"MKR-INS-03"` (сохранить однострочный prettier-формат; если строка превысит 100 символов — prettier сам перенесёт).
2. `registry.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-03"`; `LEGAL_DOCUMENT_KIND_BY_CODE` + `"MKR-INS-03": "instruction",`; импорт `STATION_EXCEPTIONS_CONTENT` из `./documents/station-exceptions.js`; в `LEGAL_RELEASES` последним:

```ts
  {
    code: "MKR-INS-03",
    revision: "2026.08/01",
    effectiveDate: "2026-08-22",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/isklyucheniya-i-vosstanovlenie/" },
  },
```

и в `LEGAL_DOCUMENTS`:

```ts
  { releaseKey: "MKR-INS-03/2026.08/01", content: STATION_EXCEPTIONS_CONTENT },
```

3. `verify-artifacts.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-03"`; `SAFE_FILE_NAME` → `ins-0[123]`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-01|pd-02|dpa-01|brd-01|ins-0[123])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 3: Контент**

Создать `packages/legal-documents/src/documents/station-exceptions.ts`:

```ts
import type { LegalDocumentSource } from "../types.js";

export const STATION_EXCEPTIONS_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: исключения и восстановление",
    summary:
      "Пошаговая инструкция оператора для нештатных ситуаций: перепечатка этикетки, расформирование короба, сбой печати, коды, занятые другим терминалом.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает действия оператора в нештатных ситуациях: испорченная или потерянная этикетка короба, короб собран с ошибкой, принтер не напечатал этикетку, станция показывает коды, занятые другим терминалом. Вход на станцию описан в инструкции MKR-INS-01, штатный рабочий цикл — в MKR-INS-02.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Номера коробов и продукты на вашей станции будут отличаться.",
          },
        ],
      },
      {
        id: "exceptions-screen",
        heading: "2. Экран «Исключения»",
        blocks: [
          {
            kind: "step",
            title: "Откройте экран «Исключения»",
            text: "Нажмите кнопку «Исключения» на рабочем экране. Станция покажет действия над закрытыми коробами этой смены: «Перепечатать этикетку» и «Расформировать короб». Кнопка «Вернуться к работе» в любой момент возвращает к сканированию.",
            image: { id: "exception-action", caption: "Экран «Исключения»: выбор действия" },
          },
        ],
      },
      {
        id: "reprint",
        heading: "3. Перепечатка этикетки короба",
        blocks: [
          {
            kind: "paragraph",
            text: "Перепечатывайте этикетку, если она повреждена, не читается сканером, испорчена принтером или её запросил контроль качества. Содержимое короба и его номер SSCC не меняются — печатается та же этикетка.",
          },
          {
            kind: "step",
            title: "Укажите короб",
            text: "Выберите «Перепечатать этикетку». Станция попросит указать закрытый короб: отсканируйте его этикетку или выберите короб из списка (номер SSCC, число позиций, время закрытия).",
            image: { id: "exception-target", caption: "Выбор закрытого короба: сканом этикетки или из списка" },
            expected: "Станция показала справочник причин.",
          },
          {
            kind: "step",
            title: "Выберите причину и подтвердите",
            text: "Укажите причину из списка: «Этикетка повреждена», «Этикетка не читается», «Замятие принтера / нет печати», «Запрос контроля качества» или «Другая причина». Затем подтвердите действие кнопкой «Подтвердить перепечатку».",
            image: { id: "exception-reason", caption: "Справочник причин перепечатки" },
            expected: "Принтер напечатал этикетку, станция показала «Действие выполнено».",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Старую этикетку снимите и уничтожьте. На коробе должна остаться ровно одна этикетка — два одинаковых SSCC в обороте недопустимы.",
          },
        ],
      },
      {
        id: "disassemble",
        heading: "4. Расформирование короба",
        blocks: [
          {
            kind: "paragraph",
            text: "Расформируйте короб, если он собран с ошибкой: неверный товар, неверное количество, повреждена упаковка или короб отклонён контролем качества. Причину вы выберете из того же справочника; для нетипового случая есть «Другая причина».",
          },
          {
            kind: "step",
            title: "Выберите короб и причину",
            text: "На экране «Исключения» выберите «Расформировать короб», укажите закрытый короб (сканом этикетки или из списка) и причину.",
            expected: "Станция показала экран подтверждения.",
          },
          {
            kind: "step",
            title: "Подтвердите необратимое действие",
            text: "Станция предупредит: «Действие необратимо» — номер короба будет аннулирован навсегда. Проверьте, что выбран нужный короб, и нажмите «Расформировать безвозвратно».",
            image: { id: "exception-confirm", caption: "Двойное подтверждение расформирования" },
            expected: "Станция показала «Действие выполнено», короб пропал из списка закрытых.",
          },
          {
            kind: "step",
            title: "Переупакуйте единицы",
            text: "Единицы из расформированного короба остаются проверенными — заново отсканируйте их в новый короб обычным рабочим циклом. Новый короб получит новый номер SSCC; этикетку расформированного короба уничтожьте.",
            image: { id: "exception-result", caption: "Результат действия" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Аннулированный SSCC нельзя использовать повторно, а расформирование нельзя отменить. Если короб расформирован по ошибке — сообщите мастеру и соберите содержимое в новый короб.",
          },
        ],
      },
      {
        id: "box-print-recovery",
        heading: "5. Сбой печати при закрытии короба",
        blocks: [
          {
            kind: "step",
            title: "Экран «Этикетка короба не напечатана»",
            text: "Если при закрытии короба принтер не сработал, станция показывает экран восстановления с причиной: проблема печати, для смены не выбран шаблон этикетки или этикетку не удалось подготовить. Устраните причину (проверьте ленту и замятие принтера) и нажмите «Печатать заново».",
            image: { id: "box-print-failed", caption: "Восстановление печати этикетки короба" },
            expected: "Принтер напечатал этикетку, работа продолжилась.",
          },
          {
            kind: "step",
            title: "Крайний случай — «Продолжить без этикетки»",
            text: "Если печать сейчас невозможна, нажмите «Продолжить без этикетки» и подтвердите. Короб уже закрыт и учтён — его нужно будет промаркировать этикеткой позже через перепечатку (раздел 3). Пометьте такой короб, чтобы не потерять его.",
          },
          {
            kind: "step",
            title: "Если сверка не проходит",
            text: "При сверке напечатанной этикетки сканируйте именно код SSCC с этикетки этого короба. «Это другая этикетка» — в руках этикетка от другого короба: найдите правильную или нажмите «Печатать заново». «Это не групповой код» — отсканирован код маркировки единицы, а не этикетка короба.",
            image: { id: "print-mismatch", caption: "Сверка печати: в руках этикетка другого короба" },
          },
        ],
      },
      {
        id: "conflicts",
        heading: "6. Коды, занятые другим терминалом",
        blocks: [
          {
            kind: "paragraph",
            text: "Если один и тот же код прошёл через две станции, код закрепляется за терминалом, отсканировавшим его раньше. На проигравшей станции такой код попадает в список расхождений, а счётчик «Дубли» в строке состояния растёт. Это не авария и не ошибка оператора.",
          },
          {
            kind: "step",
            title: "Посмотрите список расхождений",
            text: "Откройте «Дубли кодов» с рабочего экрана. Для каждой позиции указано, за каким терминалом закреплён код и когда: «Закреплён за … в …».",
            image: { id: "conflicts", caption: "Список кодов, занятых другим терминалом" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Не сканируйте такие коды повторно. Продолжайте работу — расхождение проверит менеджер в кабинете.",
          },
        ],
      },
      {
        id: "hardware",
        heading: "7. Оборудование посреди смены",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "Сканер показывает «Нет связи» — остановите работу, проверьте кабель сканера. Если связь не вернулась, позовите наладчика.",
              "Принтер не печатает — станция сама покажет экран восстановления при закрытии короба (раздел 5). Проверьте ленту, питание и кабель принтера.",
              "Строка состояния показывает «Не настроено» у сканера или принтера — рабочее место не настроено до конца, работать нельзя, позовите наладчика.",
            ],
          },
          {
            kind: "paragraph",
            text: "Подключение и настройка оборудования — задача наладчика и описаны в отдельной инструкции по настройке рабочего места.",
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
                term: "После перепечатки на руках две этикетки",
                detail: "На коробе остаётся новая, старую уничтожьте. Обе несут один SSCC — в обороте должна быть одна.",
              },
              {
                term: "Расформировал не тот короб",
                detail: "Отменить нельзя. Сообщите мастеру, соберите содержимое в новый короб обычным циклом — станция выдаст новый SSCC.",
              },
              {
                term: "Короб не находится сканом на экране выбора",
                detail: "«Короб не найден среди закрытых коробов этой смены» — этикетка от короба другой смены или станции. Выберите короб из списка или обратитесь к мастеру.",
              },
              {
                term: "Счётчик «Дубли» вырос",
                detail: "Это список кодов, занятых другим терминалом (раздел 6). Работу не останавливайте, повторно не сканируйте.",
              },
              {
                term: "Закрыл короб без этикетки и забыл какой",
                detail: "Откройте «Исключения» → «Перепечатать этикетку»: в списке видны все закрытые короба с числом позиций и временем закрытия.",
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

Примечание для исполнителя: формулировка «Единицы из расформированного короба остаются проверенными — заново отсканируйте их в новый короб» сверена с doc-комментарием `disassembleBox` (`apps/station/src/lib/boxes.ts`: «frees every code it still held … a re-packed box is a brand-new box row with a brand-new SSCC») и фиксом `c5480c03b` (released-коды снова сканируемы). Если Task 1 обнаружил иной фактический флоу (например, повторный скан даёт «ДУБЛЬ») — остановиться и доложить DONE_WITH_CONCERNS с цитатой кода, НЕ подгонять текст молча.

- [ ] **Step 4: Pinned-тесты пакета**

1. `test/registry.test.ts`: pinned-список кодов + `"MKR-INS-03"`; счётчик маршрутов 10 → 11.
2. `test/artifact-manifest.test.ts`: фикстурная запись MKR-INS-03 (`ru`/`pdfa-2b`, файл `markiro_mkr-ins-03_2026.08-01_ru.pdf`, effectiveDate `2026-08-22` в per-code ветвлении `artifactEntry()`); счётчики набора 14 → 15 записей, PDF 10 → 11.
Прогонять файлы и править по фактическим падениям, не ослабляя.

- [ ] **Step 5: Гейты пакета**

Run: `pnpm --filter @markiro/legal-documents test && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents lint`
Expected: всё PASS (в т.ч. instruction-assets с тремя инструкциями). Prettier на затронутые файлы.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal-documents): MKR-INS-03 exceptions instruction content"
```

---

### Task 3: Лендинг — страница и перечисления

**Files:**
- Modify: `apps/landing/src/content/legal-pages.ts`, `apps/landing/src/lib/legal-artifacts.ts`
- Create: `apps/landing/src/pages/instruktsii/isklyucheniya-i-vosstanovlenie/index.astro`
- Test: `apps/landing/src/lib/legal-artifacts.test.ts`, `apps/landing/src/lib/seo.test.ts`, `apps/landing/test/legal-rendered-page.test.ts` (по фактическим падениям)

**Interfaces:**
- Consumes: релиз/контент Task 2; `InstructionDocument.astro` (props `{ page, images: Record<string, string> }`).
- Produces: страница `/instruktsii/isklyucheniya-i-vosstanovlenie/`; загрузчик принимает `ins-03`.

- [ ] **Step 1: Базовая линия падений**

Run: `pnpm --filter @markiro/landing test`
Expected: FAIL — `DESCRIPTION_BY_CODE` без MKR-INS-03 (satisfies), pinned-счётчики, completeness против реального `public/legal` (остаётся красным до Task 4 вместе с build-зависимыми сьютами).

- [ ] **Step 2: `DESCRIPTION_BY_CODE`**

```ts
  "MKR-INS-03": {
    ru: "Печатная инструкция оператора для нештатных ситуаций: перепечатка этикетки, расформирование короба, сбой печати, коды, занятые другим терминалом.",
    en: "Printable operator instruction for exceptions: label reprint, box disassembly, print recovery, and codes claimed by another terminal.",
  },
```

- [ ] **Step 3: Страница**

Создать `apps/landing/src/pages/instruktsii/isklyucheniya-i-vosstanovlenie/index.astro` (структура — зеркало соседних страниц в `apps/landing/src/pages/instruktsii/`):

```astro
---
import exceptionAction from "@markiro/legal-documents/assets/instructions/mkr-ins-03/exception-action.png?url";
import exceptionTarget from "@markiro/legal-documents/assets/instructions/mkr-ins-03/exception-target.png?url";
import exceptionReason from "@markiro/legal-documents/assets/instructions/mkr-ins-03/exception-reason.png?url";
import exceptionConfirm from "@markiro/legal-documents/assets/instructions/mkr-ins-03/exception-confirm.png?url";
import exceptionResult from "@markiro/legal-documents/assets/instructions/mkr-ins-03/exception-result.png?url";
import boxPrintFailed from "@markiro/legal-documents/assets/instructions/mkr-ins-03/box-print-failed.png?url";
import printMismatch from "@markiro/legal-documents/assets/instructions/mkr-ins-03/print-mismatch.png?url";
import conflicts from "@markiro/legal-documents/assets/instructions/mkr-ins-03/conflicts.png?url";

import { getLegalDocumentPage } from "../../../content/legal-pages";
import InstructionDocument from "../../../components/InstructionDocument.astro";

const images = {
  "exception-action": exceptionAction,
  "exception-target": exceptionTarget,
  "exception-reason": exceptionReason,
  "exception-confirm": exceptionConfirm,
  "exception-result": exceptionResult,
  "box-print-failed": boxPrintFailed,
  "print-mismatch": printMismatch,
  conflicts,
};
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-03", "ru")} images={images} />
```

Примечание: контент Task 2 использует все восемь image id (тест синхронизации ассетов требует точного соответствия id ↔ файлы, осиротевших файлов быть не должно).

- [ ] **Step 4: Загрузчик артефактов**

`apps/landing/src/lib/legal-artifacts.ts`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01|ins-0[123])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 5: Pinned-тесты лендинга**

Ожидаемая арифметика (править по фактическим падениям, сверяя с ней; расхождение — investigate):
- `legal-artifacts.test.ts`: фикстурная запись MKR-INS-03; счётчики 14 → 15 всего, `pdfa-2b` 10 → 11, `template-docx` 4.
- `legal-rendered-page.test.ts`: список кодов реестра + MKR-INS-03; `/legal/`: PDF 6 → 7, SHA 8 → 9; `/en/legal/` без изменений.
- `seo.test.ts`: sitemap 34 → 36.

- [ ] **Step 6: Гейты лендинга**

Run: `pnpm --filter @markiro/landing test && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing lint`
Expected: PASS, кроме известных красных (completeness + build-зависимые сьюты — до Task 4). Build не запускать. Prettier на затронутые файлы.

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src
git commit -m "feat(landing): MKR-INS-03 exceptions instruction page"
```

---

### Task 4: Артефакт, аттестация, полные гейты

**Files:**
- Modify (генерируется): `apps/landing/public/legal/artifacts.json`; Create: `apps/landing/public/legal/files/markiro_mkr-ins-03_2026.08-01_ru.pdf`
- Modify: `deploy/production/legal-artifacts-attestation.json`, `deploy/production/verify-legal-artifacts.mjs`
- Test: `deploy/production/test/legal-artifact-attestation.test.mjs`, `deploy/production/test/edge-contract.test.mjs`

**Interfaces:**
- Consumes: задачи 1–3; тулчейн SOFFICE_BIN=/opt/homebrew/bin/soffice, VERAPDF_CONTAINER_RUNTIME=docker (sandbox off для docker-команд).
- Produces: набор из 15 артефактов; аттестация `MKR-LEGAL-2026.08-03-2026-08-22`.

- [ ] **Step 1: Генерация**

Удалить `apps/landing/public/legal` целиком, затем:

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
```

- [ ] **Step 2: Гейт детерминизма**

`git status --porcelain apps/landing/public/legal` → ТОЛЬКО artifacts.json (M) + новый PDF (A); diff манифеста — одна вставка. Иначе restore + BLOCKED с `pdffonts` изменившегося файла.

- [ ] **Step 3: Верификация и просмотр**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: `Verified 15 immutable legal artifacts`. Read PDF (страницы 1–5): титул «Станция сканирования: исключения и восстановление», шапка «РАБОЧАЯ ИНСТРУКЦИЯ · MKR-INS-03», 8 скриншотов с подписями, < 12 MiB.

- [ ] **Step 4: Аттестация**

1. `shasum -a 256 apps/landing/public/legal/artifacts.json apps/landing/public/legal/files/markiro_mkr-ins-03_2026.08-01_ru.pdf`
2. `legal-artifacts-attestation.json`: `releaseId` → `"MKR-LEGAL-2026.08-03-2026-08-22"`, `manifestSha256` → новый, запись ins-03 после ins-02 (лексикографический порядок), фактический sha256.
3. `verify-legal-artifacts.mjs`: `RELEASE_ID` → тот же id; `EXPECTED_PDFS` + `"markiro_mkr-ins-03_2026.08-01_ru.pdf"` после ins-02.
4. `legal-artifact-attestation.test.mjs`: `releaseId`, `manifestSha256`, `releasedPdfNames` (+ins-03), счётчики 10 → 11.
5. `edge-contract.test.mjs`: `artifacts.length` 14 → 15.

- [ ] **Step 5: Полные гейты**

```bash
pnpm test:production-bundle:contract
pnpm --filter @markiro/landing build
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
pnpm format:check
```

Expected: всё PASS. В dist: новая страница содержит 8 `<img>` / 8 `<figcaption>`; `/legal/index.html` содержит MKR-INS-01/02/03.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/public/legal deploy/production
git commit -m "feat(legal): publish MKR-INS-03 artifact and attest the new release set"
```

---

## Self-Review Notes

- Spec coverage: фикстуры+скрины (T1 = раздел 2), документ/контент/CLI (T2 = разделы 1, 3-частично), лендинг (T3), артефакт+аттестация (T4). Расформирование — штатный инструмент, необратимость словами UI (T2 контент). Оборудование — кратко (раздел 7 контента).
- Числа: маршруты 11; артефакты 15 (11 PDF + 4 DOCX); лендинг-фикстуры 15/11/4; `/legal/` PDF 7 / SHA 9; sitemap 36; аттестация 11 PDF; edge-contract 15.
- Image ids: контент использует все восемь (включая print-mismatch — шаг «Если сверка не проходит», см. правку в Task 3 Step 3, применяемую в Task 2 Step 3).
- Доменная сверка расформирования — с явным стоп-условием для исполнителя Task 2.
