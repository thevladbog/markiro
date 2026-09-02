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
            text: "На экране «Подключение станции» введите восьмизначный код в поле «Код подключения» на экранной клавиатуре или отсканируйте его, затем нажмите «Подключить станцию». Станция покажет «Подключаем…» — идёт проверка кода и загрузка настроек.",
            image: {
              id: "pairing-waiting",
              caption: "Экран «Подключение станции»: ввод кода из кабинета",
            },
            expected: "Станция показала «Станция подключена».",
          },
          {
            kind: "step",
            title: "Перейдите к настройке оборудования",
            text: "После сообщения «Станция подключена» станция сама перейдёт к работе. Настройку оборудования открывайте кнопкой «Настройка оборудования» на экране подключения (до ввода кода) или кнопкой «Настройка рабочего места» на экране выбора смены. Настройте сканер, принтер и звук (разделы 3–5).",
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
            text: "На вкладке «Сканер» в блоке «Подключение» выберите «Порт» и «Скорость (бод)» по паспорту сканера, затем нажмите «Подключить сканер». Рядом — блок «Проверка сканера»: станция показывает на экране штрихкод с подписью и просит «Отсканируйте этот код прямо с экрана». Отсканируйте его с монитора — при успехе появится «Код совпал — сканер работает корректно». Если пришёл не тот код, станция покажет, что именно она получила; кнопка «Новый код» выдаёт свежий код для повторной проверки.",
            image: {
              id: "setup-scanner",
              caption: "Настройка сканера: подключение и проверка кодом с экрана",
            },
            expected: "«Код совпал — сканер работает корректно».",
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
            text: "На вкладке «Принтер» в блоке «Подключение» укажите «Подключение принтера»: «Сеть (TCP)» — «Адрес принтера» и «TCP-порт принтера»; «COM-порт» — порт и скорость; «Windows (USB)» — выберите установленный принтер Windows из списка (кнопка «Обновить список» перечитывает его). Затем выберите «Язык принтера» — ZPL или TSPL, по документации принтера. Если на этом рабочем месте этикетки не печатают, оставьте «Без принтера».",
            image: {
              id: "setup-printer",
              caption: "Настройка принтера: подключение и проверка печати",
            },
          },
          {
            kind: "step",
            title: "Пройдите проверку печати",
            text: "В блоке «Проверка печати» станция просит: «Напечатайте тестовую этикетку и отсканируйте её». Нажмите «Тестовая печать» — сообщение «Тестовая этикетка отправлена на принтер» подтверждает только отправку. Затем отсканируйте код с вышедшей этикетки: при успехе появится «Этикетка напечатана и распознана — принтер работает». Так проверяется вся цепочка сразу — подключение, язык принтера, качество печати и сканер.",
            expected: "«Этикетка напечатана и распознана — принтер работает».",
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
            image: {
              id: "update-warn",
              caption: "Доступно обновление: возраст релиза и установка",
            },
            expected: "Станция перезапустилась на новой версии.",
          },
          {
            kind: "step",
            title: "Не обновляйте станцию во время смены",
            text: "При активной смене установка заблокирована: «Завершите активную смену перед установкой». Дождитесь закрытия смены оператором; неотправленные операции тоже должны уйти на сервер.",
            image: {
              id: "update-active-shift",
              caption: "Установка заблокирована активной сменой",
            },
          },
        ],
      },
      {
        id: "service",
        heading: "7. Сервисные операции",
        blocks: [
          {
            kind: "paragraph",
            text: "Кнопка «Привязать станцию заново» (в настройке рабочего места) используется только когда сервисному пользователю нужно повторно привязать эту же станцию: ключ устройства будет удалён, локальные производственные записи останутся на станции. «Сервисное подключение» — отдельный путь с учётными данными от сервиса; он не заменяет обычное подключение кодом.",
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
                term: "У сканера или принтера подпись настроен, не обнаружен",
                detail:
                  "Сохранённое устройство не найдено на этой машине: проверьте кабель и питание, затем заново выберите порт или принтер в настройке.",
              },
              {
                term: "Установленные принтеры Windows не найдены",
                detail:
                  "Установите драйвер принтера средствами Windows, затем нажмите «Обновить список» в блоке «Принтер».",
              },
              {
                term: "Тестовая этикетка не вышла или не распознаётся",
                detail:
                  "Сообщение об отправке не гарантирует печать. Проверьте адрес/порт подключения, язык принтера (ZPL/TSPL по документации) и ленту, затем повторите «Тестовая печать». Проверка засчитывается только после сканирования кода с этикетки — если станция показывает, что получен другой код, вы отсканировали не ту этикетку (например, вчерашнюю тестовую).",
              },
              {
                term: "Срок действия кода подключения истёк",
                detail:
                  "Коды одноразовые и ограничены по времени. Создайте новый код в кабинете администратора и введите его на станции.",
              },
              {
                term: "Нужно перенести станцию на другую линию",
                detail:
                  "Обратитесь в поддержку Маркиро — самостоятельная повторная привязка без сопровождения не рекомендуется.",
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
    title: "Scanning station: workstation setup",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Technician's guide: pairing the station with the cabinet, connecting the scanner and the printer, sound, and station updates.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction is intended for a technician or an administrator and covers preparing a scanning station workstation: pairing the station with the cabinet, connecting the barcode scanner and the label printer, sound, and updates. It is performed when a new workstation is commissioned or when hardware is replaced.",
          },
          {
            kind: "paragraph",
            text: "The operator's daily work is covered by separate instructions: sign-in and shift start (MKR-INS-01), the work cycle (MKR-INS-02), exceptions (MKR-INS-03).",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots use demo data. Addresses, version numbers and names on your station will differ.",
          },
        ],
      },
      {
        id: "pairing",
        heading: "2. Pairing the station",
        blocks: [
          {
            kind: "step",
            title: "Create a pairing code in the cabinet",
            text: "Open the station page in the administrator cabinet and create an eight-digit pairing code for this line. The code is single-use and valid for a limited time.",
          },
          {
            kind: "step",
            title: "Enter the code on the station",
            text: "On the “Connect station” screen, type the eight-digit code into the “Pairing code” field on the on-screen keyboard or scan it, then tap “Pair station”. The station shows “Pairing…” — the code is being checked and the settings are being downloaded.",
            image: {
              id: "pairing-waiting",
              caption: "The “Connect station” screen: entering the code from the cabinet",
            },
            expected: "The station showed “Station connected”.",
          },
          {
            kind: "step",
            title: "Move on to hardware setup",
            text: "After the “Station connected” message the station proceeds to work by itself. Open the hardware setup with the “Equipment setup” button on the connection screen (before entering the code) or the “Workstation setup” button on the shift selection screen. Configure the scanner, the printer and the sound (sections 3–5).",
            image: { id: "pairing-success", caption: "The station is connected to the cabinet" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If the station reports “This pairing code is not valid” or “This pairing code has expired”, create a new pairing code in the cabinet and enter it here. The old code will not work again.",
          },
        ],
      },
      {
        id: "scanner",
        heading: "3. Scanner",
        blocks: [
          {
            kind: "step",
            title: "Connect and check the scanner",
            text: "On the “Scanner” tab, in the “Connection” block, choose the “Port” and the “Baud rate” according to the scanner's datasheet, then tap “Connect scanner”. Next to it is the “Scanner check” block: the station shows a barcode with a caption and asks you to “Scan this code straight off the screen”. Scan it from the monitor — on success you will see “Code matches — the scanner works correctly”. If a different code came in, the station shows exactly what it received; the “New code” button issues a fresh code for another check.",
            image: {
              id: "setup-scanner",
              caption: "Scanner setup: connection and the on-screen code check",
            },
            expected: "“Code matches — the scanner works correctly”.",
          },
          {
            kind: "paragraph",
            text: "If the scanner works in keyboard mode (input emulation), choose “No serial scanner (keyboard-wedge)” — the port and the baud rate are not configured in this mode.",
          },
        ],
      },
      {
        id: "printer",
        heading: "4. Printer",
        blocks: [
          {
            kind: "step",
            title: "Choose the printer connection",
            text: "On the “Printer” tab, in the “Connection” block, set the “Printer connection”: “Network (TCP)” — the “Printer address” and the “Printer TCP port”; “Serial (COM port)” — the port and the baud rate; “Windows (USB)” — pick an installed Windows printer from the list (the “Refresh list” button re-reads it). Then choose the “Printer language” — ZPL or TSPL, per the printer's documentation. If this workstation does not print labels, keep “No printer”.",
            image: {
              id: "setup-printer",
              caption: "Printer setup: connection and the print check",
            },
          },
          {
            kind: "step",
            title: "Pass the print check",
            text: "In the “Print check” block the station asks you to “Print a test label, then scan it”. Tap “Test print” — the “Test label sent to the printer” message only confirms the sending. Then scan the code from the label that came out: on success you will see “Label printed and recognized — the printer works”. This checks the whole chain at once — the connection, the printer language, the print quality and the scanner.",
            expected: "“Label printed and recognized — the printer works”.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The “Verify each printed label by scanning it back” checkbox enables the mandatory box label verification after printing (covered by the work cycle instruction). Keeping it on is recommended for aggregation workstations.",
          },
        ],
      },
      {
        id: "sound",
        heading: "5. Sound",
        blocks: [
          {
            kind: "step",
            title: "Turn the station sound on",
            text: "In the “Sound” block, enable the audio signals. Line operators rely on the scan verdict sounds — without them it is easy to miss a duplicate or an error while not looking at the screen.",
            image: { id: "setup-sound", caption: "Station sound setup" },
          },
        ],
      },
      {
        id: "updates",
        heading: "6. Station updates",
        blocks: [
          {
            kind: "step",
            title: "Check the station version",
            text: "Open “Station updates” (the “Updates” indicator on the shift selection screen) and tap “Check for updates”. If the version is current, the station reports: “This station is up to date.”",
            image: { id: "update-current", caption: "The update center: the version is current" },
          },
          {
            kind: "step",
            title: "Install an available update",
            text: "If a new version is available, the station shows its age: “Released recently”, “This release is more than 7 days old” or “This release is more than 30 days old; update when convenient”. Tap “Download and install” and confirm — the version is downloaded and the station restarts. Updates are installed manually only.",
            image: {
              id: "update-warn",
              caption: "An update is available: the release age and installation",
            },
            expected: "The station restarted on the new version.",
          },
          {
            kind: "step",
            title: "Do not update the station during a shift",
            text: "While a shift is active, installation is blocked: “Leave the active shift before installing”. Wait until the operator closes the shift; unsent operations must reach the server too.",
            image: {
              id: "update-active-shift",
              caption: "Installation is blocked by an active shift",
            },
          },
        ],
      },
      {
        id: "service",
        heading: "7. Service operations",
        blocks: [
          {
            kind: "paragraph",
            text: "The “Re-pair this station” button (in the workstation setup) is used only when a service user needs to pair this same station again: the device key is deleted, and the local production records stay on the station. “Service connection” is a separate path with credentials issued by support; it does not replace the normal code-based pairing.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Both operations are rare and are performed only together with Markiro support. Do not run them to fix ordinary connectivity or hardware problems.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "8. Frequently asked questions",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The scanner or the printer is labelled configured, not detected",
                detail:
                  "The saved device was not found on this machine: check the cable and the power, then pick the port or the printer again in the setup.",
              },
              {
                term: "No installed Windows printers found",
                detail:
                  "Install the printer driver through Windows, then tap “Refresh list” in the “Printer” block.",
              },
              {
                term: "The test label did not come out or is not recognized",
                detail:
                  "The sent message does not guarantee printing. Check the connection address/port, the printer language (ZPL/TSPL per the documentation) and the ribbon, then repeat “Test print”. The check only counts after scanning the code from the label — if the station shows that a different code came in, you scanned the wrong label (for example, yesterday's test one).",
              },
              {
                term: "The pairing code has expired",
                detail:
                  "Codes are single-use and time-limited. Create a new code in the administrator cabinet and enter it on the station.",
              },
              {
                term: "The station must move to another line",
                detail:
                  "Contact Markiro support — re-pairing on your own without guidance is not recommended.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "If your problem is not listed above, contact Markiro support: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
