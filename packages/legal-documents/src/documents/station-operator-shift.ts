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
            text: "На экране выбора смены найдите нужную смену по номеру, продукту и дате производства и нажмите на её карточку. Открытые смены отображаются первыми.",
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
            title: "Создайте новую смену",
            text: "Если нужной смены нет в списке, нажмите «Новая смена». Отсканируйте код продукта с упаковки или выберите продукт вручную, проверьте дату производства и подтвердите создание.",
            image: {
              id: "new-shift",
              caption: "Создание смены: выбор продукта и даты производства",
            },
            expected: "Станция создала смену и открыла рабочий экран.",
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
            text: "Перед первым сканированием убедитесь: в шапке — ваша линия и смена; в карточке товара — нужный продукт и план; счётчики обнулены или соответствуют уже сделанному. Индикаторы состояния в шапке свёрнуты в точки, пока всё в порядке; проблемный индикатор сам раскрывается подписью, а кнопка «Развернуть» показывает полную панель состояния.",
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
            text: "On the shift selection screen, find the shift by its number, product and production date, and tap its card. Open shifts are listed first.",
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
            title: "Create a new shift",
            text: "If the shift you need is not in the list, tap “New shift”. Scan the product code from the packaging or pick the product manually, check the production date and confirm the creation.",
            image: {
              id: "new-shift",
              caption: "Creating a shift: choosing the product and the production date",
            },
            expected: "The station created the shift and opened the work screen.",
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
            text: "Before the first scan make sure: the header shows your line and shift; the product card shows the right product and plan; the counters are at zero or match the work already done. The status indicators in the header collapse into dots while everything is fine; a problem indicator expands into a caption by itself, and the “Expand” button opens the full status panel.",
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
