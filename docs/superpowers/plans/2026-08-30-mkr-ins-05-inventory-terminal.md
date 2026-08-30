# MKR-INS-05 «Инвентаризация: пересчёт на терминале» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пятая печатная инструкция — MKR-INS-05 «Станция сканирования: инвентаризация на терминале» (оператор): RU-страница + PDF/A-артефакт с аттестацией.

**Architecture:** Контентная итерация по конвейеру MKR-INS-01…04. Четыре задачи: аудит фикстур `inventory-*` + скриншоты → контент + реестр + CLI → лендинг → артефакт + аттестация. Финальному whole-branch ревью задаётся линза «текст ↔ скриншоты ↔ i18n» (в INS-03/04 именно она ловила Critical печатного документа).

**Tech Stack:** TypeScript (ESM), Astro, Vitest, node:test, LibreOffice 26.2.5 + veraPDF 1.30.2 (docker), Playwright MCP.

**Спека:** `docs/superpowers/specs/2026-08-30-mkr-ins-05-inventory-terminal-design.md`. Ветка: `claude/mkr-ins-05-inventory-terminal` (от origin/main `6c1482ce0`).

## Global Constraints

- Код `MKR-INS-05`, ревизия `2026.08/01`, effectiveDate `2026-08-30`, статус `active`, RU-only.
- Маршрут: `/instruktsii/inventarizatsiya-na-terminale/`. Артефакт: `markiro_mkr-ins-05_2026.08-01_ru.pdf`, kind `pdfa-2b`.
- Аттестация: release id `MKR-LEGAL-2026.08-05-2026-08-30`; прежние 16 файлов в `apps/landing/public/legal` байт-в-байт.
- Аудитория — оператор на терминале; кабинетская часть (создание и запуск задания) — только упоминанием, подробности будут в MKR-INS-06.
- Цитаты интерфейса — строго из `apps/station/src/i18n/ru.json`, секция `inventory` (+ `shell`/`work` для общих экранов). В станции есть мёртвые i18n-ключи — цитировать только строки, реально отрендеренные компонентами.
- Генераторы: docx 9.7.1, LibreOffice 26.2.5, veraPDF 1.30.2; TTF IBM Plex установлены.
- Prettier `--write` только на затронутые файлы; этот план уже в `.prettierignore`.
- Vitest-фильтр: `pnpm --filter <pkg> exec vitest run <path>`. Коммиты с трейлером `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Аудит фикстур inventory-* и тринадцать скриншотов

**Files:**
- Possibly modify: `apps/station/src/dev/StationScreenGallery.tsx`, `apps/station/src/dev/gallery-fixtures.ts`, `apps/station/test/screen-gallery.test.tsx` (только при расхождении с реальным UI)
- Create: `packages/legal-documents/assets/instructions/mkr-ins-05/{task-selection,other-line,box-accepted,not-in-snapshot,protected,ineligible,duplicate,date-change,repack-old-box,repack-scanning,repack-box-ready,print-recovery,leave-open-box}.png`

**Interfaces:**
- Consumes: dev-галерея `http://localhost:5273/?gallery=1&state=<id>&locale=ru`.
- Produces: тринадцать PNG 1280×800; id = имя файла без `.png` (ссылки контента Task 2).

Соответствие файлов состояниям галереи:

