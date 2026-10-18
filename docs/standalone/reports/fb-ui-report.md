# fb-ui: селекты, выравнивание, отступы, вёрстка при 960–1920 px (офис «Маркиро Автоном»)

Ветка `claude/fb-ui` (worktree `/tmp/claude/wt/fb-ui`), на момент отчёта смержен с `claude/integration` дважды (последний раз со всем: people, codesearch, templates-section, hub, about, license, station). Не запушено.

## Что сказал владелец и первопричина

1. «Селекты стандартные, не наши кастомные; в селектах не хватает поиска».
   Первопричина: у **всех** 24+ `Select` офиса стоял флаг `native` (с коммита a00d132ff «страница Товары», чтобы тестам было проще писать `fireEvent.change` в `<select>`). Флаг заставляет `@markiro/ui` `Select` рисовать браузерный `<select>`. Токены и стили `@markiro/ui` подключены правильно (`import "@markiro/ui/styles.css"` в `main.tsx`), кастомный `Select` без `native` в браузере выглядит как надо (шеврон, панель, подсветка, фокус; см. `/tmp/claude/fb/ui-shots/wip/after-select-*.png`).
2. «Проверить выравнивания», 3. «Нет отступов вокруг таблиц».
3. Позже (владелец, ~1000 px): страница вылезает вправо, ячейки ломаются по буквам («розли/в»), длинное предупреждение статуса — высокая узкая коробка, у колонок нет разумной ширины. Требование: окно офиса минимум 960×600; все страницы проверить при 960×600, 1280×800, 1920×1080.

Первопричины вёрстки:

- `.office-shell__content` — `display: grid` с неявной колонкой `auto`: колонка росла до ширины самой широкой таблицы и выталкивала страницу вбок (горизонтальная прокрутка страницы). Теперь `grid-template-columns: minmax(0, 1fr)`: таблица прокручивается внутри своей карточки.
- `@markiro/ui` `Table` для колонок с `wrap` ставил `overflow-wrap: anywhere` — минимальная ширина колонки становилась в один символ, отсюда «по буквам». Теперь `break-word`.
- Предупреждение «Не откроется: …» было `StatusChip wrap` (рамка-плашка с длинным текстом).
- Класс `.shift-card` определён и в офисе (стек страницы), и на станции (карточка с `padding: 16px; gap: 8px`) — страницы «Поиск кодов» и карточка смены в офисе получали чужие padding и gap. Офисный стек переименован в `.office-stack`.

## Что сделано (по файлам)

### Селекты (п. 1)

- Снят `native` со всех `Select` в `src/office/**` (devices, products, shifts, templates, employees, operators). Новых нативных нет: `test/office-controls.test.ts` сканирует `src/office`, `src/wizard`, `src/app` на `<select>`, `<datalist>`, `list=`, сырые `<input>`/`<textarea>`/`<button>` и `<Select … native>`. Аудит: сырых элементов форм в этих каталогах нет вообще (только `Input`, `Textarea`, `Button`, `Checkbox`, `RadioGroup`, `DatePicker`, `Select`, `Combobox` из `@markiro/ui`).
- Поиск (`searchable`) включён во всех списках, которые берутся из данных: группы товаров и шаблоны в диалоге товара; линии (фильтр смен); товар, линия, контрагент, шаблоны короба/паллеты, лист А4 в диалоге смены; линия в диалоге устройства; шаблоны и листы в «Умолчаниях» (по организации, по строкам, диалог категории: категория и шаблон); оператор в диалоге сотрудника; сотрудник в диалоге оператора. Короткие фиксированные списки (состояние, статус, назначение, формат, dpi, размер) без поиска.
  `src/office/select-search.ts` (`searchableSelect(t)`) + ключи `office.common.selectSearch.*` в `ru.json`: подпись, плейсхолдер, «Ничего не найдено».
- Часовой пояс (профиль, мастер) уже был `Combobox` с поиском.
- `packages/ui` (общий с облачными приложениями, минимально): `Select` получил необязательный `searchEmptyLabel` (сообщение, когда фильтр ничего не нашёл) и сбрасывает текст фильтра при закрытии списка (раньше при повторном открытии висел старый фильтр). Тест в `packages/ui/test/components.test.tsx`; `pnpm --filter @markiro/ui test` 256/256, typecheck, lint, build.

