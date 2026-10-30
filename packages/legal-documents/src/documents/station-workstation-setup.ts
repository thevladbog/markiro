import type { LegalDocumentSource } from "../types.js";

export const STATION_WORKSTATION_SETUP_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция: подключение к хосту и настройка рабочего места",
    summary:
      "Пошаговая инструкция наладчика Маркиро Автоном: подключение станции к хосту в локальной сети по коду из офиса, выбор линии, принтеры и назначение печати, сканеры и проверка чтения, звук, обновление и отвязка станции.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает, как наладчик или администратор подключает станцию Маркиро Автоном к хосту — главному компьютеру площадки — и настраивает её рабочее место: принтеры этикеток, сканеры, звук, версию программы. Работа оператора на станции описана в MKR-INS-01–03.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Адреса, имена устройств, отпечаток хоста и коды на вашей площадке будут другими.",
          },
        ],
      },
      {
        id: "preparation",
        heading: "2. Подготовка",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "Хост установлен и запущен, станция и хост в одной локальной сети.",
              "Есть доступ к офису Маркиро Автоном с правами администратора: код подключения создаётся в офисе, в разделе «Устройства».",
              "Известны адреса сетевых принтеров или подключены принтеры Windows и COM-устройства.",
            ],
          },
          {
            kind: "paragraph",
            text: "Если приложение станции установлено на тот же компьютер, что и хост, оно подключается к хосту само — разделы 3.1–3.4 можно пропустить.",
          },
        ],
      },
      {
        id: "pairing",
        heading: "3. Подключение станции к хосту",
        blocks: [
          {
            kind: "step",
            title: "3.1. Перейдите к подключению в сети",
            text: "При первом запуске станция на своём компьютере не находит хост и показывает «Служба хоста не отвечает». Нажмите «Подключиться к хосту в сети».",
            image: { id: "pairing-start", caption: "Первый запуск: на этом компьютере хоста нет" },
          },
          {
            kind: "step",
            title: "3.2. Отсканируйте код с экрана офиса",
            text: "В офисе откройте раздел «Устройства» и нажмите «Подключить устройство»: офис покажет код подключения для сканера, сам код, адрес и отпечаток хоста. На станции задайте «Имя устройства» — так станция будет называться в офисе, — наведите сканер станции на код на экране офиса и нажмите «Подключить».",
            image: {
              id: "pairing-network",
              caption: "Подключение к хосту в сети: имя устройства и код с экрана офиса",
            },
          },
          {
            kind: "step",
            title: "3.3. Или введите адрес и код вручную",
            text: "Если сканер не читает код с экрана, нажмите «Ввести адрес и код вручную». Введите «Адрес хоста» — например, 192.168.1.10; порт 45710 подставляется сам — и «Код подключения» из 10 символов с экрана офиса, затем «Далее».",
            image: {
              id: "pairing-manual",
              caption: "Адрес хоста и код подключения, введённые вручную",
            },
          },
          {
            kind: "step",
            title: "3.4. Сверьте отпечаток хоста",
            text: "Станция покажет отпечаток хоста по этому адресу. Сверьте его с отпечатком на экране офиса: код уйдёт на хост, только если они совпадают. Нажмите «Отпечаток совпадает»; если отпечаток другой — «Не совпадает» и проверьте адрес хоста.",
            image: {
              id: "pairing-fingerprint",
              caption: "Сверка отпечатка хоста перед отправкой кода",
            },
          },
          {
            kind: "step",
            title: "3.5. Выберите линию",
            text: "После подключения станция получает справочники с хоста и показывает «Выбор линии». Нажмите линию, на которой работает эта станция.",
            image: { id: "line-select", caption: "Выбор линии станции" },
            expected: "Станция показывает «Вход оператора» с именем станции и линии в шапке.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Код подключения одноразовый и действует ограниченное время; после пяти неверных попыток с любого устройства он перестаёт действовать. Если станция пишет, что код неверен или устарел, создайте в офисе новый код.",
          },
        ],
      },
      {
        id: "printers",
        heading: "4. Принтеры",
        blocks: [
          {
            kind: "paragraph",
            text: "Настройка станции открывается кнопкой «Рабочее место» на экране «Смены линии» (после входа оператора). Вкладки: «Принтеры», «Сканеры», «Звук» и «Станция». Изменения вступают в силу после «Сохранить»; пока изменений нет, внизу написано «Нет изменений».",
          },
          {
            kind: "step",
            title: "Добавьте принтер",
            text: "На вкладке «Принтеры» нажмите «Добавить принтер». Задайте «Название» и «Подключение»: «Сеть» — адрес принтера и «Порт» (обычно 9100), «COM-порт» — порт и скорость, «Windows» — принтер, установленный в Windows с драйвером. Выберите «Язык принтера»: ZPL — принтеры Zebra, TSPL — принтеры TSC, и «Разрешение принтера» — 203 или 300 dpi, как у самого принтера. Нажмите «Готово».",
            image: { id: "setup-printer-form", caption: "Новый сетевой принтер" },
          },
          {
            kind: "step",
            title: "Назначьте печать и проверьте принтер",
            text: "В блоке «Что на каком принтере» выберите принтер для «Этикетка короба», «Этикетка паллеты» и «Дубль кода». «Пробная печать» печатает тестовую этикетку; отсканируйте её код — «Код совпал: принтер и сканер работают.». Переключатель «Проверять этикетку короба» включает проверку каждой этикетки короба сканом SSCC (MKR-INS-02). Нажмите «Сохранить».",
            image: { id: "setup-printers", caption: "Принтеры рабочего места и назначение печати" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Лист А4 печатает паллету на обычном принтере: только назначение «Этикетка паллеты», 300 dpi, через драйвер Windows.",
          },
        ],
      },
      {
        id: "scanners",
        heading: "5. Сканеры",
        blocks: [
          {
            kind: "step",
            title: "Подключите сканер и проверьте чтение",
            text: "«Клавиатурный сканер» — USB-сканер в режиме клавиатуры — работает всегда, без настройки. Сканер на COM-порту добавьте: выберите «COM-порт» и «Скорость, бод» — как в настройке самого сканера — и нажмите «Добавить»; «Обновить список портов» перечитывает порты компьютера. Справа — «Проверка сканера»: станция показывает тестовый код («Простой код» или «DataMatrix с GS»), вы сканируете его с экрана, и станция сверяет, что пришло, символ в символ — в том числе разделители GS и раскладку. Нажмите «Сохранить».",
            image: { id: "setup-scanners", caption: "Сканеры станции и проверка чтения" },
          },
          {
            kind: "paragraph",
            text: "Если сканер вводит символы в русской раскладке, переключите раскладку компьютера станции на английскую. Если COM-сканер перестал отвечать, на экране входа появляется кнопка «Настройки сканера».",
          },
        ],
      },
      {
        id: "sound",
        heading: "6. Звук",
        blocks: [
          {
            kind: "step",
            title: "Настройте звук сигналов",
            text: "На вкладке «Звук» переключатель «Звук сигналов» включает звуковые сигналы сканирования; при выключенном звуке визуальные сигналы сохраняются. «Громкость сигналов» — десять уровней, кнопки «Тише» и «Громче». «Проверить звук» проигрывает сигнал. Установите хорошо слышимый в цеху уровень и нажмите «Сохранить».",
            image: { id: "setup-sound", caption: "Звук сигналов и громкость" },
          },
        ],
      },
      {
        id: "station",
        heading: "7. Станция: версия, обновление и отвязка",
        blocks: [
          {
            kind: "step",
            title: "Проверьте подключение и версию",
            text: "Вкладка «Станция» показывает «Эта станция»: имя станции, устройство и адрес хоста, а также «Тема цеха» — «Системная», «Светлая» или «Тёмная». В «Версия программы» — версия станции; «Проверить обновление» спрашивает хост, есть ли новая версия. Обновление приходит с компьютера-хоста, без интернета; кнопка «Обновить» ставит его. Обновление ставится вне смены.",
            image: {
              id: "setup-station",
              caption: "Вкладка «Станция»: подключение, тема, версия и отвязка",
            },
          },
          {
            kind: "paragraph",
            text: "«Отвязать станцию» нужна, когда станцию переносят к другому хосту или выводят из работы. Станция забудет хост и свои справочники; подключить её снова можно только с новым кодом из офиса. Пока смена открыта, отвязать станцию нельзя. Перед отвязкой станция покажет, сколько записей не отправлено на хост, — записи останутся на диске, но при подключении как нового устройства или к другому хосту не отправятся, — и попросит подтвердить, что это вы: бейджем или табельным номером и PIN.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "8. Частые проблемы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Хост не отвечает по этому адресу",
                detail:
                  "Проверьте адрес, что компьютер-хост включён и находится в той же сети, и что брандмауэр хоста пропускает порт 45710.",
              },
              {
                term: "По адресу отвечает другая программа",
                detail:
                  "Адрес указывает на другой компьютер или другую программу. Уточните адрес хоста в офисе.",
              },
              {
                term: "Код не принимается",
                detail:
                  "Станция пишет «Проверьте код: 10 символов» или «Код набран русскими буквами — переключите раскладку на английскую». Если код устарел или исчерпал попытки, создайте в офисе новый.",
              },
              {
                term: "Хост не принимает это устройство",
                detail:
                  "Устройство отключили в офисе, базу хоста восстановили из копии или хост сменился. Нажмите «Подключить заново». Для повторного подключения как того же устройства в офисе откройте «Устройства», у этой станции выберите «Привязать заново» и используйте выпущенный для неё код. Отключённое в офисе устройство восстановить так нельзя. Для подключения как нового устройства выберите на станции «Подключить как новое устройство» и создайте обычный код через «Подключить устройство»; неотправленные записи прежнего устройства при этом не отправятся.",
              },
              {
                term: "Принтер не печатает",
                detail:
                  "Проверьте подключение и адрес, язык (ZPL или TSPL) и разрешение принтера, затем сделайте «Пробная печать».",
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
    title: "Station: pairing with the host and workstation setup",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Step-by-step guide for Markiro Autonom technicians: pairing a station with the host on the local network with a code from the office, choosing the line, printers and print assignment, scanners and read check, sound, updating and unpairing the station.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers how a technician or an administrator pairs a Markiro Autonom station with the host — the site's main computer — and sets up its workstation: label printers, scanners, sound and the program version. The operator's work at the station is covered in MKR-INS-01–03.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The station interface is in Russian only. Screen labels are quoted in Russian, with an English translation in brackets. The screenshots use demo data: addresses, device names, the host fingerprint and codes on your site will differ.",
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
              "The host is installed and running; the station and the host are on the same local network.",
              "You have administrator access to the Markiro Autonom office: the pairing code is created in the office, under “Устройства” (Devices).",
              "You know the addresses of network printers, or Windows printers and COM devices are connected.",
            ],
          },
          {
            kind: "paragraph",
            text: "If the station app is installed on the same computer as the host, it pairs with the host by itself — sections 3.1–3.4 can be skipped.",
          },
        ],
      },
      {
        id: "pairing",
        heading: "3. Pairing the station with the host",
        blocks: [
          {
            kind: "step",
            title: "3.1. Go to network pairing",
            text: "On its first start a station on its own computer does not find a host and shows “Служба хоста не отвечает” (The host service is not responding). Tap “Подключиться к хосту в сети” (Connect to the host on the network).",
            image: {
              id: "pairing-start",
              caption: "First start: there is no host on this computer",
            },
          },
          {
            kind: "step",
            title: "3.2. Scan the code from the office screen",
            text: "In the office open “Устройства” (Devices) and click “Подключить устройство” (Connect a device): the office shows a pairing code for the scanner, the code itself, and the host's address and fingerprint. On the station set “Имя устройства” (Device name) — the station is called so in the office — point the station's scanner at the code on the office screen and tap “Подключить” (Connect).",
            image: {
              id: "pairing-network",
              caption:
                "Connecting to the host on the network: device name and the code from the office screen",
            },
          },
          {
            kind: "step",
            title: "3.3. Or enter the address and code by hand",
            text: "If the scanner cannot read the code from the screen, tap “Ввести адрес и код вручную” (Enter the address and code by hand). Enter “Адрес хоста” (Host address) — for example 192.168.1.10; port 45710 is added by itself — and the 10-character “Код подключения” (Pairing code) from the office screen, then “Далее” (Next).",
            image: {
              id: "pairing-manual",
              caption: "The host address and pairing code entered by hand",
            },
          },
          {
            kind: "step",
            title: "3.4. Compare the host fingerprint",
            text: "The station shows the fingerprint of the host at that address. Compare it with the fingerprint on the office screen: the code goes to the host only if they match. Tap “Отпечаток совпадает” (Fingerprint matches); if the fingerprint differs, tap “Не совпадает” (Does not match) and check the host address.",
            image: {
              id: "pairing-fingerprint",
              caption: "Comparing the host fingerprint before the code is sent",
            },
          },
          {
            kind: "step",
            title: "3.5. Choose the line",
            text: "After pairing the station gets reference data from the host and shows “Выбор линии” (Line selection). Tap the line this station works on.",
            image: { id: "line-select", caption: "Choosing the station's line" },
            expected:
              "The station shows “Вход оператора” (Operator sign-in) with the station's and the line's names in the header.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "A pairing code is single-use and valid for a limited time; after five wrong attempts from any device it stops working. If the station says the code is wrong or expired, create a new code in the office.",
          },
        ],
      },
      {
        id: "printers",
        heading: "4. Printers",
        blocks: [
          {
            kind: "paragraph",
            text: "The station's setup opens with the “Рабочее место” (Workstation) button on the “Смены линии” (Line shifts) screen (after an operator signs in). Its tabs are “Принтеры” (Printers), “Сканеры” (Scanners), “Звук” (Sound) and “Станция” (Station). Changes take effect after “Сохранить” (Save); while there are none, the bottom reads “Нет изменений” (No changes).",
          },
          {
            kind: "step",
            title: "Add a printer",
            text: "On the “Принтеры” (Printers) tab tap “Добавить принтер” (Add printer). Set “Название” (Name) and “Подключение” (Connection): “Сеть” (Network) — the printer's address and “Порт” (Port, usually 9100); “COM-порт” (COM port) — the port and speed; “Windows” — a printer installed in Windows with a driver. Choose “Язык принтера” (Printer language): ZPL for Zebra printers, TSPL for TSC printers, and “Разрешение принтера” (Printer resolution) — 203 or 300 dpi, as the printer itself has. Tap “Готово” (Done).",
            image: { id: "setup-printer-form", caption: "A new network printer" },
          },
          {
            kind: "step",
            title: "Assign printing and test the printer",
            text: "Under “Что на каком принтере” (What prints where) choose a printer for “Этикетка короба” (Box label), “Этикетка паллеты” (Pallet label) and “Дубль кода” (Code duplicate). “Пробная печать” (Test print) prints a test label; scan its code — “Код совпал: принтер и сканер работают.” (The code matches: the printer and the scanner work). The “Проверять этикетку короба” (Check the box label) switch turns on checking every box label with a scan of its SSCC (MKR-INS-02). Tap “Сохранить” (Save).",
            image: {
              id: "setup-printers",
              caption: "The workstation's printers and print assignment",
            },
          },
          {
            kind: "callout",
            tone: "info",
            text: "An A4 sheet prints a pallet on an ordinary printer: only for “Этикетка паллеты” (Pallet label), at 300 dpi, through the Windows driver.",
          },
        ],
      },
      {
        id: "scanners",
        heading: "5. Scanners",
        blocks: [
          {
            kind: "step",
            title: "Connect the scanner and check the reading",
            text: "“Клавиатурный сканер” (Keyboard scanner) — a USB scanner in keyboard mode — always works, with no setup. Add a scanner on a COM port: choose “COM-порт” (COM port) and “Скорость, бод” (Speed, baud) — as set in the scanner itself — and tap “Добавить” (Add); “Обновить список портов” (Refresh the port list) rereads the computer's ports. On the right is “Проверка сканера” (Scanner check): the station shows a test code (“Простой код” — Plain code, or “DataMatrix с GS” — DataMatrix with GS), you scan it from the screen, and the station compares what arrived with what is shown, character by character — including GS separators and the keyboard layout. Tap “Сохранить” (Save).",
            image: { id: "setup-scanners", caption: "The station's scanners and the read check" },
          },
          {
            kind: "paragraph",
            text: "If the scanner types in the Russian layout, switch the station computer's layout to English. If a COM scanner stops responding, the sign-in screen shows a “Настройки сканера” (Scanner settings) button.",
          },
        ],
      },
      {
        id: "sound",
        heading: "6. Sound",
        blocks: [
          {
            kind: "step",
            title: "Set up the signal sound",
            text: "On the “Звук” (Sound) tab the “Звук сигналов” (Signal sound) switch turns the scan beeps on; with sound off the visual signals remain. “Громкость сигналов” (Signal volume) has ten levels, with “Тише” (Quieter) and “Громче” (Louder) buttons. “Проверить звук” (Test the sound) plays a signal. Set a level that is clearly heard on the shop floor and tap “Сохранить” (Save).",
            image: { id: "setup-sound", caption: "Signal sound and volume" },
          },
        ],
      },
      {
        id: "station",
        heading: "7. Station: version, update and unpairing",
        blocks: [
          {
            kind: "step",
            title: "Check the pairing and the version",
            text: "The “Станция” (Station) tab shows “Эта станция” (This station): the station's name, the device and the host address, and “Тема цеха” (Shop-floor theme) — “Системная” (System), “Светлая” (Light) or “Тёмная” (Dark). “Версия программы” (Program version) shows the station's version; “Проверить обновление” (Check for an update) asks the host whether there is a newer version. The update comes from the host computer, without the internet; the “Обновить” (Update) button installs it. Updates are installed outside a shift.",
            image: {
              id: "setup-station",
              caption: "The “Станция” (Station) tab: pairing, theme, version and unpairing",
            },
          },
          {
            kind: "paragraph",
            text: "“Отвязать станцию” (Unpair the station) is for moving the station to another host or taking it out of service. The station forgets the host and its reference data; it can be paired again only with a new code from the office. While a shift is open, the station cannot be unpaired. Before unpairing, the station shows how many records are not yet sent to the host — records remain on disk, but will not be sent if you connect as a new device or to another host — and asks you to confirm it is you: with a badge or a personnel number and PIN.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "8. Common problems",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The host does not answer at this address",
                detail:
                  "Check the address, that the host computer is on and on the same network, and that the host's firewall lets port 45710 through.",
              },
              {
                term: "Another program answers at the address",
                detail:
                  "The address points at another computer or another program. Check the host address in the office.",
              },
              {
                term: "The code is not accepted",
                detail:
                  "The station says “Проверьте код: 10 символов” (Check the code: 10 characters) or “Код набран русскими буквами — переключите раскладку на английскую” (The code is typed in Russian letters — switch the layout to English). If the code has expired or used up its attempts, create a new one in the office.",
              },
              {
                term: "The host does not accept this device",
                detail:
                  "The device was disconnected in the office, the host database was restored from a backup, or the host changed. Tap “Подключить заново” (Pair again). To reconnect as the same device, open “Устройства” (Devices) in the office, choose “Привязать заново” (Re-pair) for this station, and use the code issued specifically for it. A device disconnected in the office cannot be recovered this way. To connect as a new device, choose “Подключить как новое устройство” (Connect as a new device) on the station and create an ordinary code with “Подключить устройство” (Connect a device); the previous device's unsent records will not be sent.",
              },
              {
                term: "The printer does not print",
                detail:
                  "Check the connection and address, the language (ZPL or TSPL) and the printer's resolution, then do a “Пробная печать” (Test print).",
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