| Файл | `state=` | Что должно быть на экране |
| --- | --- | --- |
| task-selection.png | `inventory-task-selection` | «Отсканируйте штрихкод формы-задания» и/или список «Задания инвентаризации линии «…»» |
| other-line.png | `inventory-other-line-confirmation` | Подтверждение открытия задания другой линии |
| box-accepted.png | `inventory-simple-box-accepted` | Вердикт «Короб принят: N кодов» |
| not-in-snapshot.png | `inventory-not-in-snapshot` | «Код отсутствует в исходном снимке» / бейдж «РАСХОЖДЕНИЕ» |
| protected.png | `inventory-protected-moving-by-ud` | «Код не учтён: уже в отгрузке» / «ЗАЩИЩЁН» |
| ineligible.png | `inventory-known-ineligible` | «Код не участвует в инвентаризации» / «НЕ УЧАСТВУЕТ» |
| duplicate.png | `inventory-duplicate-other-terminal` | «Код уже проверен на другом терминале» / «ДУБЛЬ» |
| date-change.png | `inventory-production-date-change` | Диалог «Сменить дату производства», «Применить дату» |
| repack-old-box.png | `inventory-repack-awaiting-old-box` | «Отсканируйте старый короб» |
| repack-scanning.png | `inventory-repack-scanning` | «Сканируйте каждую бутылку», открытый короб с местами |
| repack-box-ready.png | `inventory-repack-box-ready` | Короб закрыт / печать этикетки ожидается |
| print-recovery.png | `inventory-print-recovery` | Ошибка печати этикетки и «Повторить печать» |
| leave-open-box.png | `inventory-leave-open-box` | Выход из задания при открытом коробе |

- [ ] **Step 1: Сверить фикстуры с реальным UI**

Прочитать реальные компоненты инвентаризации (найти их: `git grep -l "inventory" apps/station/src/pages apps/station/src/ui`; ожидаются экран складских операций/выбора задания, экран проверки продукции, панель переупаковки, печать и перепечатка этикетки), как `App.tsx` их монтирует и какой хром они получают, затем фикстуры `InventoryFixture` (kind `"inventory"`) в `StationScreenGallery.tsx`. Для каждого из тринадцати состояний — диф-лист «реальный экран vs фикстура». Прецеденты починок: `git log --oneline --all --grep="sync.*gallery fixtures"` и `git show <sha> -- apps/station/src/dev` (re-platforming на реальные компоненты с синтетическими пропсами; в MKR-INS-04 все три группы фикстур оказались устаревшими, в MKR-INS-03 — шесть из восьми).

- [ ] **Step 2: Починить расхождения (если есть)**

Реальные компоненты + синтетические данные (Демо-станция 01, Тестовая линия А, SSCC вида 046012345600000016, DEMO-SERIAL-…). Продакшен-код не менять (максимум export) — иначе BLOCKED. Нет расхождений — зафиксировать в отчёте.

- [ ] **Step 3: Гейты станции (если менялись фикстуры)**

Run: `pnpm --filter @markiro/station typecheck && pnpm --filter @markiro/station lint && pnpm --filter @markiro/station test`
Expected: всё PASS; prettier на изменённые файлы.

- [ ] **Step 4: Снять скриншоты**

```bash
mkdir -p packages/legal-documents/assets/instructions/mkr-ins-05
```

`pnpm --filter @markiro/station dev` в фоне (порт 5273, дождаться 200). Для каждой строки таблицы: Playwright MCP `browser_resize` 1280×800 → `browser_navigate` → дождаться отрисовки → `browser_take_screenshot` (png) → скопировать в целевой файл; retina → `sips -Z 1280`. Если `browser_take_screenshot` не отдаёт файл — фолбэк из прошлых итераций: `browser_run_code_unsafe`, вернуть base64 PNG и декодировать локально. Сервер убить.

- [ ] **Step 5: Проверить результат**

Run: `file packages/legal-documents/assets/instructions/mkr-ins-05/*.png`
Expected: тринадцать `PNG image data, 1280 x 800`, каждый < 600 KB. Открыть каждый через Read и сверить с колонкой таблицы; пустые/loading переснять.

- [ ] **Step 6: Commit**

```bash
git add apps/station packages/legal-documents/assets/instructions/mkr-ins-05
git commit -m "feat(legal-documents): MKR-INS-05 inventory screenshots from station gallery"
```

(Фикстурные починки — отдельным первым коммитом `fix(station): sync inventory gallery fixtures with the current UI`.)

---

### Task 2: Пакет — код MKR-INS-05, контент, релиз, CLI-перечисления