### Выравнивание и отступы (п. 2, 3) — `src/app/shell.css`, общие стили, не точечные

- Карточка офиса: части (`.mk-card__body`) лежат сеткой с шагом `--sp-4`; пояснение, таблица, пейджер и подпись не слипаются. Браузерные отступы `<p>` в карточках убраны. `.office-note` — `--text-body` (было 16 px против 13 px подсказок).
- Панель фильтров (`FilterBar`): верхние края контролей на одной линии, подсказка под полем ничего не сдвигает; у каждого поля `min-width: 168px`; поле поиска растёт до 420 px; кнопка в ряду контролей — полной высоты (40 px) и на одной линии с полями (у «Смен» и «Поиска кодов» вместо compact-кнопки `resetLabel` теперь обычная `Button`). Подсказка поиска у «Товаров», «Шаблонов», «Сотрудников» стала плейсхолдером.
- Кнопки в строке таблицы начинаются там же, где заголовок «Действия» (раньше прижимались вправо при левом заголовке).
- Пять действий оператора (с новой «Сотрудник»): блок равных кнопок по ширине, которую даёт таблица (контейнерные запросы на области прокрутки таблицы): узко — один столбец, ≥1090 px — 2 столбца, ≥1220 — 3, ≥1410 — одной строкой. Поведение кнопок не менялось. При 1280×800 это один столбец (строка ~215 px), при 1500 — 2 столбца (135 px), при 1920 — одна строка (55 px). Больше нельзя без потери колонок: 8 колонок + кнопки не помещаются в 953 px.
- Мастер: кнопка удаления линии не уезжает вниз при ошибке под полем. Карточка сетевого подключения станции — шире (`.standalone-card--wide`, 800 px), ряд кнопок `.standalone-form__actions` не переносит подписи внутри кнопки и переносится целыми кнопками; 64 px высота сохранена (скриншоты `pairing-*`).
- Общий `PageHeader` и шапка офиса переносятся в узком окне; меню (`Sidebar`) закреплено и прокручивается само в низком окне (960×600: «Информация» достижима).

### Вёрстка 960–1920 (п. 3 после скриншота владельца)

- Страница не шире окна (см. выше); таблица прокручивается внутри карточки.
- `Table` (`@markiro/ui`): `overflow-wrap: break-word` вместо `anywhere`; новые необязательные поля колонки `minWidth` (нижняя граница ширины заголовка и ячеек) и `wrapTitle` (заголовок в две строки). Задан `minWidth` у переносимых колонок «Смен», «Товаров», «Шаблонов», «Листов А4», «Умолчаний», карточки смены, «Операторов»; «Табельный номер» переносится в две строки. Тесты в `packages/ui/test/components.test.tsx`.
- «Смены»: предупреждение «Не откроется: …» — предложение под чипом статуса (`.shift-cell__warn`, знак «!» + текст по словам), не плашка. Чип статуса на своей строке; ячейки с датой, номером, кодом остаются `nowrap`.
- `.shift-card` (офис) → `.office-stack`: «Поиск кодов» и карточка смены больше не получают padding станции.

### Новые страницы из integration (people, codesearch, templates-section, about)

Проверены при трёх размерах; «Сотрудники», «Поиск кодов», «Информация», вкладки «Шаблонов» (этикетки / листы А4 / по умолчанию), редактор шаблона, диалоги: страница не шире окна ни на одном.

## Тесты

