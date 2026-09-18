# Импорт шаблона этикетки из JSON и экспорт в JSON — Design Spec

**Date:** 2026-09-18

**Status:** Implemented (branch claude/label-editor-json-import-7c4234, 2026-09-18)

**Scope:** Диалог «Импорт кода» в редакторе этикеток принимает третий формат — JSON
модели шаблона, тот же, что принимает `POST /label-templates`. Рядом со «Скачать ZPL»
и «Скачать TSPL» появляется «Скачать JSON», так что шаблон можно выгрузить, поправить
в текстовом редакторе и вставить обратно без потерь. Попутно ZPL-импортёр начинает
читать число строк из `^FB`, из-за чего сегодня после импорта любой текст режется в
одну строку.

**Related:**

- `docs/superpowers/specs/2026-08-11-label-editor-redesign-and-code-import-design.md` —
  диалог импорта, поток «проверить → подтвердить → заменить», предупреждения о
  неподдерживаемых строках. Эта спека расширяет тот же диалог, а не заводит новый.
- `docs/superpowers/specs/2026-08-20-label-editor-simplification-design.md` — редактор
  стал формой настроек плюс импорт; импорт — единственный способ задать содержимое.
- `docs/superpowers/specs/2026-09-10-dpi-neutral-label-templates-design.md` — `dpi` и
  `language` в spec это авторское разрешение и язык, станция подставляет свои.
- `packages/domain/src/labels/model.ts` — `labelTemplateSpecSchema`, единственная
  модель шаблона; её же проверяет API (`apps/api/src/modules/label-templates/dto.ts`)
  и публикует OpenAPI.

## Задача

Редактор этикеток с августа работает только через импорт: единственный путь задать
содержимое — вставить ZPL или TSPL в диалог «Импорт кода». У этого пути три дыры.

1. **ZPL-импортёр теряет переносы.** Эмиттер пишет `^FB<ширина>,<строк>,0,<выравн.>,0`,
   а импортёр (`zpl-import.ts`, ветка `case "FB"`) читает только ширину и выравнивание.
   Второй параметр игнорируется, `maxLines` никогда не выставляется, и текст после
   импорта режется в одну строку. Круговой прогон «скачал ZPL → вставил обратно» портит
   любой многострочный шаблон.
2. **TSPL переносов не умеет вообще.** Эмиттер TSPL рисует переносимый текст растром,
   команду `BLOCK` не использует, импортёру восстанавливать нечего.
3. **Полную модель нельзя ни вставить, ни получить.** JSON-модель (`maxLines`,
   `maxWidthMm`, `align`, `bold`, `moduleWidthMm`, `textFormat`) уже принимает API, но в
   редактор её не подать, и из редактора её не выгрузить. Сегодня, чтобы создать
   шаблон с переносами, нужно слать `fetch` в консоли браузера.

## Решение

1. JSON — третий вариант в селекте формата того же диалога. Поток «вставил → проверил
   → подтвердил предупреждения → заменил» общий для всех трёх форматов.
2. Проверку JSON выполняет та же функция, что и API (`parseLabelTemplate`). Отдельной
   грамматики нет; что принимает API, то принимает редактор, и наоборот.
3. Кнопка «Скачать JSON» выгружает `{ name, purpose, spec }` текущего состояния
   редактора. Файл можно вставить обратно в диалог или отправить в API без правок.
4. ZPL-импортёр читает второй параметр `^FB` в `maxLines`.

## Не входит

- Загрузка файлом и drag-and-drop: диалог остаётся текстовым полем; файл открывают в
  редакторе и вставляют.
- Переносы в TSPL-импорте (`BLOCK`).
- Применение `enabled` и `chzProductGroupCodes` из вставленного тела запроса: у
  редактора свои переключатели включения и области.
- JSON-версии галереи `examples/labels`: образцы остаются в ZPL.
- Изменения API и OpenAPI: контракт `POST /label-templates` не меняется.

## 1. Домен (`packages/domain/src/labels/`)

### 1.1 Форматы

