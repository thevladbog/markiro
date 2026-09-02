# EN-версии станционных инструкций MKR-INS-01…05 — дизайн

**Дата:** 2026-09-02
**Статус:** утверждён (владелец: «ок»)
**Контекст:** второй PR трека «EN-версии + пин шрифтов» (после PR #436 —
пин IBM Plex). Владелец решил: у EN-инструкций EN-скриншоты, у RU — RU.
Станционные доки 01–05 идут первыми, потому что галерея станции уже
умеет `locale=en`, а `en.json` станции полон (615/615 ключей, паритет
гарантирован тестом «missing key throws»). Кабинетные 06–09 — третий PR.

## Объём

EN-версии пяти документов: MKR-INS-01 (вход/старт смены), 02 (рабочий
цикл), 03 (исключения), 04 (настройка рабочего места), 05
(инвентаризация на терминале). Полный перевод контента + 46 EN-кадров
(6+8+8+8+16) + EN-страницы лендинга + 5 EN-PDF в релиз и аттестацию.

RU-сторона не меняется: ревизии, RU-тексты, RU-кадры и RU-PDF остаются
байт-в-байт прежними (прецедент MKR-PD-01: обе локали живут под одной
ревизией). Переиздание не требуется.

## Решение

### 1. Ворота локалей (registry.ts)

`legalReleaseLocales` перестаёт быть «инструкция → только ru»:

```ts
const INSTRUCTION_EN_PUBLISHED: ReadonlySet<LegalDocumentCode> = new Set([
  "MKR-INS-01",
  "MKR-INS-02",
  "MKR-INS-03",
  "MKR-INS-04",
  "MKR-INS-05",
]);

export function legalReleaseLocales(code: LegalDocumentCode): readonly LegalLocale[] {
  if (legalDocumentKind(code) !== "instruction") return ["ru", "en"];
  return INSTRUCTION_EN_PUBLISHED.has(code) ? ["ru", "en"] : ["ru"];
}
```

Это per-code управление публикацией (PR 3 добавит 06–09 в Set). Поле в
записях реестра не заводим: `assertLocaleRoutes` и вся плумбинг-цепочка
(`currentRequests`, verify, landing) уже выводят ожидания из этой
функции, точечный Set меняет одну точку истины вместо тринадцати
записей.

Записи релизов 01–05 получают `en`-маршруты (английские slug'и, `/en/`
префикс обязателен по `assertLocaleRoutes`):

| Код        | en route                                                |
| ---------- | ------------------------------------------------------- |
| MKR-INS-01 | `/en/instructions/station-sign-in-and-shift-start/`     |
| MKR-INS-02 | `/en/instructions/scanning-and-aggregation-work-cycle/` |
| MKR-INS-03 | `/en/instructions/exceptions-and-recovery/`             |
| MKR-INS-04 | `/en/instructions/workstation-setup/`                   |
| MKR-INS-05 | `/en/instructions/terminal-inventory-count/`            |

### 2. Раскладка ассетов по локалям

Было: `assets/instructions/mkr-ins-0X/<id>.png` (одна локаль).
Станет: `assets/instructions/mkr-ins-0X/<locale>/<id>.png`.

- Все существующие RU-кадры (38 у доков 01–05 и 41 у 06–09, всего 79
  PNG) переезжают `git mv` в подпапки `ru/` — единообразие для всех
  девяти доков, PR 3 ничего не перекладывает.
- 46 новых EN-кадров ложатся в `en/` доков 01–05.
- `loadInstructionImages(code)` → `loadInstructionImages(code, locale)`
  (путь `<code>/<locale>`); вызов в `renderDocx` передаёт
  `request.locale`.
- `test/instruction-assets.test.ts`: для каждого активного
  instruction-релиза и каждой локали из `legalReleaseLocales(code)` —
  set-equality image id ↔ файлы `<code>/<locale>/*.png`; лишних
  подпапок нет (состав каталога кода = ровно список локалей).

### 3. Контент: пять переводов

Каждый из пяти модулей `src/documents/station-*.ts` получает `en:`
рядом с `ru:` (тип `LegalDocumentSource["content"]` уже опционально
допускает `en`). Требования к переводу:

- Линза «текст ↔ кадры ↔ i18n» для EN: каждая «кавычка»-цитата UI
  берётся дословно из `apps/station/src/i18n/en.json` и должна быть
  видна на EN-кадре своего шага. Классы допустимых исключений те же,
  что в RU-линзе (параметризованные шаблоны, составные label:value,
  пунктуационные варианты, строки соседних состояний, если проза это
  говорит).
- Контент-контракт: EN-текст содержит «Markiro», не содержит «Маркиро»
  (`content-contract.test.ts` применит правила автоматически, он
  итерирует локали контента).
- image id и порядок шагов идентичны RU-версии (это гарантирует
  set-equality теста ассетов: у ru и en одинаковый набор id).
- Подписи кадров (`image.caption`) переводятся — они входят в
  обязательный searchable-текст PDF (`requiredPdfText` берёт boundary
  и caption-тексты локали).
- Служебная плашка «Снимки экранов сделаны на демонстрационных
  данных…» переводится; контакты оператора остаются кириллическими
  (юридическая идентичность; заодно проходит Cyrillic-гейт EN-PDF, как
  у MKR-PD-01 en).

### 4. EN-кадры: фикстуры и съёмка