- Новые: `test/support/select.ts` (помощники для кастомного Select: `chooseValue/chooseText/optionTexts/valueOf/shownIn/settleSelect`, также формы `…On(trigger)`); `test/office-controls.test.ts` (нет нативных контролов); `test/office-layout.test.ts` (правила `shell.css`: одна колонка `minmax(0,1fr)`, переносы шапок, меню, сетка карточки, панель фильтров, действия строк, предупреждение, `.office-stack`); в `product-dialog.test.tsx` — поиск в списках диалога товара (фильтр, «Ничего не найдено», сброс при повторном открытии); в `shifts-page.test.tsx` — предупреждение это предложение, а не чип; в `packages/ui` — Select (пусто/сброс фильтра), Table (`break-word`, `minWidth`, `wrapTitle`).
- Изменены существующие тесты: все, что работали с нативным `<select>` (`fireEvent.change` по лейблу, `querySelectorAll("option")`, `.value`, `.selectedOptions`) переписаны на помощники; затронуты products-page, product-dialog, devices-page, shifts-page, shift-dialog, shift-edit, template-defaults-page, template-editor, templates-page, template-logo, template-preview, template-code-downloads, import-code-dialog, employees-page, operator-employee-link. Утверждения не ослаблялись, но у кастомного Select изменилось следующее (решение продукта «кастомный селект»): (а) у фильтров вне `<form>` нет скрытого нативного `<select>`, поэтому значения опций в них не проверяются, выбор делается по тексту; (б) плейсхолдер без пустой опции — не пункт списка (в тестах убран из ожидаемых списков); (в) после выбора Radix возвращает фокус на триггер на следующем такте — в тестах, проверяющих фокус, добавлен `settleSelect()`; (г) подсказка под поиском «Товаров»/«Шаблонов»/«Сотрудников» теперь плейсхолдер — тест ищет `getByPlaceholderText`.

## Результаты проверок

- `@markiro/ui`: test 256/256, typecheck, lint, build — зелёно.
- `@markiro/standalone`: typecheck, eslint и prettier --check (изменённые файлы), `git diff --check` — чисто.
- Vitest `@markiro/standalone` на финальном дереве: ВСЕ офисные и связанные файлы зелёные — шарды 1–3 из 6 (1035+1157+879), отдельно файлы шарда 4 (template-defaults-page 58/58, templates-section, sscc, users, template-logo/preview/thumbs, templates-page, wizard, shift-totals, shifts-refetch, station-first-run, template-code-downloads — 189 тестов в одном прогоне), и 25 файлов шарда 5 (network-pairing, app, office, org, lines, counterparties, backups, form-dialog, code-search, about, pallet-sheets, operators, operator-badges, devices, cloud-import, export-dialog, print-form-dialog, host-status-line, office-controls, office-layout, shift-card, shift-delete-close, shift-totals, shifts-refetch) — 712/712. Template-editor 97/97 (два теста «marks «Шаблоны» in the menu…» и «reads the products again after a delete» падали по таймауту при нагрузке машины load average 50–70 от соседних агентов; по одному и в спокойный момент проходят).
- НЕ ПРОГНАНЫ на финальном дереве целиком (из-за нагрузки машины полный прогон не укладывался в часы): `floor-*`, `warehouse-*`, протокол/синк/хост-тесты шардов 5–6. Я их кодом не трогал (менялись только `src/office/**`, `src/app/shell.css`, `src/app/NetworkPairing.tsx`, `@markiro/ui`); до слияния с последним integration эти файлы проходили в первом полном прогоне. Прогнать на CI.
- Vitest не видит CSS (jsdom не считает вёрстку): визуальные результаты проверены в браузере, см. скриншоты; тесты держат правила `shell.css` и структуру, но не результат вёрстки.

## Скриншоты

Стенд: `apps/standalone/harness/` (НЕ в git, untracked в worktree: `index.html`, `main.tsx`, `fake-api.ts` — офис с мок-хостом; `?view=wizard|login|pairing`, `?theme=light`, `?empty=1`), dev-сервер `http://127.0.0.1:5381/harness/index.html` (после правок) и `:5391` (чистый `claude/integration`, до правок). Остановить: `pkill -f "vite --port 5381"` и `5391`.