```ts
export type LabelCodeLanguage = "zpl" | "tspl"; // как сейчас: язык кода и spec.language
export type LabelImportFormat = LabelCodeLanguage | "json"; // что выбирают в диалоге
```

`parseLabelCode` не меняется: ZPL и TSPL по-прежнему требуют DPI импорта. Для JSON
отдельная точка входа, DPI ей не нужен — он внутри документа.

### 1.2 `parseLabelJson`

Новый модуль `json-import.ts`:

```ts
export interface ParseLabelJsonOptions {
  purpose: LabelTemplatePurpose; // назначение редактируемого шаблона
}

export interface LabelJsonImportResult extends LabelImportResult {
  /** `name` из обёртки `{ name, purpose, spec }`, если она была и имя непустое. */
  name?: string;
}

export function parseLabelJson(
  input: string,
  options: ParseLabelJsonOptions,
): LabelJsonImportResult;
```

Порядок шагов:

1. `assertImportInputLimits` — тот же лимит 256 КБ, что у кода
   (`LABEL_CODE_TOO_LARGE`).
2. `JSON.parse`. Синтаксическая ошибка → `DomainError("LABEL_CODE_INVALID")` с
   сообщением парсера: в нём есть позиция, этого достаточно.
3. Корень должен быть объектом (не массив, не `null`, не примитив), иначе
   `LABEL_CODE_INVALID` «expected a label template object».
4. **Обёртка.** Если у корня есть ключ `spec`:
   - `spec` — объект → кандидат на разбор это `spec`;
   - `spec` — не объект → `LABEL_CODE_INVALID` «spec must be an object»;
   - `name` — строка с непустым trim → возвращается в `result.name` после trim и
     обрезки до 200 символов (лимит API на имя шаблона);
   - `purpose` — строка, не равная `options.purpose` → предупреждение
     `PURPOSE_MISMATCH` (см. 1.3);
   - остальные ключи обёртки (`id`, `enabled`, `chzProductGroupCodes`, `createdAt`,
     `updatedAt`, что угодно) игнорируются **молча**: обёртка не макет, ответ `GET`
     должен вставляться без шума.

   Если ключа `spec` нет, кандидат — сам корень («голый» spec).

5. **Неизвестные свойства внутри spec.** Кандидат прогоняется через строгий вариант
   той же схемы — `z.strictObject` над теми же shape-ами элементов и корня, собранный в
   `model.ts` рядом с `labelTemplateSpecSchema`, чтобы два варианта не разъезжались.
   Каждая issue `unrecognized_keys` даёт по предупреждению `UNKNOWN_PROPERTY` на
   каждый ключ: `source` — путь через точку в формате `parseLabelTemplate`
   (`elements.3.maxlines`, для корня просто `foo`), `line: null`. Строгий вариант
   служит только для сбора ключей; его прочие issues не используются. Сбор идёт
   рекурсивно и через `invalid_union`: `data` штрихкода — union, и лишний ключ в
   `{ literal, foo }` приходит вложенным в issue union-а, а не на верхнем уровне.
6. Лимит элементов: `elements.length > MAX_LABEL_CODE_ELEMENTS` (1000) →
   `LABEL_CODE_LIMIT`, как у ZPL/TSPL. Проверяется до схемы, если `elements` массив.
7. `parseLabelTemplate(candidate)` — та же проверка, что в API. `DomainError`
   `LABEL_INVALID` пробрасывается как есть: в `cause` уже лежит полный список
   `{ path, message }`, диалог показывает его целиком, а не первую ошибку.
8. Результат: `{ spec, warnings, sourceLineByElementId: {}, name? }`. Ключ `name`
   присутствует только когда есть значение (`exactOptionalPropertyTypes`).

Подгонка к границам этикетки (`fitSpecElements`) остаётся в админке, как у ZPL.

### 1.3 Тип предупреждения

