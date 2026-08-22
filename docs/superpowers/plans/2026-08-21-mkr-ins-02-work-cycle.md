# MKR-INS-02 «Рабочий цикл — проверка и агрегация» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вторая печатная инструкция оператора — MKR-INS-02 «Станция сканирования: рабочий цикл — проверка и агрегация» — по готовому конвейеру MKR-INS-01: RU-страница на лендинге + PDF/A-артефакт с аттестацией.

**Architecture:** Механизмы категории `instruction` уже в main (типы, блоки `step`/`callout`, `InstructionDocument.astro`, DOCX+PNG, лимит 12 MiB, аттестация). Эта итерация — контент + обновление перечислений: реестр, лендинг, аттестация деплоя. Скриншоты — из dev-галереи станции ПОСЛЕ сверки фикстур с реальным UI.

**Tech Stack:** TypeScript (ESM, `.js`-импорты), Astro, Vitest, node:test (deploy-контракты), LibreOffice 26.2.5 + veraPDF 1.30.2 (docker), Playwright MCP для скриншотов.

**Спека:** `docs/superpowers/specs/2026-08-21-mkr-ins-02-work-cycle-design.md`. Ветка: `claude/mkr-ins-02-work-cycle` (от origin/main, включает MKR-INS-01).

## Global Constraints

- Код `MKR-INS-02`, ревизия `2026.08/01`, effectiveDate `2026-08-21`, статус `active`, RU-only.
- Маршрут: `/instruktsii/rabochiy-tsikl-skanirovaniya-i-agregatsii/`. Артефакт: `markiro_mkr-ins-02_2026.08-01_ru.pdf`, kind `pdfa-2b`.
- Аттестация: новый release id `MKR-LEGAL-2026.08-02-2026-08-21`; прежние 13 файлов в `apps/landing/public/legal` остаются байт-в-байт (гейт детерминизма).
- Тексты в контенте, цитирующие интерфейс, должны совпадать со строками `apps/station/src/i18n/ru.json` (например «ПРИНЯТО», «ДУБЛЬ», «Нет связи», «Не отправлено», «Закрыть короб», «Отсканируйте распечатанную этикетку»).
- Генераторы не меняются: docx 9.7.1, LibreOffice 26.2.5, veraPDF 1.30.2. TTF IBM Plex уже установлены (гейт: старые PDF байт-идентичны).
- Prettier: `--write` только на затронутые файлы; НИКОГДА `--write .`; этот план уже в `.prettierignore`.
- Vitest-фильтр по файлу: `pnpm --filter <pkg> exec vitest run <path>`.
- Коммиты заканчиваются трейлером: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- В свежем окружении перед тестами станции/лендинга: `pnpm install`, `pnpm --filter @markiro/domain build`, `pnpm --filter @markiro/ui build`, `pnpm --filter @markiro/db build`.

---

### Task 1: Аудит фикстур галереи и восемь скриншотов

**Files:**
- Possibly modify: `apps/station/src/dev/StationScreenGallery.tsx`, `apps/station/src/dev/gallery-fixtures.ts` (только при расхождении с реальным UI)
- Create: `packages/legal-documents/assets/instructions/mkr-ins-02/{work-scan-wait,scan-ok,scan-duplicate,scan-error,work-aggregation,box-full,print-verification,offline}.png`

**Interfaces:**
- Consumes: dev-галерея станции `http://localhost:5273/?gallery=1&state=<id>&locale=ru` (vite dev, порт 5273, launch-конфиг `station`).
- Produces: восемь PNG 1280×800; id изображения = имя файла без `.png`. На эти id ссылается контент Task 2.

Соответствие файлов состояниям галереи:

| Файл | `state=` | Что должно быть на экране |
| --- | --- | --- |
| work-scan-wait.png | `work-validation` | Рабочий экран, «Ожидание скана…», счётчики 0/0, «Сканов пока нет» |
| scan-ok.png | `work-ok` | Полноэкранный зелёный вердикт «ПРИНЯТО» |
| scan-duplicate.png | `work-duplicate` | Вердикт «ДУБЛЬ» с «Первый скан в …» |
| scan-error.png | `work-error` | Красный вердикт (НЕВЕРНЫЙ КОД / ЧУЖОЙ ГТИН / ОШИБКА ЗАПИСИ — какой рендерит фикстура) |
| work-aggregation.png | `work-aggregation` | Рабочий экран с панелью «Открытый короб» (Короб №, Позиций) |
| box-full.png | `box-full` | Заполненный короб перед закрытием («Закрыть короб») |
| print-verification.png | `print-verification` | Экран «Отсканируйте распечатанную этикетку» |
| offline.png | `offline` | Рабочий экран с «Сервер: Нет связи» и «Не отправлено: N» |

- [ ] **Step 1: Сверить фикстуры с реальным UI**

Прочитать `apps/station/src/pages/work/WorkScreen.tsx` (полностью), `apps/station/src/ui/work/*` (ScanResultInstrument, BoxFillInstrument, WorkCounters, WorkFooter), `apps/station/src/ui/PrintVerification.tsx`, `apps/station/src/ui/StatusBar.tsx` — и соответствующие `WorkFixture`/`BoxFixture`/`PrintFixture`/sync-фикстуры в `StationScreenGallery.tsx`. Для каждого из восьми состояний составить диф-лист «реальный экран vs фикстура» (layout, шапка, подписи, кнопки, счётчики). Прецедент MKR-INS-01: логин-фикстуры оборачивались в лишний `FloorShell` и держали устаревшую разметку — work-фикстуры уже частично чинились (обнуление счётчиков), но `work-ok/duplicate/error`, `box-full`, `print-verification`, `offline` не сверялись.

- [ ] **Step 2: Починить расхождения (если есть)**

Обновить фикстуры так, чтобы состояния рендерили текущий реальный UI, предпочитая реальные компоненты с синтетическими пропсами (как уже делает галерея). Данные — только вымышленные (Демо-станция 01, Тестовый товар А, DEMO-SERIAL-…). Продакшен-код не менять (максимум — добавить export); если требуется больше — остановиться и доложить BLOCKED. Если расхождений нет — шаг пропустить и зафиксировать это в отчёте.

- [ ] **Step 3: Прогнать гейты станции (если менялись фикстуры)**

Run: `pnpm --filter @markiro/station typecheck && pnpm --filter @markiro/station lint && pnpm --filter @markiro/station test`
Expected: всё PASS (галерея покрыта screen-gallery-тестами). Prettier — только на изменённые файлы.

- [ ] **Step 4: Снять скриншоты**

```bash
mkdir -p packages/legal-documents/assets/instructions/mkr-ins-02
```

Запустить `pnpm --filter @markiro/station dev` в фоне, дождаться 200 от `http://localhost:5273`. Для каждой строки таблицы: Playwright MCP `browser_resize` 1280×800 → `browser_navigate` на URL состояния → дождаться полной отрисовки → `browser_take_screenshot` (png) → скопировать в целевой файл. Retina-вывод ужать `sips -Z 1280 <file>`. Сервер убить по завершении.

- [ ] **Step 5: Проверить результат**

Run: `file packages/legal-documents/assets/instructions/mkr-ins-02/*.png`
Expected: восемь `PNG image data, 1280 x 800`, каждый < 600 KB. Открыть каждый через Read и сверить с колонкой «Что должно быть на экране»; пустые/loading-состояния переснять.

- [ ] **Step 6: Commit**

```bash
git add apps/station/src/dev packages/legal-documents/assets/instructions/mkr-ins-02
git commit -m "feat(legal-documents): MKR-INS-02 work-cycle screenshots from station gallery"
```

(Если фикстуры менялись — отдельным первым коммитом `fix(station): sync work-cycle gallery fixtures with the current UI`.)

---

### Task 2: Пакет — код MKR-INS-02, контент, релиз, CLI-перечисления