**Files:**
- Modify: `packages/legal-documents/src/types.ts`, `packages/legal-documents/src/registry.ts`, `packages/legal-documents/src/cli/verify-artifacts.ts`
- Create: `packages/legal-documents/src/documents/station-inventory-count.ts`
- Test: `packages/legal-documents/test/registry.test.ts`, `packages/legal-documents/test/artifact-manifest.test.ts`

**Interfaces:**
- Consumes: PNG-ассеты Task 1 (тринадцать id из таблицы Task 1); helpers `legalDocumentKind`/`legalReleaseLocales`/`requireLegalContent`, блоки `step`/`callout`.
- Produces: `STATION_INVENTORY_COUNT_CONTENT`; активный релиз `MKR-INS-05/2026.08/01` с маршрутом `/instruktsii/inventarizatsiya-na-terminale/`; `artifactFileName(...)` → `markiro_mkr-ins-05_2026.08-01_ru.pdf`.

- [ ] **Step 1: Базовая линия**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/instruction-assets.test.ts`
Expected: PASS (MKR-INS-05 ещё не зарегистрирован); после Step 2–3 тест обязан пройти уже с пятью инструкциями.

- [ ] **Step 2: Типы, реестр, CLI**

1. `types.ts`: в union `LegalDocumentCode` добавить `"MKR-INS-05"` (prettier сам перенесёт строку при >100 символов).
2. `registry.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-05"`; `LEGAL_DOCUMENT_KIND_BY_CODE` + `"MKR-INS-05": "instruction",`; импорт `STATION_INVENTORY_COUNT_CONTENT` из `./documents/station-inventory-count.js`; в `LEGAL_RELEASES` последним:

```ts
  {
    code: "MKR-INS-05",
    revision: "2026.08/01",
    effectiveDate: "2026-08-30",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/instruktsii/inventarizatsiya-na-terminale/" },
  },
```

и в `LEGAL_DOCUMENTS`:

```ts
  { releaseKey: "MKR-INS-05/2026.08/01", content: STATION_INVENTORY_COUNT_CONTENT },
```

3. `verify-artifacts.ts`: `LEGAL_DOCUMENT_CODES` + `"MKR-INS-05"`; `SAFE_FILE_NAME` → `ins-0[12345]`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-01|pd-02|dpa-01|brd-01|ins-0[12345])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 3: Контент**

Создать `packages/legal-documents/src/documents/station-inventory-count.ts`:

```ts
import type { LegalDocumentSource } from "../types.js";

export const STATION_INVENTORY_COUNT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: инвентаризация на терминале",
    summary:
      "Инструкция оператора для инвентаризации: открытие задания, проверка продукции и вердикты сканирования, переупаковка коробов с печатью этикеток, выход из задания.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инвентаризация — сплошной пересчёт продукции на складе или линии. Задание готовит и запускает менеджер в кабинете, а оператор выполняет пересчёт на терминале: сканирует продукцию, а при необходимости перекладывает её в новые короба. Инструкция описывает работу оператора; вход на станцию — в инструкции MKR-INS-01.",
          },
          {
            kind: "paragraph",
            text: "Задание бывает двух способов: «Без переупаковки» — продукцию только сканируют, короба остаются прежними; «С переупаковкой» — проверенную продукцию перекладывают в новые короба и печатают на них этикетки. Способ выбирает менеджер при создании задания, оператор его не меняет.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Номера заданий, коробов и продукты на вашем терминале будут отличаться.",
          },
        ],
      },
      {
        id: "open-task",
        heading: "2. Открытие задания",
        blocks: [
          {
            kind: "step",
            title: "Откройте складские операции",
            text: "На экране выбора смены переключитесь на «Складские операции». Терминал покажет задания инвентаризации своей линии и предложит отсканировать штрихкод формы-задания.",
            image: { id: "task-selection", caption: "Складские операции: задания инвентаризации линии" },
          },
          {
            kind: "step",
            title: "Отсканируйте штрихкод формы-задания",
            text: "Возьмите распечатанную форму-задание, которую подготовил менеджер, и отсканируйте её штрихкод — задание откроется автоматически. Если формы нет, выберите задание в списке кнопкой «Продолжить».",
            expected: "Терминал показал «Снимок сохранён и готов к автономной работе».",
          },
          {
            kind: "step",
            title: "Подтвердите задание другой линии",
            text: "Если штрихкод относится к заданию другой линии, терминал запросит подтверждение. Открывайте такое задание только по указанию мастера: инвентаризацию считают по назначенной линии.",
            image: { id: "other-line", caption: "Подтверждение задания другой линии" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "После сохранения снимка терминал работает автономно: пересчёт продолжается без сети, а результаты уходят на сервер при восстановлении связи.",
          },
        ],
      },
      {
        id: "verdicts",
        heading: "3. Проверка продукции и вердикты",
        blocks: [
          {
            kind: "paragraph",
            text: "На экране «Проверка продукции» сканируйте бутылку или короб. Скан короба отмечает проверенным всё известное содержимое — это быстрее, чем сканировать бутылки по одной. Счётчики показывают «Проверено», «Расхождения» и «Защищено от учёта».",
          },
          {
            kind: "step",
            title: "«Код принят» и «Короб принят»",
            text: "Зелёный вердикт означает, что позиция учтена. При скане короба терминал сообщает «Короб принят: N кодов» — отдельно сканировать его содержимое не нужно.",
            image: { id: "box-accepted", caption: "Короб принят целиком" },
          },
          {
            kind: "step",
            title: "«Код отсутствует в исходном снимке» — расхождение",
            text: "Продукция есть на складе, но её нет в снимке задания. Скан сохраняется как расхождение — отложите такую продукцию отдельно и продолжайте пересчёт. Разбираться с расхождениями будет менеджер.",
            image: { id: "not-in-snapshot", caption: "Расхождение: кода нет в снимке задания" },
          },
          {
            kind: "step",
            title: "«Код не учтён: уже в отгрузке»",
            text: "Код защищён от учёта: продукция уже отгружена или выведена из оборота. Терминал её не засчитывает — уберите такую продукцию из пересчитываемой партии.",
            image: { id: "protected", caption: "Защищённый код: продукция уже в отгрузке" },
          },
          {
            kind: "step",
            title: "«Код не участвует в инвентаризации»",
            text: "Продукция не подходит под параметры задания: другой продукт или дата производства вне заданного периода. В пересчёт она не идёт — отложите её и продолжайте.",
            image: { id: "ineligible", caption: "Код не участвует в этом задании" },
          },
          {
            kind: "step",
            title: "«ДУБЛЬ» — код уже проверен",
            text: "«Код уже проверен на этом терминале» или «Код уже проверен на другом терминале» означает, что позицию посчитали раньше. Повторно её не сканируйте и не перекладывайте: она уже учтена.",
            image: { id: "duplicate", caption: "Дубль: код уже проверен на другом терминале" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "«Код не распознан» — отсканирован не код маркировки: расправьте упаковку и повторите скан. «Скан не сохранён — повторите сканирование» означает, что терминал не записал результат: повторите скан этой же позиции.",
          },
        ],
      },
      {
        id: "production-date",
        heading: "4. Дата производства",
        blocks: [
          {
            kind: "step",
            title: "Переключите дату при смене партии",
            text: "Терминал приписывает сканы к указанной дате производства. Переходя к продукции другой даты, нажмите «Изменить» рядом с датой, выберите нужную и подтвердите кнопкой «Применить дату». Новая дата действует со следующего принятого скана — уже сделанные сканы не меняются.",
            image: { id: "date-change", caption: "Смена даты производства" },
          },
        ],
      },
      {
        id: "repack",
        heading: "5. Способ «С переупаковкой»",
        blocks: [
          {
            kind: "step",
            title: "Отсканируйте старый короб",
            text: "Переупаковка идёт коробами: сначала отсканируйте этикетку старого короба, из которого перекладываете продукцию.",
            image: { id: "repack-old-box", caption: "Переупаковка: терминал ждёт скан старого короба" },
            expected: "Терминал показал «Старый короб выбран» и открыл новый короб.",
          },
          {
            kind: "step",
            title: "Сканируйте каждую бутылку в новый короб",
            text: "Перекладывайте продукцию по одной, сканируя каждую единицу: терминал показывает занятые и свободные места в открытом коробе. «Бутылка добавлена в новый короб» — позиция уложена; «Скан сохранён, но бутылка не добавлена» — позиция учтена как расхождение и в новый короб не идёт.",
            image: { id: "repack-scanning", caption: "Наполнение нового короба" },
          },
          {
            kind: "step",
            title: "Закройте короб",
            text: "Когда короб набран, терминал закрывает его и отправляет этикетку на печать. Неполный короб закрывается кнопкой «Закрыть неполный короб». Ошибочно добавленную позицию уберите кнопкой «Убрать последнюю бутылку», а весь набор — кнопкой «Очистить открытый короб».",
            image: { id: "repack-box-ready", caption: "Короб закрыт, ожидается печать этикетки" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "«Короб заблокирован из-за конфликта» — короб уже обработан другим терминалом; очистите конфликт и продолжайте с другим коробом. «Короб аннулирован администратором» — работу по нему прекратите и сообщите мастеру.",
          },
        ],
      },
      {
        id: "printing",
        heading: "6. Печать этикетки нового короба",
        blocks: [
          {
            kind: "step",
            title: "Наклейте напечатанную этикетку",
            text: "После закрытия короба терминал печатает этикетку с новым номером SSCC. Наклейте её на этот короб сразу — короб без этикетки нельзя опознать на складе.",
            expected: "Терминал показал «Этикетка напечатана».",
          },
          {
            kind: "step",
            title: "Если этикетка не напечатана",
            text: "Терминал сообщит причину: «В задании нет шаблона этикетки», «Принтер не настроен», «Не удалось подготовить этикетку» или «Принтер не подтвердил печать». Устраните причину (лента, кабель, замятие) и нажмите «Повторить печать»; кнопка «Настроить принтер» открывает настройку рабочего места.",
            image: { id: "print-recovery", caption: "Этикетка не напечатана: повтор печати" },
          },
          {
            kind: "step",
            title: "Перепечатайте потерянную этикетку",
            text: "Откройте «Перепечатать этикетку короба» и введите не менее четырёх цифр номера SSCC — подходящие короба появятся сами. Выберите нужный и нажмите «Перепечатать». Старую этикетку, если она нашлась, уничтожьте: на коробе должна остаться одна.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "«Результат печати не сохранился. Повторите с тем же SSCC» — не создавайте новый короб: повторите печать для того же номера, иначе на складе появятся два короба с одинаковым содержимым.",
          },
        ],
      },
      {
        id: "leave",
        heading: "7. Выход из задания",
        blocks: [
          {
            kind: "step",
            title: "Завершите работу кнопкой «Выйти из задания»",
            text: "Терминал дошлёт накопленные события на сервер и вернётся к списку заданий. Счётчик «Неотправленных событий» показывает очередь — дождитесь её отправки, если сеть доступна.",
            image: { id: "leave-open-box", caption: "Выход из задания с открытым коробом" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "При переупаковке перед выходом закройте открытый короб или очистите его — иначе уложенная продукция останется без этикетки и учёта.",
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
                term: "Штрихкод формы-задания не читается",
                detail: "Выберите задание из списка на экране складских операций кнопкой «Продолжить» — форма нужна только для быстрого открытия.",
              },
              {
                term: "Для линии нет заданий инвентаризации",
                detail: "Задание ещё не запущено менеджером или назначено другой линии. Уточните у мастера; производственные смены при этом остаются доступны.",
              },
              {
                term: "Много расхождений подряд",
                detail: "Похоже, пересчитывается не та партия или не тот продукт. Остановитесь и сверьтесь с мастером — расхождения останутся в результате инвентаризации.",
              },
              {
                term: "Терминал не в сети во время пересчёта",
                detail: "Работайте дальше: снимок задания сохранён локально, сканы уйдут на сервер при восстановлении связи.",
              },
              {
                term: "Закрыл короб, а этикетки нет",
                detail: "Перепечатайте её по номеру SSCC (раздел 6). Пока этикетки нет, короб нельзя отправлять на склад.",
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

Примечание для исполнителя: перед коммитом сверить каждую цитату с `apps/station/src/i18n/ru.json` (секция `inventory`) И с фактическими скриншотами Task 1 — если строка в словаре есть, но на экране не отображается (мёртвый ключ, прецедент MKR-INS-04) или названа иначе, поправить формулировку по факту и зафиксировать в отчёте. Контент-контракт: термины definition-list не должны заканчиваться пунктуацией.

- [ ] **Step 4: Pinned-тесты пакета**

1. `test/registry.test.ts`: pinned-список кодов + `"MKR-INS-05"`; счётчик уникальных маршрутов 12 → 13 (строка `expect(new Set(LEGAL_RELEASES.flatMap(...)).size).toBe(12)`).
2. `test/artifact-manifest.test.ts`: фикстурная запись MKR-INS-05 (`ru`/`pdfa-2b`, файл `markiro_mkr-ins-05_2026.08-01_ru.pdf`, effectiveDate `2026-08-30` в per-code ветвлении `artifactEntry()`); счётчики 16 → 17 записей, PDF 12 → 13 (включая счётчики генерации и списка запросов в том же файле).
Править по фактическим падениям, не ослабляя.

- [ ] **Step 5: Гейты пакета**

Run: `pnpm --filter @markiro/legal-documents test && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents lint`
Expected: всё PASS (instruction-assets — пять инструкций). Prettier на затронутые файлы.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal-documents): MKR-INS-05 inventory terminal instruction content"
```