```ts
export type LabelImportWarningCode =
  | "UNSUPPORTED_COMMAND" // ZPL/TSPL: строка будет отброшена (как сейчас)
  | "UNKNOWN_PROPERTY" // JSON: свойство вне модели, схема его отбросит
  | "PURPOSE_MISMATCH"; // JSON: purpose обёртки не совпадает с шаблоном

export interface LabelImportWarning {
  code: LabelImportWarningCode;
  message: string; // английский текст для не-UI потребителей
  /** Строка исходника (с 1) для ZPL/TSPL; `null` для JSON, где `source` — путь. */
  line: number | null;
  source: string;
}
```

Для `PURPOSE_MISMATCH` `source` = `purpose: "pallet"` (значение из JSON). ZPL/TSPL
импортёры не меняют выдачу: их тесты с `toEqual([...])` продолжают проходить.

### 1.4 ZPL `^FB`

`^FBширина,строк,межстрочный,выравнивание,отступ`. Импортёр читает второй параметр:

- целое ≥ 2 → `state.maxLines = min(n, 16)` (16 — потолок схемы; предупреждения нет,
  у одного поля этикетки столько строк не бывает);
- отсутствует, меньше 2, не целое → как сейчас: ключа `maxLines` в элементе нет.

Однострочные шаблоны импортируются байт в байт как раньше. Круговой прогон
`generateZpl` → `parseZplLabel` сохраняет `maxLines`.

## 2. Админка (`apps/admin/src/pages/labels/editor/`)

### 2.1 Разбиение диалога

`ImportCodeDialog.tsx` сегодня держит и разбор, и панель полей, и разметку.
Чтобы JSON-ветка не раздула его, логика уезжает в два модуля без DOM:

- `import-analysis.ts` — чистая функция

  ```ts
  export type ImportAnalysisError =
    | { kind: "elementTooLarge" }
    | { kind: "message"; message: string }
    | { kind: "issues"; issues: Array<{ path: string; message: string }> };

  export interface ImportAnalysis {
    result: LabelImportResult;
    adjustedIds: string[];
    name?: string;
  }

  export function analyzeImport(input: {
    source: string;
    format: LabelImportFormat;
    dpi: 203 | 300;
    purpose: LabelTemplatePurpose;
  }): { ok: true; analysis: ImportAnalysis } | { ok: false; error: ImportAnalysisError };
  ```

  ZPL/TSPL → `parseLabelCode`; JSON → `parseLabelJson`; затем общий
  `fitSpecElements` (ошибка `ELEMENT_TOO_LARGE` → `{ kind: "message" }` с текстом
  `elementTooLarge`, как сейчас). `DomainError` с массивом `cause` → `{ kind: "issues" }`;
  любая другая ошибка → `{ kind: "message" }`.

- `ImportFieldsPanel.tsx` — панель «Шаблонные поля» с пропом
  `syntax: "placeholder" | "json"`.

`ImportCodeDialog.tsx` остаётся оболочкой: селекты, textarea, сводка, футер.

### 2.2 Поведение диалога

- Селект формата: `zpl` «ZPL», `tspl` «TSPL (TSC)», `json` «JSON (Markiro)». Начальное
  значение — `spec.language` текущего шаблона, как сейчас.
- Селект DPI рендерится только для ZPL/TSPL. Для JSON `dpi` и `language` берутся из
  документа.
- Подпись textarea: для кода — существующий `codeLabel` («Код ZPL»), для JSON — новый
  `jsonLabel` («JSON шаблона»).
- «Проверить код» вызывает `analyzeImport`. Сводка одна на все форматы: число
  элементов, размер, число прижатых к границам.
- Ошибки: `kind: "message"` — одна строка в `role="alert"`, как сейчас;
  `kind: "issues"` — список `<code>путь</code> сообщение`, по строке на issue.