**Files:**
- Modify: `packages/legal-documents/src/types.ts` (union `LegalDocumentCode`)
- Modify: `packages/legal-documents/src/registry.ts` (kind-карта, `LEGAL_DOCUMENT_CODES`, релиз, источник)
- Create: `packages/legal-documents/src/documents/station-work-cycle.ts`
- Modify: `packages/legal-documents/src/cli/verify-artifacts.ts` (`LEGAL_DOCUMENT_CODES`, `SAFE_FILE_NAME`)
- Test: `packages/legal-documents/test/registry.test.ts`, `packages/legal-documents/test/artifact-manifest.test.ts` (pinned-значения)

**Interfaces:**
- Consumes: PNG-ассеты из Task 1 (id: work-scan-wait, scan-ok, scan-duplicate, scan-error, work-aggregation, box-full, print-verification, offline); существующие `legalDocumentKind`/`legalReleaseLocales`/`requireLegalContent` и блоки `step`/`callout`.
- Produces: `STATION_WORK_CYCLE_CONTENT`; активный релиз `MKR-INS-02/2026.08/01` с маршрутом `/instruktsii/rabochiy-tsikl-skanirovaniya-i-agregatsii/`; `artifactFileName(...)` даёт `markiro_mkr-ins-02_2026.08-01_ru.pdf`.

- [ ] **Step 1: Убедиться, что asset-sync тест падает до регистрации**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/instruction-assets.test.ts`
Expected: PASS (тест перебирает только зарегистрированные инструкции — MKR-INS-02 ещё нет). Это базовая линия; после Step 3–4 тест обязан пройти уже с двумя инструкциями — это и есть TDD-петля задачи (тест существует, расширяется данными).

- [ ] **Step 2: Расширить типы и реестр**

`types.ts` — в union добавить код:

```ts
export type LegalDocumentCode =
  "MKR-PD-01" | "MKR-PD-02" | "MKR-DPA-01" | "MKR-BRD-01" | "MKR-INS-01" | "MKR-INS-02";
```

`registry.ts`:

1. В `LEGAL_DOCUMENT_CODES` добавить `"MKR-INS-02"` (массив уже многострочный).
2. В `LEGAL_DOCUMENT_KIND_BY_CODE` добавить `"MKR-INS-02": "instruction",`.
3. Импорт: `import { STATION_WORK_CYCLE_CONTENT } from "./documents/station-work-cycle.js";`
4. В `LEGAL_RELEASES` последним элементом:

```ts
  {
    code: "MKR-INS-02",
    revision: "2026.08/01",
    effectiveDate: "2026-08-21",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/rabochiy-tsikl-skanirovaniya-i-agregatsii/" },
  },
```

5. В `LEGAL_DOCUMENTS`:

```ts
  { releaseKey: "MKR-INS-02/2026.08/01", content: STATION_WORK_CYCLE_CONTENT },
```

- [ ] **Step 3: Контент**

Создать `packages/legal-documents/src/documents/station-work-cycle.ts` (текст утверждён дизайном; цитаты интерфейса совпадают с `apps/station/src/i18n/ru.json`):

```ts
import type { LegalDocumentSource } from "../types.js";