---

### Task 3: Лендинг — страница и перечисления

**Files:**
- Modify: `apps/landing/src/content/legal-pages.ts`, `apps/landing/src/lib/legal-artifacts.ts`
- Create: `apps/landing/src/pages/instruktsii/inventarizatsiya-na-terminale/index.astro`
- Test: `apps/landing/src/lib/legal-artifacts.test.ts`, `apps/landing/src/lib/seo.test.ts`, `apps/landing/test/legal-rendered-page.test.ts`

**Interfaces:**
- Consumes: релиз/контент Task 2; `InstructionDocument.astro` (`{ page, images: Record<string, string> }`).
- Produces: страница `/instruktsii/inventarizatsiya-na-terminale/`; загрузчик принимает `ins-05`.

- [ ] **Step 1: Базовая линия падений**

Run: `pnpm --filter @markiro/landing test`
Expected: FAIL — `DESCRIPTION_BY_CODE` без MKR-INS-05 (satisfies), pinned-счётчики, completeness против реального `public/legal` (красный до Task 4 вместе с build-зависимыми сьютами). Если vitest не резолвит `@markiro/legal-documents` или даёт ложно-зелёную базу — сначала `pnpm --filter @markiro/legal-documents build`.

- [ ] **Step 2: `DESCRIPTION_BY_CODE`**

