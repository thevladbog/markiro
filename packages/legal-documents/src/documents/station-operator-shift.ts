import type { LegalDocumentSource } from "../types.js";

export const STATION_OPERATOR_SHIFT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция: вход оператора и старт смены",
    summary:
      "Пошаговая инструкция оператора линии Маркиро Автоном: вход на станцию по бейджу или табельному номеру и PIN, выбор смены линии, создание новой смены и начало работы.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает ежедневный вход оператора на станцию Маркиро Автоном и старт смены: от бейджа до рабочего экрана, готового к сканированию. Станция работает с главным компьютером площадки — хостом — по локальной сети: от него она получает справочники, смены и номера SSCC и ему же отправляет результаты работы. Инструкция предназначена для операторов линии; подключение станции к хосту и настройка оборудования описаны в инструкции MKR-INS-04, цикл сканирования — в MKR-INS-02.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия товаров, номера смен, линии и имена на вашей станции будут другими.",
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
              "Станция включена, на экране — «Вход оператора». В шапке видны имя станции, её линия и организация, а вместо оператора — «Никто не вошёл».",
              "Индикаторы в шапке зелёные: «Связь есть» — станция на связи с хостом, «Сканер готов» — сканер подключён.",
              "У вас есть личный бейдж оператора или табельный номер и PIN. Операторов, бейджи и PIN заводит администратор в офисе, в разделе «Операторы».",
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если вместо входа станция показывает «Служба хоста не отвечает», «Подключение к хосту в сети», «Выбор линии» или «Хост не принимает это устройство» — не продолжайте, позовите наладчика или администратора: станцию нужно подключить к хосту (MKR-INS-04).",
          },
        ],
      },
      {
        id: "login",
        heading: "3. Вход на станцию",
        blocks: [
          {
            kind: "step",
            title: "Поднесите бейдж к сканеру",
            text: "На экране «Вход оператора» поднесите личный бейдж к сканеру — бейдж можно сканировать в любой момент, ничего не нажимая. Станция сама узнаёт код и сразу открывает список смен линии. Новый бейдж заработает после синхронизации станции с хостом.",
            image: { id: "login-badge", caption: "Экран «Вход оператора»: станция ждёт бейдж" },
            expected: "Открылся экран «Смены линии», в шапке — ваше имя.",
          },
          {
            kind: "step",
            title: "Или войдите по табельному номеру и PIN",
            text: "На цифровой клавиатуре справа наберите табельный номер — от 3 до 12 цифр. Нажмите поле «PIN» и наберите PIN — от 4 до 6 цифр, затем нажмите «Войти». Кнопка «Сброс» очищает поле, кнопка со стрелкой стирает последнюю цифру.",
            image: {
              id: "login-pin",
              caption: "Табельный номер и PIN набраны, кнопка «Войти» доступна",
            },
            expected: "Открылся экран «Смены линии».",
          },
          {
            kind: "step",
            title: "Если не помните табельный номер — найдите себя по имени",
            text: "Нажмите «Найти по имени» и наберите на экранной клавиатуре первые 2–3 буквы имени. Выберите себя в списке: станция подставит ваш табельный номер. Затем введите PIN и нажмите «Войти». Пока вы вводите имя, бейдж не сканируется; «Назад» возвращает к входу.",
            image: { id: "login-name-search", caption: "Поиск оператора по имени" },
          },
          {
            kind: "step",
            title: "Если PIN не подошёл",
            text: "Станция покажет «Неверный табельный номер или PIN» и очистит поле PIN. Проверьте номер и наберите PIN ещё раз. После пяти неверных PIN подряд вход по PIN для этого табельного номера приостанавливается на 5 минут — войти по бейджу при этом можно. Если на станции наберётся десять неудачных попыток входа с перерывами меньше 10 минут, вход на ней приостанавливается на минуту для всех; экран показывает отсчёт.",
            image: { id: "login-wrong-pin", caption: "Неверный PIN: поле PIN очищено" },
          },
        ],
      },
      {
        id: "shift-select",
        heading: "4. Выбор смены",
        blocks: [
          {
            kind: "paragraph",
            text: "Экран «Смены линии» показывает незакрытые смены линии этой станции: запланированные в офисе и созданные на станциях. Смены других линий здесь не видны. На карточке — статус («Не начата», «В работе», «Закрывается», «Закрыта в офисе»), номер смены, товар, дата производства, дата смены, план и сколько уже принято, режим («Агрегация» или «Проверка») и метка «Паллеты», если смена собирает паллеты.",
          },
          {
            kind: "step",
            title: "Откройте смену",
            text: "Нажмите кнопку на карточке нужной смены. «Открыть» — смену ещё не начинали; для этого нужна связь с хостом. «Продолжить» — смену уже ведёт эта станция; продолжить её можно и без связи. «Присоединиться» — смену ведёт другая станция, а линия допускает несколько; нужна связь с хостом. «Завершить» — смену закрыли в офисе: закончите на станции короб и этикетку и закройте смену. Если на карточке написано «Занята другой станцией», с этой станции смену не открыть.",
            image: {
              id: "shift-select",
              caption: "Смены линии: смена в работе и смена, которую ещё не начинали",
            },
            expected: "Открылся рабочий экран смены.",
          },
          {
            kind: "paragraph",
            text: "Кнопки внизу экрана: «Новая смена» (раздел 5), «Рабочее место» (настройка станции, MKR-INS-04) и «Очередь отправки» (записи, которые ещё не дошли до хоста, MKR-INS-02). Кнопка «Повторная печать этикеток» вверху описана в MKR-INS-03.",
          },
        ],
      },
      {
        id: "new-shift",
        heading: "5. Создание новой смены",
        blocks: [
          {
            kind: "paragraph",
            text: "Если нужной смены нет в списке, её можно создать на станции. Номер смене присваивает хост, поэтому создать смену можно только при связи с ним: без связи кнопка показывает «Нужна связь с хостом».",
          },
          {
            kind: "step",
            title: "Выберите товар",
            text: "Нажмите «Новая смена». Отсканируйте штрихкод товара или код маркировки с упаковки — или наберите в поле «Название товара» хотя бы две буквы и выберите товар в списке. Станция предлагает только товары, которые в офисе включены в работу; если товара нет, его нужно добавить в офисе (MKR-INS-10).",
            image: { id: "new-shift", caption: "Новая смена: станция ждёт товар" },
            expected: "Открылась форма смены с фотографией, названием и GTIN товара.",
          },
          {
            kind: "step",
            title: "Выберите режим, паллеты, план и даты",
            text: "«Режим работы»: «Агрегация» — продукция собирается в короба, печатаются этикетки коробов; «Проверка» — коды сверяются при сканировании, этикетки коробов не печатаются. В режиме «Агрегация» карточка «С паллетами» включена, если в карточке товара указано, сколько коробов встаёт на паллету, — под ней видно «Коробов на паллете». Выключите её, если паллеты собирать не нужно. «В коробе, шт.» берётся из товара; «План, шт.» необязателен — смена может быть без плана. Числа набирайте на клавиатуре справа, нажав нужное поле. «Дата производства» и «Дата смены» по умолчанию сегодняшние; дату производства сверьте с продукцией. Нажмите «Далее».",
            image: {
              id: "new-shift-pallets",
              caption: "Новая смена в режиме «Агрегация» со сборкой паллет",
            },
          },
          {
            kind: "step",
            title: "Проверьте шаблон этикетки короба",
            text: "На шаге «Шаблон этикетки короба» станция уже выбрала подходящий шаблон: он назван в строке над списком, а справа — предпросмотр этикетки. При необходимости выберите другой. Нажмите «Далее», а в смене без паллет — «Создать и открыть».",
            image: {
              id: "new-shift-template",
              caption: "Выбор шаблона этикетки короба с предпросмотром",
            },
          },
          {
            kind: "step",
            title: "Для смены с паллетами — шаблон этикетки паллеты",
            text: "Так же проверьте «Шаблон этикетки паллеты» и нажмите «Создать и открыть». «Предыдущий шаг» возвращает к прошлому шагу, «Другой товар» — к выбору товара.",
            image: {
              id: "new-shift-pallet-template",
              caption: "Шаблон этикетки паллеты и кнопка «Создать и открыть»",
            },
            expected: "Хост присвоил смене номер, станция открыла её рабочий экран.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Проверьте товар и дату производства до создания смены: они печатаются на этикетках коробов и паллет. Если ошиблись, сообщите мастеру или администратору офиса.",
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
            text: "Перед первым сканированием убедитесь: в шапке — ваше имя и номер смены; на ленте смены — нужный товар, его GTIN и режим; «Принято в смене» — ноль или то, что уже сделано в смене. В открытом коробе написано «Короб откроется с первым кодом», в «Последний скан» — «Ожидание». Индикаторы связи, принтера, сканера и очереди на рабочем экране свёрнуты в значки; при проблеме значок раскрывается подписью.",
            image: {
              id: "work-start",
              caption: "Рабочий экран: смена открыта, станция ждёт первый код",
            },
            expected:
              "Станция готова: отсканируйте первый код маркировки — результат появится в «Последний скан».",
          },
          {
            kind: "paragraph",
            text: "Если работу продолжает другой оператор, нажмите «Сменить оператора»: смена останется открытой, а все записанные операции сохранятся на станции. Новый оператор входит так же, как в разделе 3.",
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
                term: "Бейдж не найден",
                detail:
                  "Если бейдж новый, дождитесь синхронизации станции с хостом или обратитесь к администратору. Пока можно войти по табельному номеру и PIN.",
              },
              {
                term: "Сканер прочитал не бейдж",
                detail:
                  "Станция пишет «Это код товара, а не бейдж» или «Это не похоже на бейдж». Приложите к сканеру именно бейдж.",
              },
              {
                term: "Сканер набирает в русской раскладке",
                detail:
                  "Переключите раскладку клавиатуры станции на английскую и приложите бейдж ещё раз.",
              },
              {
                term: "Вход по PIN приостановлен",
                detail:
                  "Дождитесь окончания отсчёта или войдите по бейджу. Если PIN забыт, его меняет администратор в офисе.",
              },
              {
                term: "Справочники ещё не загружены с хоста",
                detail:
                  "Станция ещё не получила список операторов, товаров и смен. Проверьте индикатор связи; если связи нет, позовите наладчика.",
              },
              {
                term: "Нужной смены нет в списке",
                detail:
                  "Список показывает только смены линии этой станции. Создайте смену (раздел 5) или уточните у мастера, на какой линии она запланирована.",
              },
              {
                term: "Нет карточки «С паллетами» в форме смены",
                detail:
                  "В карточке товара не указано, сколько коробов встаёт на паллету, или для товара нет подходящего шаблона этикетки паллеты. Попросите администратора исправить это в офисе (MKR-INS-10), затем создайте смену заново.",
              },
              {
                term: "Новые смены не открываются",
                detail:
                  "Станция объясняет причину: закончился пробный период, истекла лицензия площадки или ИНН организации не совпадает с лицензией. Сообщите администратору. Смену, которую станция уже ведёт, можно продолжить.",
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
    title: "Station: operator sign-in and shift start",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Step-by-step guide for Markiro Autonom line operators: signing in at the station with a badge or a personnel number and PIN, choosing a shift of the line, creating a new shift and starting work.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the operator's daily sign-in at a Markiro Autonom station and the shift start: from the badge to a work screen that is ready to scan. The station works with the site's main computer — the host — over the local network: it gets reference data, shifts and SSCC numbers from the host and sends the results of its work back to it. The instruction is intended for line operators; pairing the station with the host and setting up hardware are covered in MKR-INS-04, the scanning cycle in MKR-INS-02.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The station interface is in Russian only. Screen labels are quoted in Russian, with an English translation in brackets. The screenshots use demo data: product names, shift numbers, lines and names on your station will differ.",
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
              "The station is on and shows “Вход оператора” (Operator sign-in). The header shows the station's name, its line and the organization, and “Никто не вошёл” (Nobody signed in) in place of an operator.",
              "The header indicators are green: “Связь есть” (Connected) — the station reaches the host; “Сканер готов” (Scanner ready) — the scanner is connected.",
              "You have your personal operator badge, or a personnel number and a PIN. Operators, badges and PINs are set up by an administrator in the office, under “Операторы” (Operators).",
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If instead of the sign-in the station shows “Служба хоста не отвечает” (The host service is not responding), “Подключение к хосту в сети” (Connecting to the host on the network), “Выбор линии” (Line selection) or “Хост не принимает это устройство” (The host does not accept this device), do not continue — call a technician or an administrator: the station has to be paired with the host (MKR-INS-04).",
          },
        ],
      },
      {
        id: "login",
        heading: "3. Signing in",
        blocks: [
          {
            kind: "step",
            title: "Hold your badge up to the scanner",
            text: "On the “Вход оператора” (Operator sign-in) screen, hold your personal badge up to the scanner — a badge can be scanned at any moment without pressing anything. The station recognizes the code itself and opens the line's shifts at once. A new badge starts working after the station syncs with the host.",
            image: {
              id: "login-badge",
              caption:
                "The “Вход оператора” (Operator sign-in) screen: the station waits for a badge",
            },
            expected:
              "The “Смены линии” (Line shifts) screen opened, with your name in the header.",
          },
          {
            kind: "step",
            title: "Or sign in with your personnel number and PIN",
            text: "On the keypad on the right, type your personnel number — 3 to 12 digits. Tap the “PIN” field and type your PIN — 4 to 6 digits, then tap “Войти” (Sign in). “Сброс” (Reset) clears the field; the arrow key erases the last digit.",
            image: {
              id: "login-pin",
              caption: "Personnel number and PIN typed, “Войти” (Sign in) is available",
            },
            expected: "The “Смены линии” (Line shifts) screen opened.",
          },
          {
            kind: "step",
            title: "If you do not remember your personnel number, find yourself by name",
            text: "Tap “Найти по имени” (Find by name) and type the first 2–3 letters of your name on the on-screen keyboard. Pick yourself in the list: the station fills in your personnel number. Then enter your PIN and tap “Войти” (Sign in). While you type a name, badges are not scanned; “Назад” (Back) returns to the sign-in.",
            image: { id: "login-name-search", caption: "Finding an operator by name" },
          },
          {
            kind: "step",
            title: "If the PIN is not accepted",
            text: "The station shows “Неверный табельный номер или PIN” (Wrong personnel number or PIN) and clears the PIN field. Check the number and type the PIN again. After five wrong PINs in a row, signing in with a PIN for that personnel number is paused for 5 minutes — signing in with a badge still works. When the station collects ten failed sign-in attempts less than 10 minutes apart, signing in on it is paused for a minute for everyone; the screen shows a countdown.",
            image: { id: "login-wrong-pin", caption: "Wrong PIN: the PIN field is cleared" },
          },
        ],
      },
      {
        id: "shift-select",
        heading: "4. Choosing a shift",
        blocks: [
          {
            kind: "paragraph",
            text: "The “Смены линии” (Line shifts) screen shows the shifts of this station's line that are not closed: those planned in the office and those created on stations. Shifts of other lines are not shown. A card shows the status (“Не начата” — Not started, “В работе” — In progress, “Закрывается” — Closing, “Закрыта в офисе” — Closed in the office), the shift number, the product, the production date, the shift date, the plan and how much has been accepted, the mode (“Агрегация” — Aggregation, or “Проверка” — Validation) and a “Паллеты” (Pallets) tag when the shift builds pallets.",
          },
          {
            kind: "step",
            title: "Open the shift",
            text: "Tap the button on the card of the shift you need. “Открыть” (Open) — the shift has not been started; this needs a connection to the host. “Продолжить” (Continue) — this station already runs the shift; it can be continued without a connection. “Присоединиться” (Join) — another station runs the shift and the line allows several; this needs a connection to the host. “Завершить” (Finish) — the shift was closed in the office: finish the box and the label on the station and close the shift. If the card says “Занята другой станцией” (Taken by another station), the shift cannot be opened from this station.",
            image: {
              id: "shift-select",
              caption: "Line shifts: a shift in progress and a shift not yet started",
            },
            expected: "The shift's work screen opened.",
          },
          {
            kind: "paragraph",
            text: "The buttons at the bottom of the screen: “Новая смена” (New shift, section 5), “Рабочее место” (Workstation, the station's setup, MKR-INS-04) and “Очередь отправки” (Send queue: records not yet delivered to the host, MKR-INS-02). The “Повторная печать этикеток” (Label reprint) button at the top is covered in MKR-INS-03.",
          },
        ],
      },
      {
        id: "new-shift",
        heading: "5. Creating a new shift",
        blocks: [
          {
            kind: "paragraph",
            text: "If the shift you need is not in the list, it can be created on the station. The host gives the shift its number, so a shift can only be created while the station reaches the host: without a connection the button reads “Нужна связь с хостом” (A connection to the host is needed).",
          },
          {
            kind: "step",
            title: "Choose the product",
            text: "Tap “Новая смена” (New shift). Scan the product barcode or a marking code from the packaging — or type at least two letters into “Название товара” (Product name) and pick the product in the list. The station offers only products the office has put into use; if the product is missing, it has to be added in the office (MKR-INS-10).",
            image: { id: "new-shift", caption: "New shift: the station waits for a product" },
            expected: "The shift form opened with the product's photo, name and GTIN.",
          },
          {
            kind: "step",
            title: "Choose the mode, pallets, plan and dates",
            text: "“Режим работы” (Mode): “Агрегация” (Aggregation) — products are packed into boxes and box labels are printed; “Проверка” (Validation) — codes are checked as they are scanned and no box labels are printed. In “Агрегация” (Aggregation) the “С паллетами” (With pallets) card is on when the product card says how many boxes go on a pallet — the number shows below it as “Коробов на паллете” (Boxes per pallet). Turn it off if pallets are not needed. “В коробе, шт.” (Per box, pcs) comes from the product; “План, шт.” (Plan, pcs) is optional — a shift may have no plan. Type numbers on the keypad on the right after tapping the field. “Дата производства” (Production date) and “Дата смены” (Shift date) default to today; check the production date against the product. Tap “Далее” (Next).",
            image: {
              id: "new-shift-pallets",
              caption: "A new shift in “Агрегация” (Aggregation) mode with pallet assembly",
            },
          },
          {
            kind: "step",
            title: "Check the box label template",
            text: "At the “Шаблон этикетки короба” (Box label template) step the station has already chosen a fitting template: it is named in the line above the list, with a preview of the label on the right. Pick another one if needed. Tap “Далее” (Next), or “Создать и открыть” (Create and open) on a shift without pallets.",
            image: {
              id: "new-shift-template",
              caption: "Choosing the box label template with a preview",
            },
          },
          {
            kind: "step",
            title: "For a shift with pallets, the pallet label template",
            text: "Check the “Шаблон этикетки паллеты” (Pallet label template) the same way and tap “Создать и открыть” (Create and open). “Предыдущий шаг” (Previous step) returns to the previous step, “Другой товар” (Another product) to the choice of product.",
            image: {
              id: "new-shift-pallet-template",
              caption: "The pallet label template and “Создать и открыть” (Create and open)",
            },
            expected: "The host numbered the shift and the station opened its work screen.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Check the product and the production date before creating the shift: they are printed on box and pallet labels. If you made a mistake, tell your supervisor or an office administrator.",
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
            text: "Before the first scan make sure: the header shows your name and the shift number; the shift band shows the right product, its GTIN and the mode; “Принято в смене” (Accepted in shift) is zero or matches the work already done in the shift. The open box reads “Короб откроется с первым кодом” (The box opens with the first code), and “Последний скан” (Last scan) reads “Ожидание” (Waiting). On the work screen the connection, printer, scanner and queue indicators are collapsed into icons; a problem expands its icon into a caption.",
            image: {
              id: "work-start",
              caption: "Work screen: the shift is open, the station waits for the first code",
            },
            expected:
              "The station is ready: scan the first marking code — the result appears under “Последний скан” (Last scan).",
          },
          {
            kind: "paragraph",
            text: "If another operator takes over, tap “Сменить оператора” (Change operator): the shift stays open and every recorded operation stays on the station. The new operator signs in as in section 3.",
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
                term: "The badge is not found",
                detail:
                  "The station says “Бейдж не найден” (Badge not found). If the badge is new, wait for the station to sync with the host or contact an administrator. Meanwhile you can sign in with your personnel number and PIN.",
              },
              {
                term: "The scanner read something other than a badge",
                detail:
                  "The station says “Это код товара, а не бейдж” (This is a product code, not a badge) or “Это не похоже на бейдж” (This does not look like a badge). Hold the badge itself up to the scanner.",
              },
              {
                term: "The scanner types in the Russian layout",
                detail:
                  "The station says “Сканер набирает в русской раскладке”. Switch the station's keyboard layout to English and scan the badge again.",
              },
              {
                term: "Signing in with a PIN is paused",
                detail:
                  "Wait for the countdown to end or sign in with your badge. If the PIN is forgotten, an administrator changes it in the office.",
              },
              {
                term: "Reference data is not yet loaded from the host",
                detail:
                  "The station says “Справочники ещё не загружены с хоста”: it has not yet received the lists of operators, products and shifts. Check the connection indicator; if there is no connection, call a technician.",
              },
              {
                term: "The shift you need is not in the list",
                detail:
                  "The list shows only the shifts of this station's line. Create the shift (section 5) or ask your supervisor which line it is planned on.",
              },
              {
                term: "The shift form has no “С паллетами” (With pallets) card",
                detail:
                  "The product card does not say how many boxes go on a pallet, or the product has no fitting pallet label template. Ask an administrator to fix this in the office (MKR-INS-10), then create the shift again.",
              },
              {
                term: "New shifts do not open",
                detail:
                  "The station explains why: the trial period has ended, the site's license has expired, or the organization's INN does not match the license. Tell an administrator. A shift the station already runs can be continued.",
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