export const STATION_WORK_CYCLE_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: рабочий цикл — проверка и агрегация",
    summary:
      "Пошаговая инструкция оператора: сканирование кодов и сигналы станции, наполнение и закрытие коробов, работа без сети, пауза и закрытие смены.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает работу оператора на станции сканирования Маркиро в течение смены: сканирование кодов маркировки, сигналы станции, наполнение и закрытие коробов в режиме агрегации, работу без сети и завершение смены. Вход на станцию и старт смены описаны в инструкции MKR-INS-01.",
          },
          {
            kind: "paragraph",
            text: "Режим смены задаётся при её создании: «Проверка» — станция только проверяет и учитывает каждый код; «Агрегация» — принятые единицы дополнительно укладываются в короба, станция ведёт их учёт и печатает этикетки коробов.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия продуктов, номера смен и счётчики на вашей станции будут отличаться.",
          },
        ],
      },
      {
        id: "scan-cycle",
        heading: "2. Цикл сканирования и сигналы",
        blocks: [
          {
            kind: "step",
            title: "Отсканируйте код маркировки",
            text: "Возьмите единицу продукции и наведите сканер на код DataMatrix. Станция обрабатывает сканы по одному: дождитесь сигнала по текущей единице, прежде чем сканировать следующую.",
            image: { id: "work-scan-wait", caption: "Рабочий экран: станция ждёт скан" },
            expected: "Станция показала полноэкранный сигнал и подала звук.",
          },
          {
            kind: "step",
            title: "Зелёный сигнал «ПРИНЯТО» — продолжайте",
            text: "Код проверен и записан. В режиме агрегации положите единицу в открытый короб; в режиме проверки — передайте дальше по линии.",
            image: { id: "scan-ok", caption: "Зелёный сигнал: код принят" },
          },
          {
            kind: "step",
            title: "Сигнал «ДУБЛЬ» — отложите единицу",
            text: "Этот код уже сканировали: станция показывает время первого скана. Не кладите единицу в короб — отложите её отдельно. Если дубли идут подряд, остановитесь и сообщите мастеру: возможно, продукция уже проходила через станцию.",
            image: { id: "scan-duplicate", caption: "Сигнал «ДУБЛЬ» со временем первого скана" },
          },
          {
            kind: "step",
            title: "Красный сигнал — не пропускайте единицу дальше",
            text: "«НЕВЕРНЫЙ КОД» — отсканирован не код маркировки или код повреждён: расправьте упаковку и повторите скан; если код не читается, отложите единицу. «ЧУЖОЙ ГТИН» — продукт не относится к этой смене: уберите его с линии. «ОШИБКА ЗАПИСИ» — станция не смогла сохранить скан: остановитесь и позовите наладчика.",
            image: { id: "scan-error", caption: "Красный сигнал: единицу нельзя пропускать" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Сигнал остаётся на экране до следующего скана. Если вы отвлеклись — сначала посмотрите на экран, к какой единице относится последний вердикт.",
          },
        ],
      },
      {
        id: "validation-mode",
        heading: "3. Режим «Проверка»",
        blocks: [
          {
            kind: "paragraph",
            text: "В режиме проверки задача оператора — прогнать каждую единицу через сканер и следить за сигналами. Коробов и печати в этом режиме нет.",
          },
          {
            kind: "unordered-list",
            items: [
              "Счётчики «Принято» и «Отклонено» показывают ход смены; если задан план, под продуктом отображается «План: N».",
              "Панель «Последние операции» показывает недавние сканы с серийными номерами и временем.",
              "При выполнении плана станция сообщит «План выполнен» — дальше действуйте по указанию мастера.",
            ],
          },
        ],
      },
      {
        id: "aggregation-mode",
        heading: "4. Режим «Агрегация»",
        blocks: [
          {
            kind: "step",
            title: "Наполняйте открытый короб",
            text: "Панель «Открытый короб» показывает номер короба и число позиций в нём. Кладите единицу в короб только после зелёного сигнала «ПРИНЯТО».",
            image: { id: "work-aggregation", caption: "Рабочий экран агрегации: панель «Открытый короб»" },
          },
          {
            kind: "step",
            title: "Закройте заполненный короб",
            text: "Когда короб набрал вместимость, закройте его кнопкой «Закрыть короб». Станция присвоит коробу номер SSCC и отправит этикетку на принтер. Наклейте этикетку на этот короб сразу — не откладывайте её в сторону.",
            image: { id: "box-full", caption: "Короб заполнен и готов к закрытию" },
            expected: "Принтер напечатал этикетку короба.",
          },
          {
            kind: "step",
            title: "Сверьте напечатанную этикетку",
            text: "Если на станции включена сверка печати, появится экран «Отсканируйте распечатанную этикетку»: наведите сканер на код SSCC на этикетке. Сообщение «Это другая этикетка» означает, что в руках этикетка от другого короба — найдите правильную или перепечатайте.",
            image: { id: "print-verification", caption: "Сверка напечатанной этикетки короба" },
            expected: "Станция подтвердила этикетку и открыла следующий короб.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Каждая этикетка принадлежит одному конкретному коробу: номер SSCC уникален. Наклеенная на чужой короб этикетка ломает учёт всей партии.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Неполный короб в конце смены закрывается той же кнопкой «Закрыть короб». Кнопка «Очистить короб» удаляет все позиции открытого короба — используйте её только по указанию мастера.",
          },
        ],
      },
      {
        id: "offline",
        heading: "5. Работа без сети",
        blocks: [
          {
            kind: "step",
            title: "Продолжайте работать при «Нет связи»",
            text: "Если в строке состояния «Сервер: Нет связи», станция продолжает принимать сканы и копит их локально — счётчик «Не отправлено» показывает очередь. Работайте как обычно: при восстановлении связи данные уйдут на сервер сами.",
            image: { id: "offline", caption: "Работа без сети: сканы копятся на станции" },
            expected: "После восстановления связи счётчик уменьшается до «Синхронизировано».",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Позовите администратора, если при работающей сети счётчик «Не отправлено» долго не уменьшается или в строке состояния «Синхронизация: Не отправляется». В режиме агрегации долгий офлайн может исчерпать запас номеров коробов — станция сообщит «Номера для коробов закончились» и приостановит сканирование до восстановления связи.",
          },
        ],
      },
      {
        id: "pause-close",
        heading: "6. Пауза и закрытие смены",
        blocks: [
          {
            kind: "step",
            title: "Прервитесь через «Пауза / завершить»",
            text: "Кнопка «Пауза» приостанавливает работу на перерыв. «Выйти из смены» освобождает станцию, не закрывая смену — её продолжите вы после перерыва или другой оператор. Если часть сканов ещё не дошла до сервера, станция предупредит об этом; данные сохраняются на станции и уйдут при связи.",
          },
          {
            kind: "step",
            title: "Закройте смену в конце работы",
            text: "Нажмите «Закрыть смену». В режиме агрегации сначала закройте открытый короб — станция напомнит: «Сначала закройте открытый короб». Если фактическое количество не совпало с планом, станция попросит указать причину расхождения. После закрытия показываются «Итоги смены».",
            expected: "Смена закрыта, станция вернулась к экрану выбора смены.",
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
                term: "Дубли идут один за другим",
                detail: "Похоже, эта продукция уже сканировалась. Остановитесь, отложите пачку и позовите мастера.",
              },
              {
                term: "Принтер не напечатал этикетку короба",
                detail: "Станция покажет экран «Этикетка короба не напечатана» с вариантами перепечатать или продолжить без этикетки. Действия при сбоях печати подробно описаны в инструкции по исключениям.",
              },
              {
                term: "«Номера для коробов закончились»",
                detail: "Запас номеров SSCC исчерпан в офлайне. Восстановите связь со станцией (позовите администратора), затем вернитесь к работе.",
              },
              {
                term: "Счётчик «Не отправлено» растёт, хотя сеть работает",
                detail: "Не останавливайте работу — сканы не теряются. Сообщите администратору: очередь отправки требует внимания.",
              },
              {
                term: "Сканер перестал читать коды",
                detail: "Проверьте значок «Сканер» в строке состояния и кабель. Если связь не восстановилась — позовите наладчика.",
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

- [ ] **Step 4: CLI-перечисления**

`packages/legal-documents/src/cli/verify-artifacts.ts`:

1. В `LEGAL_DOCUMENT_CODES` добавить `"MKR-INS-02"`.
2. `SAFE_FILE_NAME` заменить на:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-01|pd-02|dpa-01|brd-01|ins-0[12])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 5: Обновить pinned-тесты пакета**

1. `test/registry.test.ts`: pinned-список кодов дополнить `"MKR-INS-02"`; счётчик маршрутов 9 → 10 (4 двуязычных пары + 2 RU-only). Прогнать файл и починить остальные падения по сообщениям — только фактические числа/списки, не ослабляя проверки.
2. `test/artifact-manifest.test.ts`: добавить фикстурную запись MKR-INS-02 (`ru`/`pdfa-2b`, файл `markiro_mkr-ins-02_2026.08-01_ru.pdf`, effectiveDate `2026-08-21` — в фикстуре `artifactEntry()` уже есть per-code ветвление даты) по образцу MKR-INS-01; pinned-счётчики набора: 13 → 14 записей, конвертируемых PDF 9 → 10.

- [ ] **Step 6: Гейты пакета**

Run: `pnpm --filter @markiro/legal-documents test && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents lint`
Expected: всё PASS, включая `instruction-assets.test.ts` (теперь перебирает обе инструкции и сверяет восемь id с файлами Task 1), `content-contract.test.ts` (инструкционные исключения уже действуют), `docx.test.ts` (механизм общий). Prettier — на затронутые файлы.

- [ ] **Step 7: Commit**

```bash
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal-documents): MKR-INS-02 work-cycle instruction content"
```

---

### Task 3: Лендинг — страница и перечисления

**Files:**
- Modify: `apps/landing/src/content/legal-pages.ts` (`DESCRIPTION_BY_CODE`)
- Create: `apps/landing/src/pages/instruktsii/rabochiy-tsikl-skanirovaniya-i-agregatsii/index.astro`
- Modify: `apps/landing/src/lib/legal-artifacts.ts` (`SAFE_FILE_NAME`)
- Test: `apps/landing/src/lib/legal-artifacts.test.ts`, `apps/landing/src/lib/seo.test.ts`, `apps/landing/test/legal-rendered-page.test.ts` (pinned-значения; фактический список падений покажет прогон)

**Interfaces:**
- Consumes: релиз и контент из Task 2; готовый `InstructionDocument.astro` c props `{ page, images: Record<string, string> }`; экспорт ассетов пакета `@markiro/legal-documents/assets/*`.
- Produces: страница `/instruktsii/rabochiy-tsikl-skanirovaniya-i-agregatsii/`; загрузчик артефактов принимает `ins-02`.

- [ ] **Step 1: Прогнать тесты лендинга и зафиксировать базовую линию падений**

Run: `pnpm --filter @markiro/landing test`
Expected: FAIL — как минимум `legal-pages.ts` упадёт на отсутствующем `DESCRIPTION_BY_CODE["MKR-INS-02"]` (satisfies-контракт), pinned-счётчики страниц/sitemap разойдутся, completeness-тест против реального `public/legal` упадёт до Task 4 (это ожидаемо и остаётся красным до генерации).

- [ ] **Step 2: `DESCRIPTION_BY_CODE`**

В `apps/landing/src/content/legal-pages.ts` добавить:

```ts
  "MKR-INS-02": {
    ru: "Печатная инструкция оператора: цикл сканирования, сигналы станции, наполнение и закрытие коробов, работа без сети и закрытие смены.",
    en: "Printable operator instruction: the scanning cycle, station signals, box filling and closing, offline work, and closing the shift.",
  },
```

- [ ] **Step 3: Страница**

Создать `apps/landing/src/pages/instruktsii/rabochiy-tsikl-skanirovaniya-i-agregatsii/index.astro` (по образцу существующей страницы MKR-INS-01 — проверить фактические пути импортов в `apps/landing/src/pages/instruktsii/stantsiya-vkhod-i-start-smeny/index.astro` и повторить их структуру):

```astro
---
import workScanWait from "@markiro/legal-documents/assets/instructions/mkr-ins-02/work-scan-wait.png?url";
import scanOk from "@markiro/legal-documents/assets/instructions/mkr-ins-02/scan-ok.png?url";
import scanDuplicate from "@markiro/legal-documents/assets/instructions/mkr-ins-02/scan-duplicate.png?url";
import scanError from "@markiro/legal-documents/assets/instructions/mkr-ins-02/scan-error.png?url";
import workAggregation from "@markiro/legal-documents/assets/instructions/mkr-ins-02/work-aggregation.png?url";
import boxFull from "@markiro/legal-documents/assets/instructions/mkr-ins-02/box-full.png?url";
import printVerification from "@markiro/legal-documents/assets/instructions/mkr-ins-02/print-verification.png?url";
import offline from "@markiro/legal-documents/assets/instructions/mkr-ins-02/offline.png?url";

import { getLegalDocumentPage } from "../../../content/legal-pages";
import InstructionDocument from "../../../components/InstructionDocument.astro";

const images = {
  "work-scan-wait": workScanWait,
  "scan-ok": scanOk,
  "scan-duplicate": scanDuplicate,
  "scan-error": scanError,
  "work-aggregation": workAggregation,
  "box-full": boxFull,
  "print-verification": printVerification,
  offline,
};
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-02", "ru")} images={images} />
```

- [ ] **Step 4: Загрузчик артефактов**

В `apps/landing/src/lib/legal-artifacts.ts` заменить `SAFE_FILE_NAME`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01|ins-0[12])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 5: Обновить pinned-тесты лендинга**

По фактическим сообщениям из Step 1, ожидаемая арифметика:

- `legal-artifacts.test.ts`: фикстурная запись MKR-INS-02 (`ru`, `pdfa-2b`, `markiro_mkr-ins-02_2026.08-01_ru.pdf`) по образцу MKR-INS-01; счётчики полного набора 13 → 14, `pdfa-2b` 9 → 10, `template-docx` без изменений (4).
- `legal-rendered-page.test.ts`: список кодов реестра `/legal/` + MKR-INS-02; счётчики на `/legal/`: PDF 6 → 7, SHA 8 → 9 (7 PDF + 2 DOCX); `/en/legal/` без изменений.
- `seo.test.ts`: sitemap 32 → 34 (страница RU-only + адрес проверки ревизии).

Проверять не ослабляя: точные равенства остаются точными.

- [ ] **Step 6: Гейты лендинга**

Run: `pnpm --filter @markiro/landing test && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing lint`
Expected: всё PASS, КРОМЕ одного известного падения — completeness-тест `legal-artifacts.test.ts` против реального `public/legal` (PDF появится в Task 4). `astro build` НЕ запускать до Task 4. Prettier — на затронутые файлы.

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src
git commit -m "feat(landing): MKR-INS-02 work-cycle instruction page"
```

---

### Task 4: Артефакт, аттестация, полные гейты

**Files:**
- Modify (генерируется): `apps/landing/public/legal/artifacts.json`; Create: `apps/landing/public/legal/files/markiro_mkr-ins-02_2026.08-01_ru.pdf`
- Modify: `deploy/production/legal-artifacts-attestation.json`
- Modify: `deploy/production/verify-legal-artifacts.mjs` (`RELEASE_ID`, `EXPECTED_PDFS`)
- Test: `deploy/production/test/legal-artifact-attestation.test.mjs`, `deploy/production/test/edge-contract.test.mjs`

**Interfaces:**
- Consumes: всё из задач 1–3; тулчейн: `SOFFICE_BIN=/opt/homebrew/bin/soffice` (LibreOffice 26.2.5.2), `VERAPDF_CONTAINER_RUNTIME="$(command -v docker)"`; docker-команды могут требовать запуска вне sandbox.
- Produces: полный набор из 14 артефактов; аттестация `MKR-LEGAL-2026.08-02-2026-08-21`.

- [ ] **Step 1: Сгенерировать артефакты**

Генератор не умеет инкрементально добавлять артефакт: удалить `apps/landing/public/legal` целиком (каталог git-tracked, восстановим), затем:

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
```

- [ ] **Step 2: Гейт детерминизма**

Run: `git status --porcelain apps/landing/public/legal`
Expected: ТОЛЬКО `artifacts.json` (modified) + `files/markiro_mkr-ins-02_2026.08-01_ru.pdf` (added); `git diff apps/landing/public/legal/artifacts.json` добавляет одну запись, старые хеши нетронуты. Иначе — `git checkout -- apps/landing/public/legal` и BLOCKED с выводом `pdffonts` одного изменившегося файла (первый подозреваемый — шрифты, см. историю MKR-INS-01).

- [ ] **Step 3: Верифицировать и посмотреть PDF**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: `Verified 14 immutable legal artifacts ...`. Открыть новый PDF через Read (страницы 1–5): титул «Станция сканирования: рабочий цикл — проверка и агрегация», шапка «РАБОЧАЯ ИНСТРУКЦИЯ · MKR-INS-02», восемь скриншотов с подписями, «Шаг N.» в каждой секции с шагами, размер < 12 MiB.

- [ ] **Step 4: Аттестация**

1. Посчитать хеши:

```bash
shasum -a 256 apps/landing/public/legal/artifacts.json apps/landing/public/legal/files/markiro_mkr-ins-02_2026.08-01_ru.pdf
```

2. `deploy/production/legal-artifacts-attestation.json`: `releaseId` → `"MKR-LEGAL-2026.08-02-2026-08-21"`, `manifestSha256` → новый хеш `artifacts.json`, в `pdfs` вставить запись MKR-INS-02 после MKR-INS-01 (список отсортирован лексикографически по `fileName`):

```json
    {
      "fileName": "markiro_mkr-ins-02_2026.08-01_ru.pdf",
      "sha256": "<фактический sha256 нового PDF>"
    },
```

3. `deploy/production/verify-legal-artifacts.mjs`: `RELEASE_ID = "MKR-LEGAL-2026.08-02-2026-08-21"`; в `EXPECTED_PDFS` добавить `"markiro_mkr-ins-02_2026.08-01_ru.pdf"` после записи ins-01 (сохранить сортировку).
4. `deploy/production/test/legal-artifact-attestation.test.mjs`: `releaseId`, `manifestSha256`, `releasedPdfNames` (+ins-02 в той же позиции), счётчики `pdfaSpy.calls.length` и `pdfaValidatedFiles.size` 9 → 10.
5. `deploy/production/test/edge-contract.test.mjs`: `assert.equal(artifacts.length, 13)` → `14`.

- [ ] **Step 5: Контрактные и полные гейты**

Run (по очереди, каждая обязана пройти):

```bash
pnpm test:production-bundle:contract
pnpm --filter @markiro/landing build
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
pnpm format:check
```

Expected: всё PASS (включая completeness-тест лендинга — PDF теперь на месте). В `dist` проверить: страница `/instruktsii/rabochiy-tsikl-skanirovaniya-i-agregatsii/index.html` содержит 8 `<img>`, 8 `<figcaption>`; `/legal/index.html` содержит оба кода MKR-INS-01 и MKR-INS-02.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/public/legal deploy/production
git commit -m "feat(legal): publish MKR-INS-02 artifact and attest the new release set"
```

---

## Self-Review Notes

- Spec coverage: аудит фикстур + скриншоты (Task 1 = разделы 2 спеки), документ/контент/реестр/CLI (Task 2 = раздел 1 и часть 3), лендинг (Task 3), артефакт+аттестация+гейты (Task 4). `.prettierignore` для этого плана сделан при коммите самого плана.
- Числовая консистентность: маршруты 10; артефакты 14 (10 PDF + 4 DOCX); лендинг-фикстуры 14/10/4; `/legal/` PDF 7 / SHA 9; sitemap 34; аттестация 10 PDF; edge-contract 14.
- Контент цитирует фактические строки i18n станции; формулировка про закрытие короба («закройте кнопкой "Закрыть короб"») сверяется в Task 1 Step 1 с реальным `WorkScreen`/фикстурой `box-full` — если закрытие автоматическое при заполнении, исполнитель Task 2 правит только текст этого шага по фактическому поведению и фиксирует это в отчёте.