```ts
  "MKR-INS-05": {
    ru: "Печатная инструкция оператора для инвентаризации: открытие задания, вердикты сканирования, переупаковка коробов и печать этикеток.",
    en: "Printable operator instruction for stock counts: opening a task, scan verdicts, repacking boxes, and label printing.",
  },
```

- [ ] **Step 3: Страница**

Создать `apps/landing/src/pages/instruktsii/inventarizatsiya-na-terminale/index.astro` (зеркало соседних страниц в `apps/landing/src/pages/instruktsii/`):

```astro
---
import taskSelection from "@markiro/legal-documents/assets/instructions/mkr-ins-05/task-selection.png?url";
import otherLine from "@markiro/legal-documents/assets/instructions/mkr-ins-05/other-line.png?url";
import boxAccepted from "@markiro/legal-documents/assets/instructions/mkr-ins-05/box-accepted.png?url";
import notInSnapshot from "@markiro/legal-documents/assets/instructions/mkr-ins-05/not-in-snapshot.png?url";
import protectedCode from "@markiro/legal-documents/assets/instructions/mkr-ins-05/protected.png?url";
import ineligible from "@markiro/legal-documents/assets/instructions/mkr-ins-05/ineligible.png?url";
import duplicate from "@markiro/legal-documents/assets/instructions/mkr-ins-05/duplicate.png?url";
import dateChange from "@markiro/legal-documents/assets/instructions/mkr-ins-05/date-change.png?url";
import repackOldBox from "@markiro/legal-documents/assets/instructions/mkr-ins-05/repack-old-box.png?url";
import repackScanning from "@markiro/legal-documents/assets/instructions/mkr-ins-05/repack-scanning.png?url";
import repackBoxReady from "@markiro/legal-documents/assets/instructions/mkr-ins-05/repack-box-ready.png?url";
import printRecovery from "@markiro/legal-documents/assets/instructions/mkr-ins-05/print-recovery.png?url";
import leaveOpenBox from "@markiro/legal-documents/assets/instructions/mkr-ins-05/leave-open-box.png?url";

import { getLegalDocumentPage } from "../../../content/legal-pages";
import InstructionDocument from "../../../components/InstructionDocument.astro";

const images = {
  "task-selection": taskSelection,
  "other-line": otherLine,
  "box-accepted": boxAccepted,
  "not-in-snapshot": notInSnapshot,
  protected: protectedCode,
  ineligible,
  duplicate,
  "date-change": dateChange,
  "repack-old-box": repackOldBox,
  "repack-scanning": repackScanning,
  "repack-box-ready": repackBoxReady,
  "print-recovery": printRecovery,
  "leave-open-box": leaveOpenBox,
};
---

<InstructionDocument page={getLegalDocumentPage("MKR-INS-05", "ru")} images={images} />
```