- До: `/tmp/claude/fb/ui-shots/before/<страница>-<960|1280|1920>.png`
- После: `/tmp/claude/fb/ui-shots/after/<страница>-<960|1280|1920>.png`
- Страницы: overview, org, sscc, counterparties, lines, shifts, employees, operators, devices, codes, products, templates, templates-sheets, templates-defaults, template-editor, users, backups, import, about; диалоги dlg-shift-new, dlg-product-new, dlg-operator-new, dlg-counterparty-new, dlg-device-connect; экраны wizard, login, pairing.
- Промежуточные: `/tmp/claude/fb/ui-shots/wip/` (открытые селекты, мастер, пары до/после, операторы по ширинам 1280/1500/1920).
- Замер горизонтального переполнения СТРАНИЦЫ до правок (960): sscc +102, counterparties +269, shifts +376, employees +59, operators +344, devices +300, products +115, templates +367, users +65; (1280): shifts +56, operators +24, templates +47. После: 0 на всех страницах и размерах; таблицы прокручиваются внутри карточки (960: sscc 127, counterparties 293, shifts 880, employees 83, operators 372, devices 313, products 259, templates 482, users 78; 1280: shifts 560, operators 52, templates 162).

## Правки в чужих файлах (для слияния)

- fb-templates: `TemplatesPage.tsx` (удалён `native`, подсказка поиска → плейсхолдер, `minWidth` у колонок), `TemplateEditor.tsx`, `LabelSizeDialog.tsx`, `ImportCodeDialog.tsx` (только удалён `native`), `CategoryDefaultDialog.tsx`, `TemplateDefaultsPage.tsx` (`native` → `searchableSelect`, `minWidth`), `PalletSheetsPage.tsx` (`minWidth`); тесты template-* / templates-page / import-code-dialog / template-code-downloads (миграция на помощники).
- fb-mode / смены: `ShiftsPage.tsx` (удалён `native`, поиск в фильтре линий, кнопка сброса, предупреждение — предложение, `minWidth`), `ShiftDialog.tsx` (`searchableSelect`), `ShiftCardPage.tsx` (`.office-stack`, `minWidth`), тесты shifts-page / shift-dialog / shift-edit.
- fb-codesearch: `CodeSearchPage.tsx` (кнопка сброса вместо `resetLabel`, `.office-stack`), `CodeCard.tsx` (`.office-stack`).
- fb-people: `EmployeesPage.tsx`, `EmployeeOperatorDialog.tsx`, `OperatorEmployeeDialog.tsx` (`native` → поиск; плейсхолдер), `OperatorsPage.tsx` (`office-row-actions--many`, `wrapTitle`, `minWidth`), тесты employees-page / operator-employee-link.
- fb-station: `NetworkPairing.tsx` (широкая карточка).
- `src/app/shell.css` — общий для всех; в конфликте оставляйте все записи.
- Конфликты при слияниях с integration: `ProductDialog.tsx`, `CategoryDefaultDialog.tsx`, `TemplateDefaultsPage.tsx` — разрешены по integration + повторное снятие `native`.

## Не проверено / ограничения

- Всё посмотрено в Chromium (Playwright) на мок-хосте; WebView2 на Windows, реальный хост, печать, тёмная/светлая тема на всех страницах (светлая смотрелась выборочно, не по всем) — не проверялись.
- Контейнерные запросы (`@container`) требуют Chromium ≥105: в WebView2 есть; в старых оболочках правила не сработают и останется один столбец (безопасный вариант).
- Диалог «Подключить устройство» при скриншотах не открылся (скриншот — страница с диалогом не найден `[role=dialog]`); коды/ drawer карточки кода при 3 размерах не снимались (нет данных поиска в моке).
- Таблицы «Смен» и «Операторов» при 960–1280 прокручиваются по горизонтали внутри карточки: это принятое поведение; строки операторов при 1280 высокие (один столбец из пяти кнопок). Радикальное решение (меню действий «⋯» или убрать колонку) — вопрос владельцу.
- Лёгкое меню действий («⋯» с пунктами) не делалось: нет компонента в `@markiro/ui`, нужно ~15 переписанных тестов оператора/устройств.

## Вопросы владельцу

1. Строки таблицы «Операторы» при 1280 высотой ~215 px (пять кнопок столбцом). Оставить так, добавить меню «⋯» (нужен новый компонент `@markiro/ui`) или убрать/объединить колонку «Должность» с «Имя»?
2. «Смены»: колонка действий при 960–1280 за правым краем (нужна прокрутка). Закрепить колонку действий справа (перекроет часть данных при прокрутке) или оставить?

