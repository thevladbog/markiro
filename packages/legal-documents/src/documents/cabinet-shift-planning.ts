import type { LegalDocumentSource } from "../types.js";

export const CABINET_SHIFT_PLANNING_CONTENT = {
  ru: {
    locale: "ru",
    title: "Офис: линии, станции и планирование смены",
    summary:
      "Инструкция администратора и технолога Маркиро Автоном: линии цеха и число устройств в смене, станции на линии, требования к товару, планирование смены в режимах «Агрегация» и «Проверка», паллеты, печать дубликата, изменение и удаление смены.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает подготовку выпуска в офисе Маркиро Автоном: как завести линии, закрепить за ними станции и запланировать смену. Офис открывается в приложении Маркиро на ПК-хосте или на компьютере, подключённом к хосту как офис. Открывает смену оператор на станции — это описано в инструкции MKR-INS-01; там же — как оператор создаёт смену прямо на станции. Ход смены, её закрытие и выгрузки — в MKR-INS-09, карточка товара — в MKR-INS-10.",
          },
          {
            kind: "paragraph",
            text: "Смена проходит три состояния: «Запланирована» — задание готово, выпуск не начат; «Активна» — смену открыли на станции и идёт выпуск; «Закрыта» — выпуск окончен. Почти всё, что описано ниже, делается в первом состоянии: у активной смены в офисе меняется только план.",
          },
          {
            kind: "paragraph",
            text: "Планировать, менять и удалять смены могут обе роли офиса — администратор и технолог. Линии меняет только администратор, технолог видит их список. Раздел «Устройства» есть только у администратора.",
          },
          {
            kind: "ordered-list",
            items: [
              "Проверьте линии и задайте, сколько устройств может работать в смене одной линии.",
              "Закрепите станции за линиями.",
              "Убедитесь, что товар активен.",
              "Запланируйте смену: товар, режим, даты, план, линия и — для агрегации — шаблон, вместимость короба и паллеты.",
              "Передайте линию оператору: смену он откроет на станции сам.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационной площадке. Названия, номера и количества у вас будут другими.",
          },
        ],
      },
      {
        id: "line",
        heading: "2. Линии",
        blocks: [
          {
            kind: "paragraph",
            text: "Раздел «Линии» офис описывает так: «Линии цеха: к ним привязаны станции и смены.» Первые линии задают ещё в мастере первого запуска хоста, остальные добавляют здесь.",
          },
          {
            kind: "step",
            title: "Проверьте список линий",
            text: "В таблице три колонки: «Название», «Макс. станций» и «Состояние» — «Действует» или «В архиве». Карандаш в строке открывает линию для изменения, меню «…» — дополнительные действия.",
            image: { id: "lines-list", caption: "Раздел «Линии»" },
          },
          {
            kind: "step",
            title: "Добавьте линию",
            text: "Нажмите «Добавить линию». В окне «Новая линия» одно поле — «Название линии»; называйте линию так, как её зовут в цехе, чтобы оператор узнал её на станции. Нажмите «Добавить». Две действующие линии с одним названием быть не могут: офис ответит «Активная линия с таким названием уже есть».",
            image: { id: "line-form", caption: "Окно «Новая линия»" },
            expected: "Линия появилась в списке со состоянием «Действует».",
          },
          {
            kind: "step",
            title: "Задайте, сколько устройств работает в смене",
            text: "Карандаш в строке линии открывает окно с полями «Название линии» и «Максимум станций в смене». Подсказка поля: «От 1 до 16: станции и ТСД считаются вместе. Каждое устройство закрывает свою часть смены.» Новая линия получает 1. Пока в смене линии работают устройства, меньше их числа поставить нельзя — офис пишет, сколько устройств сейчас в смене.",
            image: { id: "line-edit", caption: "Линия: название и максимум станций в смене" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Удалить линию нельзя — её убирают в архив: меню «…» → «В архив». Офис предупреждает: «Линию «…» больше нельзя будет выбрать на станции. Станции, которые уже работают на ней, останутся на этой линии, пока их не переведут в разделе «Устройства».» Архивную линию возвращают кнопкой «Вернуть».",
          },
          {
            kind: "paragraph",
            text: "Число линий может ограничивать лицензия площадки. Если предел достигнут, хост откажет: «Достигнут предел лицензии: …» — уберите ненужную линию в архив или расширьте лицензию.",
          },
        ],
      },
      {
        id: "stations",
        heading: "3. Станции на линии",
        blocks: [
          {
            kind: "paragraph",
            text: "Станция показывает оператору смены своей линии, поэтому каждая станция должна быть закреплена за линией. Станции, ТСД и офисные компьютеры подключаются к хосту в разделе «Устройства» кнопкой «Подключить устройство» по одноразовому коду; подключение описано в инструкции MKR-INS-04.",
          },
          {
            kind: "step",
            title: "Найдите станцию",
            text: "Откройте «Устройства». В таблице: «Имя», «Вид» («Станция», «Офис» или «ТСД»), «Линия» — с пометкой «В смене …», если на устройстве идёт смена, — «Версия», «Подключено», «Связь» («на связи», «давно не было» или «нет связи» и время, когда хост слышал устройство в последний раз) и «Доступ» («Действует» или «Отозвано»). Сам ПК-хост тоже есть в списке — как «Рабочее место хоста» с пометкой «Этот ПК».",
            image: { id: "device-list", caption: "Раздел «Устройства»" },
            expected: "Нужная станция в списке, её доступ — «Действует».",
          },
          {
            kind: "step",
            title: "Назначьте станции линию",
            text: "Нажмите карандаш в строке станции. В окне «Устройство «…»» два поля: «Имя» и «Линия». Подсказка поля «Линия»: «Станция перейдёт на линию, как только получит изменение от хоста. Без линии она попросит выбрать линию.» Выберите линию и нажмите «Сохранить».",
            image: { id: "device-line", caption: "Окно устройства: имя и линия" },
            expected: "В колонке «Линия» стоит выбранная линия.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если на станции идёт смена, офис предупредит об этом в том же окне: после перевода станция доделает начатую работу, выведет оператора и покажет смены новой линии, а смена останется открытой — закрыть её можно на странице «Смены». Переводите станцию между сменами.",
          },
          {
            kind: "paragraph",
            text: "Станция без линии сама попросит её выбрать: на экране «Выбор линии» — «Выберите линию, на которой работает эта станция.» Архивную линию выбрать нельзя.",
          },
        ],
      },
      {
        id: "catalog",
        heading: "4. Что нужно от товара",
        blocks: [
          {
            kind: "paragraph",
            text: "Смену планируют на товар из раздела «Товары». В списке «Товар» формы смены есть только товары в состоянии «Активен»; черновиков и товаров в архиве в нём нет. Товар остаётся черновиком, пока не указаны товарная группа, вместимость короба и число коробов на паллете, — как довести карточку, описано в MKR-INS-10.",
          },
          {
            kind: "paragraph",
            text: "Карточка товара экономит ввод: при выборе товара в форму смены подставляются вместимость короба, число коробов на паллете, шаблоны этикеток и контрагент по умолчанию. Подставленные значения можно изменить — в смене сохраняется то, что стоит в форме.",
          },
        ],
      },
      {
        id: "plan",
        heading: "5. Планирование смены",
        blocks: [
          {
            kind: "step",
            title: "Откройте раздел «Смены»",
            text: "Вкладка «Местные смены» показывает смены этого хоста; «Облачная история» — смены, перенесённые из облачного Маркиро. Отбор: «Поиск по номеру и товару», «Статус», «Линия», периоды «Дата производства» и «Дата смены». Без периода офис показывает запланированные и активные смены и закрытые за последний 31 день. В строке: номер, товар и название для печати, линия, даты, статус и режим, выпуск и план. Глаз открывает запланированную смену, меню «…» — действия над ней.",
            image: { id: "shifts-list", caption: "Раздел «Смены»" },
          },
          {
            kind: "step",
            title: "Откройте форму смены",
            text: "Нажмите «Запланировать смену» — справа откроется панель «Новая смена». Выберите товар: в списке видны название для печати и GTIN.",
            image: { id: "shift-filled", caption: "Новая смена: товар, режим, даты, план и линия" },
          },
          {
            kind: "unordered-list",
            items: [
              "«Режим работы» — «Проверка» или «Агрегация». Новая форма открывается в режиме «Агрегация».",
              "«Дата производства» и «Дата смены» — обе по умолчанию сегодняшние.",
              "«План, шт» — необязательно: целое число от 1 до 10 000 000. Пустое поле — смена без плана.",
              "«Линия» — обязательна: без неё офис ответит «Выберите линию».",
              "«Контрагент» — необязательно: его название будет на этикетке короба.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "Две даты не дублируют друг друга. «Дата смены» — «Рабочий день, в который идёт смена. Номер смены считается по дате производства.» «Дата производства» печатается на этикетках и попадает в выгрузки. Если ночная смена выпускает продукцию следующего дня, укажите обе даты.",
          },
        ],
      },
      {
        id: "aggregation",
        heading: "6. Агрегация и паллеты",
        blocks: [
          {
            kind: "paragraph",
            text: "В режиме «Агрегация» станция укладывает коды в короба и печатает этикетки коробов. «Шаблон этикетки короба» обязателен — без него офис ответит «Выберите шаблон этикетки короба»; шаблон подставляется из товара или из шаблонов по умолчанию. «Вместимость короба, шт» — «Берётся из товара; можно изменить», от 1 до 100 000.",
          },
          {
            kind: "step",
            title: "Включите паллеты, если короба собирают на паллеты",
            text: "Отметка «С паллетами»: «Станция собирает короба на паллету и закрывает её по вместимости». С ней появляются поля «Коробов на паллете» (из товара, от 1 до 10 000; считаются короба, а не штуки), «Шаблон этикетки паллеты» (обязателен) и «Лист А4» — лист печатается вместо термоэтикетки паллеты на станции с принтером А4. Если у товара не задано число коробов на паллете, отметка недоступна: «У товара не задана вместимость паллеты: смена без паллет».",
            image: { id: "shift-pallets", caption: "Агрегация с паллетами" },
            expected: "Поля паллет заполнены.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Паллеты — возможность лицензии площадки. Если её нет, хост не сохранит смену с паллетами: «Эта возможность не входит в лицензию площадки: паллеты. Запланируйте смену без паллет или расширьте лицензию.»",
          },
          {
            kind: "step",
            title: "Сохраните смену",
            text: "Нажмите «Запланировать». Офис сообщит «Смена … запланирована.», и смена появится в списке со статусом «Запланирована». Пока форма не сохранена, внизу панели стоит «Есть несохранённые изменения».",
            expected: "В списке появилась строка со статусом «Запланирована».",
          },
        ],
      },
      {
        id: "duplicate",
        heading: "7. Проверка и печать дубликата",
        blocks: [
          {
            kind: "paragraph",
            text: "В режиме «Проверка» станция проверяет коды без укладки в короба. Вместимости и паллет в форме нет, а у поля «Шаблон этикетки короба» подсказка: «В режиме проверки этикетки коробов не печатаются».",
          },
          {
            kind: "step",
            title: "Включите печать дубликата",
            text: "Если код на самой продукции не читается дальше по цепочке — например, он закрыт упаковкой, — отметьте «Печатать дубликат Data Matrix». Появится раздел «Печать дубликата»: выберите «Шаблон этикетки продукции» (в списке видны размеры) и решите, нужна ли «Обязательная проверка этикетки»: «Оператор должен отсканировать новую этикетку перед следующей единицей.» Без отметки «После отправки на принтер можно сканировать следующую единицу».",
            image: { id: "shift-duplicate-print", caption: "Проверка с печатью дубликата" },
            expected: "Шаблон выбран, режим проверки этикетки задан.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Дубликат не меняет учёт: «На внешнюю упаковку переносится полный код с продукции. Количество продукции не меняется.» Если подходящего шаблона нет, офис скажет об этом — добавьте или включите шаблон в разделе «Шаблоны».",
          },
        ],
      },
      {
        id: "after",
        heading: "8. Изменение и удаление",
        blocks: [
          {
            kind: "step",
            title: "Откройте запланированную смену",
            text: "Нажмите глаз в строке смены. Панель «Смена …» показывает статус, дату смены и поля задания; сверху — «Изменить» и «Бланк смены». «Бланк смены» печатает задание для линии; если у товара есть фото, оно печатается на бланке.",
            image: { id: "shift-planned", caption: "Карточка запланированной смены" },
          },
          {
            kind: "step",
            title: "Измените запланированную смену",
            text: "«Изменить» превращает карточку в форму. Товар не меняется — офис пишет «Товар: … Товар смены не меняется.» Режим, даты, план, линию, контрагента, шаблоны и паллеты менять можно. Нажмите «Сохранить».",
            image: { id: "shift-planned-edit", caption: "Изменение запланированной смены" },
            expected: "Офис сообщил «Изменения сохранены.»",
          },
          {
            kind: "step",
            title: "У активной смены меняется только план",
            text: "Меню «…» в строке активной смены → «Изменить план». Окно «План смены …» объясняет: «Смена уже идёт на станции: у неё меняется только план. На этикетку план не попадает.» Пустое поле — «без плана».",
            image: { id: "shift-active-plan", caption: "План активной смены" },
          },
          {
            kind: "step",
            title: "Удаляйте смену только до открытия",
            text: "Меню «…» в строке запланированной смены → «Удалить». Офис спросит «Удалить смену …?» и предупредит: смена «будет удалена без возможности восстановления. Её номер больше не выдаётся.» У активной и закрытой смены этого действия нет.",
            image: { id: "shift-delete", caption: "Подтверждение удаления смены" },
          },
          {
            kind: "paragraph",
            text: "У запланированной смены в списке может появиться пометка «Не откроется: …» — например, «Не откроется: товар — черновик» или «Не откроется: шаблон выключен или не подходит товару». Станция такую смену не откроет: исправьте товар или выберите другой шаблон.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Офис и станции работают одновременно. Если смену открыли на станции, пока форма была открыта, офис не сохранит изменения: «Смену уже открыли на станции: теперь у неё можно изменить только план. Список смен обновлён.»",
          },
        ],
      },
      {
        id: "faq",
        heading: "9. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Товара нет в списке",
                detail:
                  "В список попадают только активные товары. Черновик доведите до состояния «Активен», товар из архива верните (MKR-INS-10).",
              },
              {
                term: "Не вижу вместимости и паллет",
                detail:
                  "Они есть только в режиме «Агрегация». Поля паллет появляются после отметки «С паллетами».",
              },
              {
                term: "Отметка «С паллетами» недоступна",
                detail:
                  "У товара не задано число коробов на паллете. Укажите его в карточке товара и откройте форму заново.",
              },
              {
                term: "Станция не видит смену",
                detail:
                  "Проверьте линию смены и линию станции в разделе «Устройства», а также статус: станция открывает запланированные и активные смены своей линии.",
              },
              {
                term: "Линия не удаляется",
                detail:
                  "Линии не удаляются, а уходят в архив: меню «…» → «В архив». Станции, уже работающие на линии, переведите в разделе «Устройства».",
              },
              {
                term: "Раздел «Устройства» не виден",
                detail:
                  "Он есть только у администратора офиса. Технолог видит смены, линии и товары.",
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
  en: {
    locale: "en",
    title: "Office: lines, stations and shift planning",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Guide for Markiro Autonom office administrators and technologists: shop-floor lines and the number of devices in a shift, stations on a line, product requirements, planning a shift in the Aggregation and Validation modes, pallets, duplicate printing, changing and deleting a shift.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers preparing production in the Markiro Autonom office: creating lines, assigning stations to them and planning a shift. The office opens in the Markiro application on the host PC or on a computer paired with the host as an office. The operator opens the shift at the station — see instruction MKR-INS-01, which also shows how an operator creates a shift right at the station. Running a shift, closing it and the exports are covered by MKR-INS-09, the product card by MKR-INS-10.",
          },
          {
            kind: "paragraph",
            text: "The application interface is in Russian only, so the screenshots show the Russian screens. Interface labels are quoted in Russian, followed by an English gloss in parentheses.",
          },
          {
            kind: "paragraph",
            text: "A shift goes through three states: «Запланирована» (Planned) — the job is ready and production has not started; «Активна» (Active) — the shift was opened at a station and production is running; «Закрыта» (Closed) — production is over. Almost everything below is done in the first state: for an active shift the office changes only the plan.",
          },
          {
            kind: "paragraph",
            text: "Both office roles — administrator and technologist — can plan, change and delete shifts. Only the administrator changes lines; the technologist sees their list. The «Устройства» (Devices) section is available to the administrator only.",
          },
          {
            kind: "ordered-list",
            items: [
              "Check the lines and set how many devices may work in one line's shift.",
              "Assign stations to lines.",
              "Make sure the product is active.",
              "Plan the shift: product, mode, dates, plan, line and — for aggregation — template, box capacity and pallets.",
              "Hand the line over to the operator, who opens the shift at the station.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots were taken on a demonstration site. Your names, numbers and quantities will differ.",
          },
        ],
      },
      {
        id: "line",
        heading: "2. Lines",
        blocks: [
          {
            kind: "paragraph",
            text: "The office describes the «Линии» (Lines) section as «Линии цеха: к ним привязаны станции и смены.» (Shop-floor lines: stations and shifts are bound to them.) The first lines are set in the host's first-start wizard; further ones are added here.",
          },
          {
            kind: "step",
            title: "Check the list of lines",
            text: "The table has three columns: «Название» (Name), «Макс. станций» (Max stations) and «Состояние» (State) — «Действует» (Active) or «В архиве» (Archived). The pencil in a row opens the line for editing; the «…» menu holds further actions.",
            image: { id: "lines-list", caption: "The «Линии» (Lines) section" },
          },
          {
            kind: "step",
            title: "Add a line",
            text: "Click «Добавить линию» (Add line). The «Новая линия» (New line) window has one field, «Название линии» (Line name); name the line the way the shop floor calls it so the operator recognises it at the station. Click «Добавить» (Add). Two active lines cannot share a name: the office answers «Активная линия с таким названием уже есть» (An active line with this name already exists).",
            image: { id: "line-form", caption: "The «Новая линия» (New line) window" },
            expected: "The line is in the list with the state «Действует» (Active).",
          },
          {
            kind: "step",
            title: "Set how many devices work in a shift",
            text: "The pencil in a line's row opens a window with «Название линии» (Line name) and «Максимум станций в смене» (Maximum stations in a shift). The field's hint reads: «От 1 до 16: станции и ТСД считаются вместе. Каждое устройство закрывает свою часть смены.» (1 to 16: stations and handhelds are counted together. Each device closes its own part of the shift.) A new line gets 1. While devices are working in the line's shift, the value cannot go below their number — the office says how many devices are in the shift now.",
            image: {
              id: "line-edit",
              caption: "A line: its name and the maximum stations in a shift",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "A line cannot be deleted — it is archived instead: «…» menu → «В архив» (Archive). The office warns that the line can no longer be chosen at a station, and that stations already working on it stay on it until they are moved in the «Устройства» (Devices) section. An archived line is brought back with «Вернуть» (Restore).",
          },
          {
            kind: "paragraph",
            text: "The site license may limit the number of lines. When the limit is reached the host refuses with «Достигнут предел лицензии: …» (License limit reached: …) — archive an unused line or extend the license.",
          },
        ],
      },
      {
        id: "stations",
        heading: "3. Stations on a line",
        blocks: [
          {
            kind: "paragraph",
            text: "A station shows the operator the shifts of its own line, so every station must be assigned to a line. Stations, handhelds and office computers are paired with the host in the «Устройства» (Devices) section with «Подключить устройство» (Pair a device) and a one-time code; pairing is described in instruction MKR-INS-04.",
          },
          {
            kind: "step",
            title: "Find the station",
            text: "Open «Устройства» (Devices). The table shows «Имя» (Name), «Вид» (Kind: «Станция» station, «Офис» office or «ТСД» handheld), «Линия» (Line) — marked «В смене …» (In shift …) when a shift is running on the device — «Версия» (Version), «Подключено» (Paired), «Связь» (Link: «на связи» online, «давно не было» not heard for a while or «нет связи» offline, with the time the host last heard the device) and «Доступ» (Access: «Действует» active or «Отозвано» revoked). The host PC itself is listed too, as «Рабочее место хоста» (Host workstation) marked «Этот ПК» (This PC).",
            image: { id: "device-list", caption: "The «Устройства» (Devices) section" },
            expected: "The station is in the list and its access is «Действует» (Active).",
          },
          {
            kind: "step",
            title: "Assign a line to the station",
            text: "Click the pencil in the station's row. The «Устройство «…»» (Device «…») window has two fields: «Имя» (Name) and «Линия» (Line). The line field's hint reads: «Станция перейдёт на линию, как только получит изменение от хоста. Без линии она попросит выбрать линию.» (The station moves to the line as soon as it receives the change from the host. Without a line it asks for one.) Choose the line and click «Сохранить» (Save).",
            image: { id: "device-line", caption: "Device window: name and line" },
            expected: "The «Линия» (Line) column shows the chosen line.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If a shift is running on the station, the office warns about it in the same window: after the move the station finishes the work in hand, signs the operator out and shows the new line's shifts, while the shift stays open — it can be closed on the «Смены» (Shifts) page. Move a station between shifts.",
          },
          {
            kind: "paragraph",
            text: "A station without a line asks for one itself: the «Выбор линии» (Choose a line) screen reads «Выберите линию, на которой работает эта станция.» (Choose the line this station works on.) An archived line cannot be chosen.",
          },
        ],
      },
      {
        id: "catalog",
        heading: "4. What the product needs",
        blocks: [
          {
            kind: "paragraph",
            text: "A shift is planned for a product from the «Товары» (Products) section. The shift form's «Товар» (Product) list contains only products in the «Активен» (Active) state; drafts and archived products are not in it. A product stays a draft until its product group, box capacity and boxes per pallet are set — completing the card is described in MKR-INS-10.",
          },
          {
            kind: "paragraph",
            text: "The product card saves typing: choosing a product fills the shift form with its box capacity, boxes per pallet, label templates and default counterparty. The filled values can be changed — the shift keeps what the form holds.",
          },
        ],
      },
      {
        id: "plan",
        heading: "5. Planning a shift",
        blocks: [
          {
            kind: "step",
            title: "Open the «Смены» (Shifts) section",
            text: "The «Местные смены» (Local shifts) tab shows this host's shifts; «Облачная история» (Cloud history) shows shifts carried over from cloud Markiro. Filters: «Поиск по номеру и товару» (Search by number and product), «Статус» (Status), «Линия» (Line), and the «Дата производства» (Production date) and «Дата смены» (Shift date) periods. Without a period the office shows planned and active shifts plus those closed in the last 31 days. A row shows the number, product and print name, line, dates, status and mode, output and plan. The eye opens a planned shift; the «…» menu holds the actions on it.",
            image: { id: "shifts-list", caption: "The «Смены» (Shifts) section" },
          },
          {
            kind: "step",
            title: "Open the shift form",
            text: "Click «Запланировать смену» (Plan a shift) — the «Новая смена» (New shift) panel opens on the right. Choose the product: the list shows the print name and the GTIN.",
            image: {
              id: "shift-filled",
              caption: "New shift: product, mode, dates, plan and line",
            },
          },
          {
            kind: "unordered-list",
            items: [
              "«Режим работы» (Mode) — «Проверка» (Validation) or «Агрегация» (Aggregation). A new form opens in Aggregation.",
              "«Дата производства» (Production date) and «Дата смены» (Shift date) — both default to today.",
              "«План, шт» (Plan, pcs) — optional: a whole number from 1 to 10,000,000. An empty field means a shift without a plan.",
              "«Линия» (Line) — required: without it the office answers «Выберите линию» (Choose a line).",
              "«Контрагент» (Counterparty) — optional: its name is printed on the box label.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "The two dates do not duplicate each other. The shift date is the working day of the shift, and the shift number is derived from the production date. The production date is printed on labels and goes into the exports. If a night shift produces the next day's goods, set both dates.",
          },
        ],
      },
      {
        id: "aggregation",
        heading: "6. Aggregation and pallets",
        blocks: [
          {
            kind: "paragraph",
            text: "In the Aggregation mode the station packs codes into boxes and prints box labels. «Шаблон этикетки короба» (Box label template) is required — without it the office answers «Выберите шаблон этикетки короба» (Choose a box label template); the template is filled from the product or from the default templates. «Вместимость короба, шт» (Box capacity, pcs) is taken from the product and can be changed, from 1 to 100,000.",
          },
          {
            kind: "step",
            title: "Turn pallets on if boxes are stacked on pallets",
            text: "The «С паллетами» (With pallets) checkbox means the station stacks boxes on a pallet and closes it when it is full. It brings the fields «Коробов на паллете» (Boxes per pallet; from the product, 1 to 10,000; boxes, not units), «Шаблон этикетки паллеты» (Pallet label template; required) and «Лист А4» (A4 sheet) — the sheet is printed instead of the pallet's thermal label at a station with an A4 printer. If the product has no boxes-per-pallet value, the checkbox is unavailable: «У товара не задана вместимость паллеты: смена без паллет» (The product has no pallet capacity: a shift without pallets).",
            image: { id: "shift-pallets", caption: "Aggregation with pallets" },
            expected: "The pallet fields are filled.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Pallets are a feature of the site license. Without it the host does not save a shift with pallets and answers that pallets are not included in the site license: plan the shift without pallets or extend the license.",
          },
          {
            kind: "step",
            title: "Save the shift",
            text: "Click «Запланировать» (Plan). The office reports «Смена … запланирована.» (Shift … planned.), and the shift appears in the list with the status «Запланирована» (Planned). Until the form is saved, the panel's footer shows «Есть несохранённые изменения» (There are unsaved changes).",
            expected: "A row with the status «Запланирована» (Planned) is in the list.",
          },
        ],
      },
      {
        id: "duplicate",
        heading: "7. Validation and duplicate printing",
        blocks: [
          {
            kind: "paragraph",
            text: "In the Validation mode the station checks codes without packing them into boxes. The form has no capacity or pallets, and the «Шаблон этикетки короба» (Box label template) field reads «В режиме проверки этикетки коробов не печатаются» (Box labels are not printed in the validation mode).",
          },
          {
            kind: "step",
            title: "Turn duplicate printing on",
            text: "If the code on the product cannot be read further down the supply chain — for example, the packaging covers it — tick «Печатать дубликат Data Matrix» (Print a Data Matrix duplicate). The «Печать дубликата» (Duplicate printing) section appears: choose «Шаблон этикетки продукции» (Product label template; the list shows sizes) and decide whether «Обязательная проверка этикетки» (Mandatory label check) is needed — then the operator must scan the new label before the next unit. Without it the next unit can be scanned as soon as the label is sent to the printer.",
            image: { id: "shift-duplicate-print", caption: "Validation with duplicate printing" },
            expected: "A template is chosen and the label check is set.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "A duplicate does not change the accounting: the full code from the product is carried over to the outer packaging, and the quantity of products does not change. If no suitable template exists, the office says so — add or enable a template in the «Шаблоны» (Templates) section.",
          },
        ],
      },
      {
        id: "after",
        heading: "8. Changing and deleting",
        blocks: [
          {
            kind: "step",
            title: "Open a planned shift",
            text: "Click the eye in the shift's row. The «Смена …» (Shift …) panel shows the status, the shift date and the job's fields; at the top are «Изменить» (Edit) and «Бланк смены» (Shift sheet). «Бланк смены» prints the job for the line; if the product has a photo, it is printed on the sheet.",
            image: { id: "shift-planned", caption: "Card of a planned shift" },
          },
          {
            kind: "step",
            title: "Change a planned shift",
            text: "«Изменить» (Edit) turns the card into a form. The product does not change — the office writes «Товар: … Товар смены не меняется.» (Product: … The shift's product does not change.) Mode, dates, plan, line, counterparty, templates and pallets can be changed. Click «Сохранить» (Save).",
            image: { id: "shift-planned-edit", caption: "Changing a planned shift" },
            expected: "The office reports «Изменения сохранены.» (Changes saved.)",
          },
          {
            kind: "step",
            title: "Only the plan of an active shift changes",
            text: "«…» menu in an active shift's row → «Изменить план» (Change the plan). The «План смены …» (Plan of shift …) window explains that the shift is already running at the station, so only its plan changes, and that the plan is not printed on labels. An empty field means no plan.",
            image: { id: "shift-active-plan", caption: "Plan of an active shift" },
          },
          {
            kind: "step",
            title: "Delete a shift only before it is opened",
            text: "«…» menu in a planned shift's row → «Удалить» (Delete). The office asks «Удалить смену …?» (Delete shift …?) and warns that the shift will be deleted permanently and its number will not be issued again. Active and closed shifts have no such action.",
            image: { id: "shift-delete", caption: "Confirming the deletion of a shift" },
          },
          {
            kind: "paragraph",
            text: "A planned shift in the list may be marked «Не откроется: …» (Will not open: …) — for example, «Не откроется: товар — черновик» (Will not open: the product is a draft) or «Не откроется: шаблон выключен или не подходит товару» (Will not open: the template is disabled or does not fit the product). The station will not open such a shift: fix the product or choose another template.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "The office and the stations work at the same time. If the shift was opened at a station while the form was open, the office does not save the changes and reports that the shift is already open at the station, so only its plan can be changed now, and that the list was refreshed.",
          },
        ],
      },
      {
        id: "faq",
        heading: "9. Frequently asked questions",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The product is not in the list",
                detail:
                  "Only active products are listed. Complete a draft until it is «Активен» (Active), restore an archived product (MKR-INS-10).",
              },
              {
                term: "I do not see the capacity and pallets",
                detail:
                  "They exist only in the Aggregation mode. The pallet fields appear after ticking «С паллетами» (With pallets).",
              },
              {
                term: "The «С паллетами» checkbox is unavailable",
                detail:
                  "The product has no boxes-per-pallet value. Set it in the product card and open the form again.",
              },
              {
                term: "The station does not see the shift",
                detail:
                  "Check the shift's line and the station's line in the «Устройства» (Devices) section, as well as the status: a station opens planned and active shifts of its own line.",
              },
              {
                term: "A line cannot be deleted",
                detail:
                  "Lines are archived, not deleted: «…» menu → «В архив» (Archive). Move stations already working on the line in the «Устройства» (Devices) section.",
              },
              {
                term: "There is no «Устройства» section",
                detail:
                  "It is available to the office administrator only. The technologist sees shifts, lines and products.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "If your problem is not described above, contact Markiro support: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