- [ ] **Step 4: Загрузчик артефактов**

`apps/landing/src/lib/legal-artifacts.ts`:

```ts
const SAFE_FILE_NAME =
  /^markiro_mkr-(?:pd-0[12]|dpa-01|brd-01|ins-0[12345])_\d{4}\.\d{2}-\d{2}_(?:ru|en)\.(?:pdf|docx)$/;
```

- [ ] **Step 5: Pinned-тесты лендинга**

Ожидаемая арифметика (править по фактическим падениям; расхождение — investigate, прецедент: в MKR-INS-02 арифметика плана оказалась неверной и реальная база победила):
- `legal-artifacts.test.ts`: запись MKR-INS-05; 16 → 17 всего, `pdfa-2b` 12 → 13, `template-docx` 4.
- `legal-rendered-page.test.ts` (строки ~169–170): `/legal/` PDF 8 → 9, SHA 10 → 11; `/en/legal/` без изменений (4 и 6).
- `seo.test.ts` (строка ~144): sitemap `<url>` 56 → 58.

- [ ] **Step 6: Гейты лендинга**

Run: `pnpm --filter @markiro/landing test && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing lint`
Expected: PASS, кроме известных красных (completeness + build-зависимые — до Task 4). Build не запускать. Prettier на затронутые файлы.

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src apps/landing/test
git commit -m "feat(landing): MKR-INS-05 inventory terminal instruction page"
```

---

### Task 4: Артефакт, аттестация, полные гейты

**Files:**
- Modify (генерируется): `apps/landing/public/legal/artifacts.json`; Create: `apps/landing/public/legal/files/markiro_mkr-ins-05_2026.08-01_ru.pdf`
- Modify: `deploy/production/legal-artifacts-attestation.json`, `deploy/production/verify-legal-artifacts.mjs`
- Test: `deploy/production/test/legal-artifact-attestation.test.mjs`, `deploy/production/test/edge-contract.test.mjs`

**Interfaces:**
- Consumes: задачи 1–3; тулчейн SOFFICE_BIN=/opt/homebrew/bin/soffice (LibreOffice 26.2.5.2), VERAPDF_CONTAINER_RUNTIME=docker (sandbox off для docker-команд; таймауты до 600000 мс). Прецедент аттестации: `git log --oneline --all --grep="attest the new release set"` и `git show <sha> -- deploy/production`.
- Produces: набор из 17 артефактов; аттестация `MKR-LEGAL-2026.08-05-2026-08-30`.

- [ ] **Step 1: Генерация**

Удалить `apps/landing/public/legal` целиком, затем:

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
```