Перед съёмкой чинятся утечки RU в фикстурах галереи
(`apps/station/src/dev/StationScreenGallery.tsx`) — строки становятся
локале-зависимыми тернарами по образцу ~90 существующих
(`ru ? "…" : "…"`); RU-ветки дословно сохраняют текущие строки, поэтому
RU-кадры не меняются:

- `productPrintName: "Вода 0,5 л"` (инвентаризационная фикстура);
- `productName: "Вода питьевая 0,5 л / Drinking water 0.5 L"` — в EN
  остаётся только английская половина;
- `lineName: "Тестовая линия А"` в `GALLERY_INVENTORY_TASK`;
- `currentLineName="Тестовая линия А"` (выбор задания) и
  `"Тестовая линия Б"` (подтверждение чужой линии);
- `deviceId: "ТЕРМИНАЛ-02"` (вердикт «дубль на другом терминале»).

`InventoryFixture` при этом получает `locale` (сейчас — единственная
фикстура без него; `FloorHeaderFixture` — образец).

Съёмка: дев-сервер станции (порт 5273),
`?gallery=1&state=<id>&locale=en`, те же 46 состояний, что у RU-кадров
доков 01–05 (маппинг state→frame уже установлен RU-набором). Скрипт
съёмки — временный в `tools/production-browser` (там резолвится
playwright), в коммит не попадает. Контракт галереи
(`station-inventory-tests/gallery.spec.ts`) уже гоняет обе локали;
после правок фикстур прогнать его обязательно (он пинит
«Продолжить INVENTORY-26-0047» на RU-ветке — не задеть).

### 5. Лендинг

- `InstructionDocument.astro`: весь захардкоженный русский хром — в
  локальную карту копий по `page.locale`: «← Реестр документов /
  ← Document registry», «Действует / In force», «Код / Code»,
  «Редакция / Revision», «Действует с / Effective from», «Содержание /
  Contents», «Важно / Important», «Примечание / Note», «Шаг N. /
  Step N.», «Ожидаемый результат: / Expected result:», «Контакты
  оператора / Operator contacts» (+ aria-label'ы). Телефон/адрес — из
  существующего конфига, без изменений.
- Пять новых страниц `src/pages/en/instructions/<slug>/index.astro` по
  образцу RU-страниц: импорт-карта PNG (`…/mkr-ins-0X/en/<id>.png?url`)
  - `getLegalDocumentPage(code, "en")`.
- Пять RU-страниц обновляют пути импортов на `…/ru/<id>.png`.
- `LegalRegistry.astro`: секция инструкций на EN-странице перестаёт
  быть пустой — фильтр по
  `legalReleaseLocales(release.code).includes(metadata.locale)`, ссылка
  и подпись — маршрутом/описанием своей локали (EN-описания всех девяти
  уже лежат в `DESCRIPTION_BY_CODE`).
- `LEGAL_SEARCH_PAGES` уже итерирует `legalReleaseLocales` — EN-страницы
  попадут в реестр/поиск автоматически.

### 6. Артефакты и аттестация

- Релиз: 21 → 26 файлов (PDF 17 → 22, DOCX 4 без изменений). Имена:
  `markiro_mkr-ins-01_2026.09-01_en.pdf`, `…-02_2026.09-01_en`,
  `…-03_2026.09-01_en`, `…-04_2026.08-02_en`, `…-05_2026.09-01_en`.
- Существующие 21 файл остаются байт-в-байт; `artifacts.json`
  дополняется пятью записями (порядок — как выдаёт генератор).
- Генерация на пиненных шрифтах (PR #436), префлайт активен.
- `deploy/production/`: `legal-artifacts-attestation.json` — новый
  releaseId, +5 записей, новый manifestSha;
  `verify-legal-artifacts.mjs` — +5 в `EXPECTED_PDFS`;
  `test/legal-artifact-attestation.test.mjs` — счётчики.

### 7. Тесты (сводка затронутого)

- `registry.test.ts`: ожидания `legalReleaseLocales` (01–05 →
  `["ru","en"]`, 06–09 → `["ru"]`), маршруты en.
- `instruction-assets.test.ts`: per-locale set-equality (п. 2).
- `artifact-manifest.test.ts`: фикстуры +5 EN-записей, счётчики.
- `content-contract.test.ts`: без правок — сам подхватит en-контент.
- `docx.test.ts`: без структурных правок (рендер en уже покрыт
  PD-01/BRD-01); если фикстуры пинят instruction-локали — обновить.
- `apps/landing/src/lib/legal-artifacts.test.ts`: счётчики 21→26 и
  17→22; тест «rejects an English artifact for a Russian-only
  instruction» переключить с MKR-INS-01 на всё ещё ru-only код
  (MKR-INS-06).
- Контракт галереи станции (production-browser) — прогнать после правок
  фикстур.

## Критерии приёмки

1. Тесты пакета, лендинга и админки зелёные; контракт галереи зелёный.
2. `artifacts:generate --check` подтверждает 26 файлов; старые 21 —
   байт-в-байт; `artifacts:verify` зелёный; deploy-тест аттестации
   зелёный.
3. Каждая EN-цитата подтверждена в `en.json` и на EN-кадре своего шага
   (отчёт линзы в PR).
4. RU-страницы и RU-PDF не изменились; `/en/instructions/*` рендерятся
   с EN-хромом и EN-кадрами.
