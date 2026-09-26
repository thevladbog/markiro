import type { LegalDocumentSource } from "../types.js";

export const STATION_OPERATOR_SHIFT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: вход оператора и старт смены",
    summary:
      "Пошаговая инструкция оператора: вход на станцию по бейджу, выбор или создание смены и начало работы.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает ежедневный вход оператора на станцию сканирования Маркиро и старт смены: от считывания бейджа до готового к работе экрана. Инструкция предназначена для операторов линии; настройка оборудования и привязка станции описаны в отдельных документах.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия продуктов, номера смен и имена на вашей станции будут отличаться.",
          },
        ],
      },
      {
        id: "preparation",
        heading: "2. Подготовка к работе",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "Станция включена, приложение станции запущено.",
              "Сканер и принтер этикеток подключены: в строке состояния нет значков ошибок оборудования.",
              "У вас есть личный бейдж оператора и PIN-код.",
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если станция показывает экран привязки (код сопряжения) или ошибку подключения — не продолжайте работу, позовите наладчика или администратора.",
          },
        ],
      },
      {
        id: "login",
        heading: "3. Вход по бейджу",
        blocks: [
          {
            kind: "step",
            title: "Поднесите бейдж к сканеру",
            text: "На экране входа поднесите личный бейдж к сканеру штрихкодов. Держите бейдж в 10–20 см от сканера до звукового сигнала.",
            image: { id: "login-badge", caption: "Экран входа: станция ожидает бейдж оператора" },
            expected: "Станция распознала бейдж и показала ваше имя.",
          },
          {
            kind: "step",
            title: "Введите PIN-код",
            text: "Наберите личный PIN-код на экранной клавиатуре и подтвердите ввод.",
            image: { id: "login-pin", caption: "Ввод PIN-кода оператора" },
            expected: "Открылся экран выбора смены.",
          },
          {
            kind: "step",
            title: "Если бейдж не читается — найдите себя по имени",
            text: "Нажмите «Найти по имени», начните вводить фамилию и выберите себя в списке, затем введите PIN-код. После смены сообщите о неисправном бейдже администратору.",
            image: { id: "login-name-search", caption: "Поиск оператора по имени" },
          },
        ],
      },
      {
        id: "shift-select",
        heading: "4. Выбор существующей смены",
        blocks: [
          {
            kind: "paragraph",
            text: "Если смена уже создана (например, вы возвращаетесь после перерыва или смену подготовил мастер), выберите её из списка.",
          },
          {
            kind: "step",
            title: "Выберите смену из списка",
            text: "На экране выбора смены найдите нужную смену по номеру, продукту и дате и нажмите на её карточке «Открыть» — или «Присоединиться», если смена уже идёт. Закрытые смены в списке не показываются. Смена со сборкой паллет помечена на карточке меткой «Паллеты» рядом с режимом.",
            image: {
              id: "shift-select",
              caption: "Список смен: карточки с номером, продуктом и датой",
            },
            expected: "Открылся рабочий экран выбранной смены.",
          },
        ],
      },
      {
        id: "new-shift",
        heading: "5. Создание новой смены",
        blocks: [
          {
            kind: "step",
            title: "Найдите продукт",
            text: "Если нужной смены нет в списке, нажмите «Новая смена». Отсканируйте штрихкод продукта или код маркировки с упаковки — или введите GTIN вручную и нажмите «Открыть». Если станция сообщит «Товар не найден в каталоге», товар сначала нужно добавить в кабинете — обратитесь к администратору.",
            image: { id: "new-shift", caption: "Новая смена: поле для GTIN продукта" },
            expected: "Станция нашла продукт и показала его название и GTIN.",
          },
          {
            kind: "step",
            title: "Выберите режим и сборку паллет",
            text: "Выберите режим смены — «Проверка» или «Агрегация»; чем они отличаются, описано в инструкции MKR-INS-02. В режиме «Агрегация» ниже появятся кнопки «Без паллет» и «С паллетами». Выберите «С паллетами», если закрытые короба этой смены нужно собирать в паллеты. Под кнопками станция показывает, сколько коробов встаёт на паллету: это число берётся из карточки товара, например «66 коробов на паллете · из карточки товара». Если в карточке товара оно не указано, кнопка «С паллетами» неактивна. Затем проверьте дату производства — поле необязательное, дату берите с продукции — и нажмите «Начать».",
            image: {
              id: "new-shift-pallets",
              caption: "Новая смена в режиме «Агрегация» со сборкой паллет",
            },
          },
          {
            kind: "step",
            title: "Для агрегации выберите шаблоны этикеток",
            text: "В режиме «Агрегация» станция покажет список «Шаблон этикетки короба». Шаблон с отметкой «По умолчанию» уже выбран; при необходимости выберите другой. В смене с паллетами кнопка внизу называется «Далее»: за ней так же выбирается «Этикетка паллеты». Нажмите «Начать».",
            expected: "Станция создала смену и открыла рабочий экран.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Как станция собирает паллеты во время смены — ставит на паллету каждый закрытый короб, закрывает заполненную паллету и печатает её этикетку, — описано в инструкции MKR-INS-02, раздел 5.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Проверьте продукт и дату производства до подтверждения: они печатаются на этикетках коробов. Если ошиблись — закройте смену и создайте новую, сообщив мастеру.",
          },
        ],
      },
      {
        id: "work-start",
        heading: "6. Начало работы",
        blocks: [
          {
            kind: "step",
            title: "Проверьте рабочий экран",
            text: "Перед первым сканированием убедитесь: в шапке — ваша линия и смена; на ленте смены вверху экрана — нужный продукт и план; итог «В смене» равен нулю или тому, что в смене уже сделано. Индикаторы состояния в шапке свёрнуты в точки, пока всё в порядке; проблемный индикатор сам раскрывается подписью, а кнопка «Развернуть» показывает полную панель состояния.",
            image: {
              id: "work-start",
              caption: "Рабочий экран: смена открыта, станция готова к сканированию",
            },
            expected:
              "Станция готова: отсканируйте первый код маркировки — результат появится на экране.",
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
                term: "Бейдж не читается",
                detail:
                  "Используйте вход через поиск по имени (раздел 3, шаг 3) и сообщите администратору о замене бейджа.",
              },
              {
                term: "Станция не принимает PIN-код",
                detail:
                  "Проверьте раскладку и повторите ввод. После нескольких неверных попыток обратитесь к администратору для сброса PIN-кода.",
              },
              {
                term: "Нужной смены нет в списке",
                detail:
                  "Создайте новую смену (раздел 5) или уточните у мастера, на какой станции была открыта смена.",
              },
              {
                term: "Кнопка «С паллетами» неактивна",
                detail:
                  "В карточке товара не указано, сколько коробов встаёт на паллету. Попросите администратора указать это число в карточке товара в кабинете, затем начните создание смены заново.",
              },
              {
                term: "Строка состояния показывает ошибку оборудования",
                detail:
                  "Не начинайте сканирование. Проверьте кабели сканера и принтера; если ошибка не ушла — позовите наладчика.",
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
  en: {
    locale: "en",
    title: "Scanning station: operator sign-in and shift start",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Step-by-step operator guide: signing in at the station with a badge, selecting or creating a shift, and starting work.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the operator's daily sign-in at a Markiro scanning station and the shift start: from scanning the badge to a screen that is ready for work. It is intended for line operators; hardware setup and station pairing are covered by separate documents.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots use demo data. Product names, shift numbers and operator names on your station will differ.",
          },
        ],
      },
      {
        id: "preparation",
        heading: "2. Before you start",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "The station is powered on and the station app is running.",
              "The scanner and the label printer are connected: the status bar shows no hardware error icons.",
              "You have your personal operator badge and PIN code.",
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If the station shows the pairing screen (a pairing code) or a connection error, do not continue working — call a technician or an administrator.",
          },
        ],
      },
      {
        id: "login",
        heading: "3. Signing in with a badge",
        blocks: [
          {
            kind: "step",
            title: "Hold your badge up to the scanner",
            text: "On the sign-in screen, hold your personal badge up to the barcode scanner. Keep the badge 10–20 cm away from the scanner until you hear the beep.",
            image: {
              id: "login-badge",
              caption: "Sign-in screen: the station is waiting for an operator badge",
            },
            expected: "The station recognized the badge and showed your name.",
          },
          {
            kind: "step",
            title: "Enter your PIN code",
            text: "Type your personal PIN code on the on-screen keyboard and confirm the input.",
            image: { id: "login-pin", caption: "Entering the operator PIN code" },
            expected: "The shift selection screen opened.",
          },
          {
            kind: "step",
            title: "If the badge cannot be read, find yourself by name",
            text: "Tap “Find by name”, start typing your last name and pick yourself from the list, then enter your PIN code. After the shift, report the faulty badge to an administrator.",
            image: { id: "login-name-search", caption: "Finding an operator by name" },
          },
        ],
      },
      {
        id: "shift-select",
        heading: "4. Selecting an existing shift",
        blocks: [
          {
            kind: "paragraph",
            text: "If a shift already exists (for example, you are returning after a break or a supervisor prepared the shift), select it from the list.",
          },
          {
            kind: "step",
            title: "Select a shift from the list",
            text: "On the shift selection screen, find the shift by its number, product and date, and tap “Open” on its card — or “Rejoin” if the shift is already running. Closed shifts are not shown in the list. A shift that builds pallets carries a “Pallets” tag next to its mode on the card.",
            image: {
              id: "shift-select",
              caption: "Shift list: cards with the number, product and date",
            },
            expected: "The work screen of the selected shift opened.",
          },
        ],
      },
      {
        id: "new-shift",
        heading: "5. Creating a new shift",
        blocks: [
          {
            kind: "step",
            title: "Find the product",
            text: "If the shift you need is not in the list, tap “New shift”. Scan the product barcode or a marking code from the packaging — or type the GTIN and tap “Open”. If the station reports “Product is not in the catalog”, the product has to be added in the cabinet first — contact an administrator.",
            image: { id: "new-shift", caption: "New shift: the product GTIN field" },
            expected: "The station found the product and showed its name and GTIN.",
          },
          {
            kind: "step",
            title: "Choose the mode and pallet assembly",
            text: "Choose the shift mode — “Validation” or “Aggregation”; instruction MKR-INS-02 explains the difference. For “Aggregation”, the “Without pallets” and “With pallets” buttons appear below. Choose “With pallets” if the shift's closed boxes are to be built into pallets. Under the buttons the station shows how many boxes go on a pallet: the number comes from the product card, for example “66 boxes per pallet · from the product card”. If the product card has no such number, “With pallets” is unavailable. Then check the production date — the field is optional, take the date from the product — and tap “Start”.",
            image: {
              id: "new-shift-pallets",
              caption: "A new shift in “Aggregation” mode with pallet assembly",
            },
          },
          {
            kind: "step",
            title: "For aggregation, choose the label templates",
            text: "In “Aggregation” mode the station shows the “Box label template” list. A template marked “Default” is already selected; pick another one if needed. On a shift with pallets the button at the bottom reads “Next”, and after it you choose the “Pallet label template” the same way. Tap “Start”.",
            expected: "The station created the shift and opened the work screen.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "How the station builds pallets during the shift — it puts every closed box onto the pallet, closes a full pallet and prints its label — is covered in instruction MKR-INS-02, section 5.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Check the product and the production date before confirming: they are printed on box labels. If you made a mistake, close the shift and create a new one, and tell your supervisor.",
          },
        ],
      },
      {
        id: "work-start",
        heading: "6. Starting work",
        blocks: [
          {
            kind: "step",
            title: "Check the work screen",
            text: "Before the first scan make sure: the header shows your line and shift; the shift band at the top of the screen shows the right product and plan; the “In shift” total is zero or matches the work already done in the shift. The status indicators in the header collapse into dots while everything is fine; a problem indicator expands into a caption by itself, and the “Expand” button opens the full status panel.",
            image: {
              id: "work-start",
              caption: "Work screen: the shift is open, the station is ready to scan",
            },
            expected:
              "The station is ready: scan the first marking code — the result will appear on the screen.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "7. Common problems",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The badge cannot be read",
                detail:
                  "Sign in through the search by name (section 3, step 3) and ask an administrator to replace the badge.",
              },
              {
                term: "The station rejects the PIN code",
                detail:
                  "Check the keyboard layout and try again. After several failed attempts, contact an administrator to reset the PIN code.",
              },
              {
                term: "The shift you need is not in the list",
                detail:
                  "Create a new shift (section 5) or check with your supervisor which station the shift was opened on.",
              },
              {
                term: "The “With pallets” button is unavailable",
                detail:
                  "The product card does not say how many boxes go on a pallet. Ask an administrator to set this number on the product card in the cabinet, then start creating the shift again.",
              },
              {
                term: "The status bar shows a hardware error",
                detail:
                  "Do not start scanning. Check the scanner and printer cables; if the error persists, call a technician.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "If your problem is not listed above, contact your organization's administrator or Markiro support: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