- [ ] **Step 2: Гейт детерминизма**

`git status --porcelain apps/landing/public/legal` → ТОЛЬКО artifacts.json (M) + новый PDF (A); diff манифеста — одна вставка, старые хеши нетронуты. Иначе restore (`git checkout -- apps/landing/public/legal`) + BLOCKED с `pdffonts` одного изменившегося файла.

- [ ] **Step 3: Верификация и просмотр**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
```

Expected: `Verified 17 immutable legal artifacts`. Read PDF (страницы 1–5): титул «Станция сканирования: инвентаризация на терминале», шапка «РАБОЧАЯ ИНСТРУКЦИЯ · MKR-INS-05», 13 скриншотов с подписями, «Шаг N.», < 12 MiB.

- [ ] **Step 4: Аттестация**

1. `shasum -a 256 apps/landing/public/legal/artifacts.json apps/landing/public/legal/files/markiro_mkr-ins-05_2026.08-01_ru.pdf`
2. `legal-artifacts-attestation.json`: `releaseId` → `"MKR-LEGAL-2026.08-05-2026-08-30"`, `manifestSha256` → новый, запись ins-05 после ins-04 (лексикографический порядок), фактический sha256.
3. `verify-legal-artifacts.mjs`: `RELEASE_ID` → тот же id; `EXPECTED_PDFS` + `"markiro_mkr-ins-05_2026.08-01_ru.pdf"` после ins-04.
4. `legal-artifact-attestation.test.mjs`: `releaseId`, `manifestSha256`, `releasedPdfNames` (+ins-05), счётчики 12 → 13.
5. `edge-contract.test.mjs` (строка ~941): `artifacts.length` 16 → 17.

- [ ] **Step 5: Полные гейты**

```bash
pnpm test:production-bundle:contract
pnpm --filter @markiro/landing build
pnpm --filter @markiro/legal-documents lint && pnpm --filter @markiro/legal-documents typecheck && pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing lint && pnpm --filter @markiro/landing typecheck && pnpm --filter @markiro/landing test
pnpm format:check
```

Expected: всё PASS. В dist: новая страница 13 `<img>` / 13 `<figcaption>`; `/legal/index.html` содержит MKR-INS-01…05.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/public/legal deploy/production
git commit -m "feat(legal): publish MKR-INS-05 artifact and attest the new release set"
```

---

## Self-Review Notes

- Spec coverage: фикстуры+скрины (T1 = раздел 2 спеки), документ/контент/CLI (T2 = раздел 1 и часть 3), лендинг (T3), артефакт+аттестация (T4). Оба способа и печать — в контенте T2 (разделы 5–6 документа), кабинетская часть только упоминанием (раздел 1).
- Числа: маршруты 13; артефакты 17 (13 PDF + 4 DOCX); лендинг-фикстуры 17/13/4; `/legal/` PDF 9 / SHA 11; sitemap 58; аттестация 13 PDF; edge-contract 17.
- Image ids: все тринадцать используются ровно один раз; список в T1, T2 и T3 идентичен.
- Контент несёт явное стоп-условие сверки цитат с i18n И со скриншотами Task 1 (мёртвые ключи — известный риск станции).
- Процессное требование спеки: финальному whole-branch ревью — линза «текст ↔ скриншоты ↔ i18n» (задаётся контролёром при диспатче).