- Предупреждения: блок общий, тексты по коду:
  - заголовок: для кода — существующий `unsupportedTitle`; для JSON — новый
    `warningsTitle` («Предупреждения: {{count}}»);
  - строка: `UNSUPPORTED_COMMAND` — `строка: <code>источник</code>` как сейчас;
    `UNKNOWN_PROPERTY` — `<code>elements.3.maxlines</code>` + «свойство не входит в
    модель и будет отброшено»; `PURPOSE_MISMATCH` — `<code>purpose: "pallet"</code>`
    - «не совпадает с назначением шаблона, макет будет импортирован как есть»;
  - чекбокс подтверждения: для кода — существующий `acknowledge`; для JSON — новый
    `acknowledgeWarnings` («Продолжить с этими предупреждениями ({{count}})»).
    «Заменить этикетку» доступна только при пустом списке или отмеченном чекбоксе — как
    сейчас.
- Панель полей в режиме JSON показывает голые идентификаторы (`product.printName`),
  «Копировать» кладёт в буфер идентификатор без скобок, подсказка: «Подставьте как
  значение `field` у текста или `data` у штрихкода».
- Любое изменение источника, формата или DPI сбрасывает анализ — как сейчас.
- «Заменить этикетку» вызывает `onReplace(analysis)`. В `index.tsx`
  `handleImportReplace` делает то же, что сегодня, плюс: если `analysis.name` задано, а
  имя шаблона пустое или равно стандартному имени нового шаблона
  (`pages.labels.editor.defaultName`), имя заменяется на `analysis.name`. Введённое
  руками или сохранённое имя не трогается.

### 2.3 Экспорт

- `download.ts`: `buildJsonBlob(payload: { name: string; purpose: LabelTemplatePurpose;
spec: LabelTemplateSpec }): Blob` — `JSON.stringify(payload, null, 2) + "\n"`, тип
  `application/json`. **Без** `latin1ToUint8Array`: JSON — текст, кириллица в имени и
  надписях должна уйти в UTF-8. Это надо проговорить в комментарии модуля, потому что
  весь остальной модуль объясняет, почему для ZPL/TSPL так делать нельзя.
- `index.tsx`: третья кнопка «Скачать JSON» после TSPL, `handleDownload("json")`, имя
  файла `${safeFileName(name)}.json`. Порядок ключей `name, purpose, spec`. Берётся
  текущее состояние редактора, включая несохранённое, как у ZPL/TSPL.
- Круговой прогон: импорт скачанного файла в шаблон того же назначения даёт
  deep-equal `spec`, ноль предупреждений и то же имя.

### 2.4 Тексты (RU/EN)

Новые ключи в `pages.labels.editor.import`: `jsonLabel`, `warningsTitle`,
`acknowledgeWarnings`, `warningUnknownProperty`, `warningPurposeMismatch`,
`fieldsHintJson`, `issuesTitle`. Кнопка: `pages.labels.editor.download` с
`format: "JSON"` — ключ существующий.

Подсказка пустого состояния (`pages.labels.editor.empty`): «Содержимое этикетки не
задано — импортируйте код ZPL, TSPL или JSON.» и английский аналог.

## 3. Ошибки и предупреждения

| Ситуация                                       | Результат                                         |
| ---------------------------------------------- | ------------------------------------------------- |
| Текст больше 256 КБ                            | блокирующая, `LABEL_CODE_TOO_LARGE`               |
| Синтаксическая ошибка JSON                     | блокирующая, сообщение парсера с позицией         |
| Корень не объект; `spec` есть, но не объект    | блокирующая, `LABEL_CODE_INVALID`                 |
| Больше 1000 элементов                          | блокирующая, `LABEL_CODE_LIMIT`                   |
| Схема не прошла                                | блокирующая, список «путь: сообщение», все issues |
| Элемент больше этикетки                        | блокирующая, `elementTooLarge` (как у ZPL)        |
| Элемент выходит за границы                     | прижат, попадает в счётчик «прижато к границам»   |
| Неизвестное свойство внутри `spec`             | предупреждение `UNKNOWN_PROPERTY`, нужен чекбокс  |
| `purpose` обёртки ≠ назначению шаблона         | предупреждение `PURPOSE_MISMATCH`, нужен чекбокс  |
| Ключи обёртки кроме `name`, `purpose`, `spec`  | молча игнорируются                                |
| `name` обёртки при введённом/сохранённом имени | игнорируется, имя не меняется                     |