## Дополнение: решения владельца по двум открытым вопросам (коммит d34501895)

Ветка смержена с claude/integration (1546589f3 и позже) перед правками.

1. **Строки с более чем двумя действиями: одна кнопка + меню «⋯».**
   - Новый компонент `RowActionMenu` в `@markiro/ui` (popover на Radix, как `Combobox`): кнопка «⋯» (`aria-label` «Действия: <запись>», `aria-haspopup="menu"`), список `role="menu"` из `role="menuitem"`. Клавиатура: Enter/Пробел открывает, стрелки/Home/End двигают, Enter выбирает и закрывает (фокус уходит в открытый диалог), Escape закрывает и возвращает фокус на «⋯». Пункты сохраняют прежние доступные имена («Сменить PIN оператора «Иван»»), деструктивный отделён разделителем и цветом ошибки (`data-destructive`).
   - Применено (аудит всех таблиц; в остальных не больше двух кнопок, их не трогал): «Операторы» (основное «Изменить»; в меню PIN, бейджи, сотрудник, выключить/включить; «Выключить» деструктивное); «Смены» активной (основное «Итоги»; в меню план, выгрузка, закрыть — «Закрыть» деструктивное; у плановых «Изменить/Удалить» и закрытых «Итоги/Выгрузка» по две кнопки, без меню); «Шаблоны» (основное «Изменить»/«Копировать»; в меню «Категории», «Включить/Выключить»); «Листы А4» (основное «Просмотр»; в меню скачать JSON, включить/выключить, переименовать, удалить; удаление деструктивное; без прав редактирования — «Просмотр» и «Скачать JSON»). «Сотрудники», «Пользователи», «Линии», «Устройства» — две кнопки, меню не нужно.
   - Строка снова в одну линию: высота «Операторов» 55 px (было 215 при 1280); удалены контейнерные правила `office-row-actions--many`. `.mk-row-actions` в таблице не переносится (`flex-wrap: nowrap`).
2. **Колонка действий больше не за краем карточки.** `Table` получил `stickyEnd` у колонки (заголовок и ячейки `position: sticky; right: 0`, фон, левая линия); задан у всех колонок «Действия» офиса. Замер при 960×600, 1280×800, 1920×1080 по всем страницам (+ вкладки «Листы А4», «По умолчанию»): страница не шире окна, правый край заголовка «Действия» совпадает с правым краем области прокрутки таблицы (смещение 0) везде. Остальные колонки при нехватке места прокручиваются под закреплённой.

Тесты: `packages/ui` 259/259 (RowActionMenu: открытие, имена, разделитель, клавиатура, фокус; Table.stickyEnd); `test/support/row-menu.ts` (`pressRowAction`, `findRowAction`, `hasRowAction` — работают и с кнопкой в строке, и с пунктом меню); переписаны на помощники operators-page, operator-badges, operator-employee-link, pallet-sheets-page, templates-page, shift-delete-close, shift-edit, export-dialog; новые проверки: строка оператора = «Изменить» + меню, порядок пунктов, деструктивность, `sticky`-колонка (operators-page), строка шаблона и активной смены (templates-page, shift-edit). Утверждения о поведении сохранены (те же действия, те же обработчики); изменены только места, где проверялось «кнопка в строке» → «пункт меню строки». Прогнано зелёным: operators-page, operator-badges, operator-employee-link, pallet-sheets-page (30+), templates-page/-section, office, users, devices, employees, lines, products, office-layout (187/187), shifts-page, shift-totals, shifts-refetch, shift-delete-close, export-dialog (127/127); shift-edit и shift-card — в прогоне на момент отчёта один тест (исправлен и проходит отдельно), остальные 75 зелёные.

Скриншоты: `/tmp/claude/fb/ui-shots/after/<страница>-<960|1280|1920>.png` обновлены для всех страниц; новые `operators-menu-960.png`, `shifts-sticky-960.png`. Dev-серверы на 5381 и 5391 остановлены; `apps/standalone/harness/` остался untracked в worktree.