Отмена, закрытие диалога и любая ошибка оставляют редактор нетронутым — как сейчас.

## 4. Тесты

Домен (`packages/domain/test/labels-json-import.test.ts`, новый; `labels-import.test.ts`):

- голый spec из примера задачи → тот же объект, ноль предупреждений, `name` отсутствует;
- обёртка `{ name, purpose, spec }` → `name` возвращён, `purpose` совпал → без
  предупреждений; не совпал → `PURPOSE_MISMATCH` с `source: 'purpose: "pallet"'`;
- обёртка с `id`, `enabled`, `chzProductGroupCodes`, `createdAt` → без предупреждений;
- неизвестные свойства на корне, в элементе и в `data: { literal, foo }` → по
  предупреждению с точечным путём, в `spec` результата их нет;
- синтаксическая ошибка → `LABEL_CODE_INVALID`; корень-массив и `spec: 42` →
  `LABEL_CODE_INVALID`; 256 КБ + 1 → `LABEL_CODE_TOO_LARGE`; 1001 элемент →
  `LABEL_CODE_LIMIT`;
- ошибки схемы: элемент без `fontSizePt` и дубль `id` в одном документе → `cause` с
  обоими путями;
- ZPL `^FB460,3,0,L,0` → `maxLines: 3`; `^FB460,1,0,L,0` и `^FB460` → ключа нет;
  `^FB460,99` → `16`; `generateZpl` элемента с `maxLines: 3` → `parseZplLabel` →
  `maxLines: 3`.

Админка (`apps/admin/test/labels-editor.test.tsx` — существующий, там же живут тесты
`download.ts`; `labels-import-analysis.test.ts` — новый):

- в селекте формата есть «JSON (Markiro)», при его выборе селект DPI исчезает,
  подпись textarea — «JSON шаблона»;
- «Проверить код» с валидным JSON → сводка с числом элементов и размером;
- невалидный JSON → список ошибок с путями, «Заменить этикетку» недоступна;
- предупреждения → кнопка заблокирована до чекбокса, после — доступна;
- «Заменить этикетку» → spec в редакторе, размер «другой» при нестандартном, имя
  подставлено из обёртки для нового шаблона и не подставлено для сохранённого;
- панель полей в режиме JSON копирует `product.printName` без скобок;
- «Скачать JSON» → blob `application/json`, содержимое `{ name, purpose, spec }` с
  отступами и кириллицей в UTF-8, имя файла `<name>.json`;
- круговой прогон: экспорт → `analyzeImport` в формате JSON → deep-equal spec.

`label-samples.test.ts` (30 образцов ZPL) не меняется и служит регрессией для `^FB`:
образцы однострочные, их spec не должен измениться.

## 5. Документация и границы модулей

- Печатные инструкции MKR-INS диалог импорта не описывают (проверено 2026-09-18);
  обновлять нечего. OpenAPI не меняется. `examples/labels/README.md` остаётся про ZPL.
- Границы:
  - `packages/domain/src/labels/json-import.ts` — разбор JSON; зависит от `model.ts`
    и helpers из `import.ts`;
  - `packages/domain/src/labels/model.ts` — строгий вариант схемы из тех же shape-ов;
  - `packages/domain/src/labels/zpl-import.ts` — второй параметр `^FB`;
  - `apps/admin/.../editor/import-analysis.ts` — «текст + формат → результат или
    ошибка», без DOM;
  - `apps/admin/.../editor/ImportFieldsPanel.tsx` — панель полей;
  - `apps/admin/.../editor/ImportCodeDialog.tsx` — оболочка;
  - `apps/admin/.../editor/download.ts` — `buildJsonBlob`;
  - `apps/admin/.../editor/index.tsx` — третья кнопка, подстановка имени;
  - `apps/admin/src/i18n/{ru,en}.json` — тексты.
- Порядок сборки: домен собирается до тестов админки
  (`pnpm --filter @markiro/domain build`).
