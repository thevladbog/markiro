import type { LegalDocumentSource } from "../types.js";

export const HANDHELD_WAREHOUSE_CONTENT = {
  ru: {
    locale: "ru",
    title: "ТСД: подключение и работа на складе",
    summary:
      "Пошаговая инструкция для склада Маркиро Автоном: привязка ТСД к хосту по коду из офиса, вход оператора, принтер этикеток, сборка паллеты из коробов, печать этикетки паллеты и работа без связи с хостом.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает складской режим «Паллеты» на ТСД (терминале сбора данных) в Маркиро Автоном. Оператор сканирует SSCC готовых коробов, ТСД закрывает паллету и печатает её этикетку на назначенный принтер. Работа ТСД в производственной смене в эту инструкцию не входит. Работа на станции линии описана в MKR-INS-01–03.",
          },
          {
            kind: "paragraph",
            text: "ТСД работает с хостом — главным компьютером площадки — по локальной сети. Связь с интернетом не нужна. Пока хост недоступен, ТСД продолжает работу и отправляет накопленное, когда связь вернётся.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Адреса, коды, отпечаток хоста и номера SSCC на вашей площадке будут другими.",
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
              "Хост установлен и запущен, ТСД подключён к той же сети Wi-Fi, что и компьютер хоста.",
              "У компьютера хоста постоянный адрес в сети: ТСД запоминает адрес при привязке. Как зарезервировать адрес, описано в инструкции по установке хоста.",
              "Сеть Wi-Fi на компьютере хоста отмечена как частная, а на точке доступа выключена изоляция клиентов: иначе ТСД не видит хост, хотя оба в сети.",
              "Часы ТСД и компьютера хоста совпадают с точностью до двух минут.",
              "Есть доступ к офису Маркиро Автоном с правами администратора: код привязки создаётся в разделе «Устройства».",
              "Принтер этикеток доступен по сети Wi-Fi или по Bluetooth, известны его адрес, язык (ZPL или TSPL) и разрешение.",
            ],
          },
        ],
      },
      {
        id: "pairing",
        heading: "3. Привязка ТСД к хосту",
        blocks: [
          {
            kind: "step",
            title: "3.1. Создайте код в офисе",
            text: "В офисе откройте раздел «Устройства» и нажмите «Подключить устройство». Офис покажет штрих-код привязки, «Код подключения» из 10 символов, отпечаток и адрес хоста. Код одноразовый; оставшееся время показано под ним, «Новый код» выпускает другой.",
            image: { id: "office-pairing-code", caption: "Офис: код привязки нового устройства" },
          },
          {
            kind: "step",
            title: "3.2. Выберите сервер на площадке",
            text: "Запустите приложение на ТСД. На экране «Куда привязать ТСД» нажмите «Сервер на площадке (Автоном)».",
            image: { id: "pairing-source", caption: "ТСД: выбор, куда привязать устройство" },
          },
          {
            kind: "step",
            title: "3.3. Отсканируйте штрих-код или введите адрес и код",
            text: "Проще всего нажать триггер и навести ТСД на штрих-код привязки на экране офиса. Иначе введите «Адрес сервера» — адрес хоста из офиса без порта, например 192.168.1.10, — и «Код привязки», затем нажмите «Продолжить».",
            image: {
              id: "pairing-form",
              caption: "ТСД: адрес хоста и код привязки, введённые вручную",
            },
          },
          {
            kind: "step",
            title: "3.4. Сверьте отпечаток",
            text: "После ввода вручную ТСД покажет экран «Сверьте отпечаток» с отпечатком хоста по этому адресу. Сравните его с отпечатком на экране офиса: код уйдёт на хост, только если они совпадают. Нажмите «Совпадает»; если отпечаток другой — «Не совпадает» и проверьте адрес. При скане штрих-кода ТСД сверяет отпечаток сам.",
            image: { id: "pairing-fingerprint", caption: "ТСД: сверка отпечатка хоста" },
          },
          {
            kind: "step",
            title: "3.5. Дождитесь привязки",
            text: "ТСД загрузит справочники с хоста и покажет «ТСД привязан». Нажмите «Перейти ко входу».",
            image: { id: "pairing-done", caption: "ТСД привязан к хосту" },
          },
          {
            kind: "step",
            title: "3.6. Проверьте устройство в офисе",
            text: "В офисе появится сообщение «Устройство «ТСД» подключено.», а в списке «Устройства» — строка с видом «ТСД». Имя устройства можно изменить кнопкой с карандашом в строке.",
            image: { id: "office-devices", caption: "Офис: ТСД в списке устройств" },
          },
          {
            kind: "step",
            title: "3.7. При необходимости назначьте линию",
            text: "Если ТСД будет работать в производственной смене, администратор нажимает карандаш в строке ТСД, выбирает «Линия» и сохраняет изменение. ТСД получит линию при связи с хостом; плитка «Смена» покажет запланированные и активные смены этой линии. Для складского режима «Паллеты» линия не нужна. Если поля «Линия» нет, обновите приложение на ПК офиса до версии с назначением линии ТСД.",
            image: {
              id: "office-handheld-line",
              caption: "Офис: назначение линии ТСД",
            },
          },
          {
            kind: "table",
            caption: "Если привязка не прошла",
            columns: ["Сообщение на ТСД", "Что сделать"],
            columnRatios: [2, 3],
            rows: [
              [
                "«Срок кода истёк. Выпустите новый код в офисе.»",
                "В офисе нажмите «Новый код» и повторите привязку.",
              ],
              [
                "«Код не подошёл. Выпустите новый код в офисе.»",
                "Проверьте код по экрану офиса или выпустите новый.",
              ],
              [
                "«Сервер не отвечает…»",
                "Проверьте Wi-Fi на ТСД, адрес хоста, профиль сети и изоляцию клиентов на точке доступа.",
              ],
              [
                "«В лицензии нет свободных мест для ТСД.»",
                "Число ТСД задаёт лицензия; обратитесь к администратору.",
              ],
              ["«Работа с ТСД не включена в офисе.»", "Обратитесь к администратору."],
            ],
          },
        ],
      },
      {
        id: "sign-in",
        heading: "4. Вход оператора",
        blocks: [
          {
            kind: "step",
            title: "Войдите по бейджу или табельному номеру",
            text: "На экране входа отсканируйте бейдж или введите «Табельный №» на клавиатуре экрана и PIN. Если номер не помните, нажмите «Найти по имени». Список операторов хранится на ТСД, поэтому вход работает и без связи с хостом; строка вверху показывает, сколько операторов в списке и когда он обновлён, «Обновить список» загружает его заново.",
            image: { id: "sign-in", caption: "ТСД: вход оператора" },
          },
          {
            kind: "step",
            title: "Главный экран",
            text: "После входа ТСД показывает главный экран. В строке состояния — связь с хостом («Хост на связи»), «Очередь» неотправленных записей, принтер и сканер. Плитки: «Смена», «Паллеты» и «Настройки». Кнопка выхода справа от имени завершает работу оператора.",
            image: { id: "hub", caption: "ТСД: главный экран без назначенной линии" },
          },
        ],
      },
      {
        id: "printer",
        heading: "5. Принтер этикеток",
        blocks: [
          {
            kind: "step",
            title: "Добавьте принтер",
            text: "Откройте «Настройки» → «Принтер» и нажмите «Добавить по адресу». Задайте «Название принтера», выберите «По сети (Wi-Fi)» или «Bluetooth», для сети — «IP-адрес» и «Порт» (обычно 9100). Выберите «Язык принтера»: ZPL — принтеры Zebra, TSPL — принтеры TSC, и «Плотность» — 203 или 300 dpi, как у принтера. Нажмите «Проверить связь»: принтер сохранится на ТСД.",
            image: { id: "printer-add", caption: "ТСД: новый сетевой принтер" },
          },
          {
            kind: "step",
            title: "Назначьте принтер",
            text: "На экране «Принтеры» нажмите «Назначения» и для каждого вида этикетки — «Короб», «Дубль кода», «Паллета» — нажмите «Выбрать принтер». Для склада обязательно назначение «Паллета». Пока у вида нет принтера, плитка «Настройки» на главном экране пишет, что не назначено.",
            image: {
              id: "printer-assignments",
              caption: "ТСД: назначение принтера по видам этикеток",
            },
          },
        ],
      },
      {
        id: "pallets",
        heading: "6. Сборка паллеты",
        blocks: [
          {
            kind: "step",
            title: "Откройте сборку паллеты",
            text: "На главном экране нажмите «Паллеты». ТСД ждёт первый короб: «Отсканируйте короб». Первый короб задаёт товар паллеты. Строка «данные на …» показывает, когда ТСД последний раз загрузил с хоста реестр коробов; «Обновить реестр» вверху экрана загружает его заново.",
            image: { id: "pallet-empty", caption: "ТСД: новая паллета ждёт первый короб" },
          },
          {
            kind: "step",
            title: "Сканируйте SSCC коробов",
            text: "Сканируйте этикетки коробов по одной. Принятый короб появляется в списке, вверху — «Принят» и последние цифры SSCC, над списком — сколько коробов на паллете из её ёмкости в карточке товара. Каждый короб сначала «в очереди», затем «принят» хостом. Короб, положенный по ошибке, снимают с паллеты кнопкой с крестиком в его строке.",
            image: { id: "pallet-boxes", caption: "ТСД: три короба на паллете" },
          },
          {
            kind: "step",
            title: "Если короб не принят",
            text: "Когда скан не подходит, ТСД сообщает причину красной строкой вверху и не кладёт короб на паллету. Самые частые сообщения — в таблице ниже.",
            image: {
              id: "pallet-verdict",
              caption: "ТСД: отсканирован код единицы вместо SSCC короба",
            },
          },
          {
            kind: "table",
            caption: "Сообщения при скане короба",
            columns: ["Сообщение", "Что сделать"],
            columnRatios: [2, 3],
            rows: [
              ["«Уже на этой паллете …»", "Ничего: короб уже в списке."],
              [
                "«Уже на паллете …», «Уже на открытой паллете другого устройства»",
                "Короб числится на другой паллете. Отложите его и сообщите старшему.",
              ],
              [
                "«Уже на другой паллете этого ТСД»",
                "Короб на другой паллете этого ТСД. Отложите его и сообщите старшему.",
              ],
              ["«Другой товар: …»", "На паллету идут коробы одного товара. Отложите короб."],
              [
                "«Короб неизвестен. Обновите реестр»",
                "Нажмите «Обновить реестр» и отсканируйте короб ещё раз.",
              ],
              [
                "«Это код единицы, нужен SSCC короба»",
                "Сканируйте этикетку короба, а не код на единице товара.",
              ],
              [
                "«Это паллета, не короб»",
                "Отсканирована этикетка паллеты. Сканируйте этикетку короба.",
              ],
            ],
          },
          {
            kind: "step",
            title: "Закройте паллету",
            text: "Когда число коробов дойдёт до ёмкости паллеты, ТСД закроет её сам. Чтобы закрыть раньше, нажмите «Закрыть паллету досрочно» и подтвердите «Закрыть паллету».",
            image: { id: "pallet-close-confirm", caption: "ТСД: досрочное закрытие паллеты" },
          },
          {
            kind: "step",
            title: "Наклейте этикетку паллеты",
            text: "После закрытия ТСД печатает этикетку паллеты на принтер, назначенный для «Паллета»: экран «Паллета закрыта» показывает SSCC паллеты, число коробов и «Напечатано». Наклейте этикетку на паллету. Затем ТСД снова ждёт первый короб следующей паллеты.",
            image: { id: "pallet-printed", caption: "ТСД: паллета закрыта, этикетка напечатана" },
          },
          {
            kind: "step",
            title: "Если этикетка не напечаталась",
            text: "При ошибке печати ТСД пишет «Этикетка не напечатана» и причину. Устраните её и нажмите «Повторить» или выберите «Другой принтер». «Отложить этикетку» оставляет этикетку на потом: на главном экране появится строка о ненапечатанных этикетках, по ней открывается список с кнопкой «Напечатать все». Если ТСД пишет «Результат печати неизвестен», посмотрите на принтер: если этикетка вышла, нажмите «Этикетка напечаталась», иначе — «Напечатать ещё раз».",
            image: { id: "pallet-print-failed", caption: "ТСД: принтер не отвечает" },
          },
          {
            kind: "paragraph",
            text: "Над результатом закрытия показано имя принтера, записанного для этой паллеты. В прежних версиях здесь могло стоять «Не назначен» даже при настроенной печати; имя также может отсутствовать в старых данных паллеты. Проверьте назначение «Паллета» в настройках и фактическую этикетку на принтере.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если хост не принял короб, на экране «Паллеты» появится «Снимите с паллеты N короба» со списком коробов и причиной. Снимите эти коробы с паллеты и нажмите «Принято»; если паллета уже закрыта и маркирована, нажмите «Перепечатать этикетку» и замените этикетку.",
          },
        ],
      },
      {
        id: "warehouse-disassembly",
        heading: "7. Расформирование складской паллеты",
        blocks: [
          {
            kind: "callout",
            tone: "warning",
            text: "Выполняйте этот порядок только после согласованного обновления ТСД и хоста: передача расформирования требует, чтобы хост поддерживал протокол 8 или выше. Совместимость проверьте с администратором. До обновления локальное расформирование может не передаваться хосту и не освобождать короба в его учёте.",
          },
          {
            kind: "paragraph",
            text: "Порядок относится только к своей закрытой складской паллете, собранной на этом ТСД. Перед операцией убедитесь с администратором, что её закрытие уже подтверждено хостом. Расформирование паллет производственной смены, исключения коробов и исключения перепечатки паллет этим порядком не охватываются: ТСД пока не передаёт их хосту.",
          },
          {
            kind: "step",
            title: "Отсканируйте паллету",
            text: "Откройте «Паллеты» и нажмите значок слоёв «Расформировать паллету» в верхней панели. Отсканируйте этикетку своей закрытой складской паллеты. Даже если экран предлагает паллету производственной смены, не используйте для неё этот порядок.",
            image: {
              id: "pallet-disassemble-scan",
              caption: "ТСД: сканирование паллеты для расформирования",
            },
          },
          {
            kind: "step",
            title: "Выберите причину",
            text: "На экране «Почему расформировываем?» выберите подходящую причину из списка. Над ним показаны последние цифры SSCC паллеты и число коробов.",
            image: {
              id: "pallet-disassemble-reason",
              caption: "ТСД: причина расформирования складской паллеты",
            },
          },
          {
            kind: "step",
            title: "Подтвердите и проверьте приём хостом",
            text: "Сверьте последние цифры SSCC и число коробов и подтвердите расформирование. После сообщения «Паллета расформирована» снимите старую этикетку. Это сообщение подтверждает локальную операцию: хост освобождает короба после приёма записи. Дождитесь связи с хостом и проверьте приём с администратором; пустая очередь сразу после операции ещё не доказывает приём. При отклонении в «Очереди хоста» передайте запись администратору. На других ТСД затем нажмите «Обновить реестр», прежде чем собирать новую паллету из этих коробов.",
            image: {
              id: "pallet-disassemble-confirm",
              caption: "ТСД: подтверждение SSCC и числа коробов",
            },
          },
        ],
      },
      {
        id: "offline",
        heading: "8. Работа без связи с хостом",
        blocks: [
          {
            kind: "step",
            title: "Продолжайте работу",
            text: "Без связи ТСД показывает «Нет связи с хостом — работа продолжается». Доступны только короба из ранее загруженного реестра; для закрытия паллет нужны оставшиеся номера SSCC. Если номера закончились, подключитесь к хосту: паллета остаётся открытой. В этих пределах сборка паллеты и печать этикеток продолжаются: записи копятся на ТСД, строка «Очередь хоста» показывает, сколько ждут отправки. На плитке «Паллеты» видно, сколько коробов не отправлено.",
            image: { id: "hub-offline", caption: "ТСД без связи с хостом" },
          },
          {
            kind: "step",
            title: "Проверьте очередь",
            text: "Нажмите строку «Очередь хоста»: экран «Очередь хоста» перечисляет записи, которые «Ждут отправки», и записи, «Отклонено хостом». Когда связь вернётся, ТСД отправит очередь сам; «Отправить сейчас» отправляет её без ожидания. Если хост отклонил запись, нажмите «Передать в поддержку» и сообщите администратору.",
            image: { id: "host-queue", caption: "ТСД: очередь записей для хоста" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Не удаляйте приложение и не сбрасывайте ТСД, пока очередь не пуста: неотправленные записи хранятся только на этом ТСД.",
          },
        ],
      },
      {
        id: "faq",
        heading: "9. Частые вопросы",
        blocks: [
          {
            kind: "table",
            caption: "Частые вопросы",
            columns: ["Что видно", "Что сделать"],
            columnRatios: [2, 3],
            rows: [
              [
                "В плитке «Смена» написано «смен нет»",
                "Проверьте, назначена ли ТСД линия и есть ли на ней запланированные или активные смены. Администратор выбирает «Линия» в окне ТСД в разделе «Устройства» и сохраняет изменение; ТСД получит её при связи с хостом (шаг 3.7). Если поля нет, сначала обновите приложение на ПК офиса. Складской режим «Паллеты» работает и без назначенной линии.",
              ],
              [
                "«Справочник ещё не загружен» в «Паллеты»",
                "ТСД ещё не получил с хоста товары и шаблоны. Вернитесь на главный экран и откройте «Паллеты» снова, когда ТСД на связи с хостом.",
              ],
              [
                "«Сертификат хоста изменился — нажмите, чтобы привязать ТСД заново»",
                "Хост предъявляет другой сертификат. В офисе в разделе «Устройства» нажмите «Привязать заново» в строке этого ТСД, на ТСД нажмите сообщение и введите новый код. Данные и очередь на ТСД сохраняются.",
              ],
              [
                "«Часы устройства расходятся с хостом — проверьте время на ТСД»",
                "Выставьте на ТСД то же время и часовой пояс, что на компьютере хоста.",
              ],
              [
                "«Хост восстанавливается из копии — работа продолжается»",
                "Администратор восстанавливает хост из резервной копии. Продолжайте работу: очередь уйдёт на хост после восстановления.",
              ],
            ],
          },
          {
            kind: "paragraph",
            text: "Если вопрос не решается, сообщите администратору площадки: офис показывает ТСД, его версию и связь с хостом в разделе «Устройства».",
          },
        ],
      },
    ],
  },
  en: {
    locale: "en",
    title: "Handheld: pairing and warehouse work",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Step-by-step warehouse instruction for Markiro Autonom: pairing a handheld terminal with the host by a code from the office, operator sign-in, the label printer, building a pallet from boxes, printing the pallet label, and working without a link to the host.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the warehouse «Паллеты» (Pallets) mode on the handheld terminal (ТСД) in Markiro Autonom. The operator scans finished boxes' SSCC labels; the handheld closes the pallet and prints its label on the assigned printer. Production-shift work on the handheld is outside this instruction's scope. Line-station work is covered in MKR-INS-01–03.",
          },
          {
            kind: "paragraph",
            text: "The handheld works with the host, the site's main computer, over the local network. No internet connection is needed. While the host is unavailable, the handheld keeps working and sends what it has collected once the link returns.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The Markiro Autonom interface is in Russian only, so the screenshots are Russian and screen labels are quoted in Russian with an English translation in brackets. The screenshots use demonstration data; addresses, codes, the host fingerprint and SSCC numbers on your site will differ.",
          },
        ],
      },
      {
        id: "preparation",
        heading: "2. Preparation",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "The host is installed and running, and the handheld is on the same Wi-Fi network as the host computer.",
              "The host computer has a permanent network address: the handheld remembers the address when it is paired. Reserving an address is described in the host installation instruction.",
              "On the host computer the Wi-Fi network is marked as private, and client isolation is off on the access point; otherwise the handheld cannot see the host although both are on the network.",
              "The clocks of the handheld and the host computer agree within two minutes.",
              "You have access to the Markiro Autonom office as an administrator: the pairing code is created in «Устройства» (Devices).",
              "The label printer is reachable over Wi-Fi or Bluetooth, and you know its address, language (ZPL or TSPL) and resolution.",
            ],
          },
        ],
      },
      {
        id: "pairing",
        heading: "3. Pairing the handheld with the host",
        blocks: [
          {
            kind: "step",
            title: "3.1. Create a code in the office",
            text: "In the office open «Устройства» (Devices) and press «Подключить устройство» (Connect a device). The office shows the pairing barcode, the 10-character «Код подключения» (Pairing code), and the host's fingerprint and address. The code is single-use; the time left is shown under it, and «Новый код» (New code) issues another one.",
            image: {
              id: "office-pairing-code",
              caption: "Office: the pairing code for a new device",
            },
          },
          {
            kind: "step",
            title: "3.2. Choose the on-site server",
            text: "Start the app on the handheld. On «Куда привязать ТСД» (Where to pair the handheld) press «Сервер на площадке (Автоном)» (On-site server (Autonom)).",
            image: { id: "pairing-source", caption: "Handheld: choosing where to pair the device" },
          },
          {
            kind: "step",
            title: "3.3. Scan the barcode or type the address and code",
            text: "The simplest way is to press the trigger and aim the handheld at the pairing barcode on the office screen. Otherwise type «Адрес сервера» (Server address), the host address from the office without the port, for example 192.168.1.10, and «Код привязки» (Pairing code), then press «Продолжить» (Continue).",
            image: {
              id: "pairing-form",
              caption: "Handheld: the host address and pairing code typed by hand",
            },
          },
          {
            kind: "step",
            title: "3.4. Compare the fingerprint",
            text: "After manual entry the handheld shows «Сверьте отпечаток» (Compare the fingerprint) with the fingerprint of the host at that address. Compare it with the fingerprint on the office screen: the code is sent to the host only if they match. Press «Совпадает» (Matches); if the fingerprint differs, press «Не совпадает» (Does not match) and check the address. When the barcode is scanned, the handheld checks the fingerprint itself.",
            image: {
              id: "pairing-fingerprint",
              caption: "Handheld: comparing the host fingerprint",
            },
          },
          {
            kind: "step",
            title: "3.5. Wait for pairing to finish",
            text: "The handheld loads the reference data from the host and shows «ТСД привязан» (Handheld paired). Press «Перейти ко входу» (Go to sign-in).",
            image: { id: "pairing-done", caption: "The handheld is paired with the host" },
          },
          {
            kind: "step",
            title: "3.6. Check the device in the office",
            text: "The office shows «Устройство «ТСД» подключено.» (Device “ТСД” connected.), and the «Устройства» (Devices) list gets a row of kind «ТСД» (Handheld). The device name can be changed with the pencil button in its row.",
            image: { id: "office-devices", caption: "Office: the handheld in the device list" },
          },
          {
            kind: "step",
            title: "3.7. Assign a line if needed",
            text: "If the handheld will work in a production shift, the administrator presses the pencil in its device row, chooses «Линия» (Line), and saves the change. The handheld receives the line when connected to the host; the «Смена» (Shift) tile lists that line's planned and active shifts. The warehouse «Паллеты» (Pallets) mode needs no line. If the «Линия» field is absent, update the office PC application to a version that supports handheld line assignment.",
            image: {
              id: "office-handheld-line",
              caption: "Office: assigning the handheld's line",
            },
          },
          {
            kind: "table",
            caption: "If pairing fails",
            columns: ["Message on the handheld", "What to do"],
            columnRatios: [2, 3],
            rows: [
              [
                "«Срок кода истёк. Выпустите новый код в офисе.» (The code has expired. Issue a new code in the office.)",
                "In the office press «Новый код» (New code) and pair again.",
              ],
              [
                "«Код не подошёл. Выпустите новый код в офисе.» (The code did not match. Issue a new code in the office.)",
                "Check the code against the office screen or issue a new one.",
              ],
              [
                "«Сервер не отвечает…» (The server does not respond…)",
                "Check Wi-Fi on the handheld, the host address, the network profile and client isolation on the access point.",
              ],
              [
                "«В лицензии нет свободных мест для ТСД.» (The licence has no free handheld seats.)",
                "The licence sets the number of handhelds; contact the administrator.",
              ],
              [
                "«Работа с ТСД не включена в офисе.» (Handheld work is not enabled in the office.)",
                "Contact the administrator.",
              ],
            ],
          },
        ],
      },
      {
        id: "sign-in",
        heading: "4. Operator sign-in",
        blocks: [
          {
            kind: "step",
            title: "Sign in with a badge or personnel number",
            text: "On the sign-in screen scan your badge, or type «Табельный №» (Personnel No.) on the on-screen keypad and then your PIN. If you do not remember the number, press «Найти по имени» (Find by name). The operator list is stored on the handheld, so sign-in also works without a link to the host; the line at the top shows how many operators are in the list and when it was updated, and «Обновить список» (Refresh list) loads it again.",
            image: { id: "sign-in", caption: "Handheld: operator sign-in" },
          },
          {
            kind: "step",
            title: "The main screen",
            text: "After sign-in the handheld shows its main screen. The status line shows the link to the host («Хост на связи», Host online), the «Очередь» (Queue) of unsent records, the printer and the scanner. The tiles are «Смена» (Shift), «Паллеты» (Pallets) and «Настройки» (Settings). The exit button to the right of the name ends the operator's session.",
            image: { id: "hub", caption: "Handheld: the main screen without an assigned line" },
          },
        ],
      },
      {
        id: "printer",
        heading: "5. The label printer",
        blocks: [
          {
            kind: "step",
            title: "Add the printer",
            text: "Open «Настройки» (Settings) → «Принтер» (Printer) and press «Добавить по адресу» (Add by address). Set «Название принтера» (Printer name), choose «По сети (Wi-Fi)» (Network (Wi-Fi)) or «Bluetooth», and for a network printer «IP-адрес» (IP address) and «Порт» (Port), usually 9100. Choose «Язык принтера» (Printer language): ZPL for Zebra printers, TSPL for TSC printers, and «Плотность» (Density), 203 or 300 dpi, as on the printer. Press «Проверить связь» (Check connection): the printer is saved on the handheld.",
            image: { id: "printer-add", caption: "Handheld: a new network printer" },
          },
          {
            kind: "step",
            title: "Assign the printer",
            text: "On «Принтеры» (Printers) press «Назначения» (Assignments), and for each label kind, «Короб» (Box), «Дубль кода» (Code duplicate) and «Паллета» (Pallet), press «Выбрать принтер» (Choose printer). The warehouse needs the «Паллета» (Pallet) assignment. While a kind has no printer, the «Настройки» (Settings) tile on the main screen says what is not assigned.",
            image: {
              id: "printer-assignments",
              caption: "Handheld: printer assignment by label kind",
            },
          },
        ],
      },
      {
        id: "pallets",
        heading: "6. Building a pallet",
        blocks: [
          {
            kind: "step",
            title: "Open pallet building",
            text: "On the main screen press «Паллеты» (Pallets). The handheld waits for the first box: «Отсканируйте короб» (Scan a box). The first box sets the pallet's product. The line «данные на …» (data as of …) shows when the handheld last loaded the box registry from the host; «Обновить реестр» (Refresh registry) at the top of the screen loads it again.",
            image: {
              id: "pallet-empty",
              caption: "Handheld: a new pallet waits for the first box",
            },
          },
          {
            kind: "step",
            title: "Scan the boxes' SSCC labels",
            text: "Scan the box labels one at a time. An accepted box appears in the list, the top line says «Принят» (Accepted) with the last digits of the SSCC, and above the list the handheld shows how many boxes are on the pallet out of the pallet capacity in the product card. Each box is first «в очереди» (queued) and then «принят» (accepted) by the host. A box put on by mistake is removed with the cross button in its row.",
            image: { id: "pallet-boxes", caption: "Handheld: three boxes on the pallet" },
          },
          {
            kind: "step",
            title: "If a box is not accepted",
            text: "When a scan does not fit, the handheld gives the reason in a red line at the top and does not put the box on the pallet. The most common messages are in the table below.",
            image: {
              id: "pallet-verdict",
              caption: "Handheld: a unit code scanned instead of a box SSCC",
            },
          },
          {
            kind: "table",
            caption: "Messages when a box is scanned",
            columns: ["Message", "What to do"],
            columnRatios: [2, 3],
            rows: [
              [
                "«Уже на этой паллете …» (Already on this pallet …)",
                "Nothing: the box is already in the list.",
              ],
              [
                "«Уже на паллете …» (Already on pallet …), «Уже на открытой паллете другого устройства» (Already on another device's open pallet)",
                "The box is recorded on another pallet. Set it aside and tell your supervisor.",
              ],
              [
                "«Уже на другой паллете этого ТСД» (Already on another pallet of this handheld)",
                "The box is on another pallet of this handheld. Set it aside and tell your supervisor.",
              ],
              [
                "«Другой товар: …» (Another product: …)",
                "A pallet takes boxes of one product. Set the box aside.",
              ],
              [
                "«Короб неизвестен. Обновите реестр» (Unknown box. Refresh the registry)",
                "Press «Обновить реестр» (Refresh registry) and scan the box again.",
              ],
              [
                "«Это код единицы, нужен SSCC короба» (This is a unit code; a box SSCC is needed)",
                "Scan the box label, not the code on a unit.",
              ],
              [
                "«Это паллета, не короб» (This is a pallet, not a box)",
                "A pallet label was scanned. Scan the box label.",
              ],
            ],
          },
          {
            kind: "step",
            title: "Close the pallet",
            text: "When the number of boxes reaches the pallet capacity, the handheld closes the pallet itself. To close earlier, press «Закрыть паллету досрочно» (Close pallet early) and confirm with «Закрыть паллету» (Close pallet).",
            image: { id: "pallet-close-confirm", caption: "Handheld: closing a pallet early" },
          },
          {
            kind: "step",
            title: "Apply the pallet label",
            text: "After closing, the handheld prints the pallet label on the printer assigned to «Паллета» (Pallet): the «Паллета закрыта» (Pallet closed) screen shows the pallet SSCC, the number of boxes and «Напечатано» (Printed). Apply the label to the pallet. The handheld then waits for the first box of the next pallet.",
            image: {
              id: "pallet-printed",
              caption: "Handheld: the pallet is closed and its label printed",
            },
          },
          {
            kind: "step",
            title: "If the label did not print",
            text: "On a print error the handheld says «Этикетка не напечатана» (Label not printed) and the reason. Fix it and press «Повторить» (Retry), or choose «Другой принтер» (Another printer). «Отложить этикетку» (Postpone label) leaves the label for later: the main screen gets a line about unprinted labels that opens a list with «Напечатать все» (Print all). If the handheld says «Результат печати неизвестен» (Print result unknown), look at the printer: if the label came out, press «Этикетка напечаталась» (The label printed), otherwise «Напечатать ещё раз» (Print again).",
            image: { id: "pallet-print-failed", caption: "Handheld: the printer does not respond" },
          },
          {
            kind: "paragraph",
            text: "Above the closure result, the screen names the printer recorded for this pallet. Earlier versions could show «Не назначен» (Unassigned) even when printing was configured; older pallet data may also lack the name. Check the «Паллета» (Pallet) assignment in settings and the actual label at the printer.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If the host did not accept a box, the «Паллеты» (Pallets) screen shows «Снимите с паллеты N короба» (Remove N boxes from the pallet) with the boxes and the reason. Remove those boxes from the pallet and press «Принято» (Understood); if the pallet is already closed and labelled, press «Перепечатать этикетку» (Reprint label) and replace the label.",
          },
        ],
      },
      {
        id: "warehouse-disassembly",
        heading: "7. Disassembling a warehouse pallet",
        blocks: [
          {
            kind: "callout",
            tone: "warning",
            text: "Follow this procedure only after a coordinated handheld and host update: transmitting disassembly requires host protocol 8 or later. Confirm compatibility with the administrator. Before the update, local disassembly may not reach the host or release the boxes in its records.",
          },
          {
            kind: "paragraph",
            text: "This procedure applies only to your own closed warehouse pallet, built on this handheld. Before the operation, confirm with the administrator that its closure has been acknowledged by the host. Production-shift pallets, box exceptions and pallet reprint exceptions are outside this procedure: the handheld does not yet transmit them to the host.",
          },
          {
            kind: "step",
            title: "Scan the pallet",
            text: "Open «Паллеты» (Pallets) and press the layers icon, «Расформировать паллету» (Disassemble pallet), in the top bar. Scan your own closed warehouse pallet's label. Even if the screen offers a production-shift pallet, do not use this procedure for it.",
            image: {
              id: "pallet-disassemble-scan",
              caption: "Handheld: scanning the pallet for disassembly",
            },
          },
          {
            kind: "step",
            title: "Choose a reason",
            text: "On «Почему расформировываем?» (Why disassemble?), choose the appropriate reason from the list. The pallet's final SSCC digits and box count appear above it.",
            image: {
              id: "pallet-disassemble-reason",
              caption: "Handheld: warehouse pallet disassembly reason",
            },
          },
          {
            kind: "step",
            title: "Confirm and check receipt by the host",
            text: "Check the SSCC's final digits and box count, then confirm disassembly. After «Паллета расформирована» (Pallet disassembled), remove the old label. This message confirms the local operation: the host releases the boxes after accepting the record. Wait for a host connection and check receipt with the administrator; an empty queue immediately after the operation does not yet prove receipt. If the record is rejected in «Очередь хоста» (Host queue), pass it to the administrator. On other handhelds, then press «Обновить реестр» (Refresh registry) before building a new pallet from these boxes.",
            image: {
              id: "pallet-disassemble-confirm",
              caption: "Handheld: confirming the SSCC and box count",
            },
          },
        ],
      },
      {
        id: "offline",
        heading: "8. Working without a link to the host",
        blocks: [
          {
            kind: "step",
            title: "Keep working",
            text: "Without a link the handheld shows «Нет связи с хостом — работа продолжается» (No link to the host — work continues). Only boxes from the previously downloaded registry are available; closing pallets requires remaining SSCC numbers. If the numbers run out, reconnect to the host: the pallet remains open. Within these limits, pallet building and label printing go on: records collect on the handheld, and the «Очередь хоста» (Host queue) line shows how many are waiting. The «Паллеты» (Pallets) tile shows how many boxes are unsent.",
            image: { id: "hub-offline", caption: "The handheld without a link to the host" },
          },
          {
            kind: "step",
            title: "Check the queue",
            text: "Press the «Очередь хоста» (Host queue) line: the «Очередь хоста» (Host queue) screen lists the records that «Ждут отправки» (Wait to be sent) and those «Отклонено хостом» (Rejected by the host). When the link returns, the handheld sends the queue itself; «Отправить сейчас» (Send now) sends it without waiting. If the host rejected a record, press «Передать в поддержку» (Pass to support) and tell the administrator.",
            image: { id: "host-queue", caption: "Handheld: the queue of records for the host" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Do not uninstall the app or reset the handheld while the queue is not empty: unsent records are stored only on this handheld.",
          },
        ],
      },
      {
        id: "faq",
        heading: "9. Common questions",
        blocks: [
          {
            kind: "table",
            caption: "Common questions",
            columns: ["What you see", "What to do"],
            columnRatios: [2, 3],
            rows: [
              [
                "The «Смена» (Shift) tile says «смен нет» (no shifts)",
                "Check that the handheld has a line assigned and that the line has planned or active shifts. The administrator chooses «Линия» (Line) in the handheld's window under «Устройства» (Devices) and saves; the handheld receives it when connected to the host (step 3.7). If the field is absent, first update the office PC application. The warehouse «Паллеты» (Pallets) mode also works without an assigned line.",
              ],
              [
                "«Справочник ещё не загружен» (Reference data not loaded yet) in «Паллеты» (Pallets)",
                "The handheld has not yet received products and templates from the host. Go back to the main screen and open «Паллеты» (Pallets) again while the handheld is online with the host.",
              ],
              [
                "«Сертификат хоста изменился — нажмите, чтобы привязать ТСД заново» (The host certificate changed — tap to pair the handheld again)",
                "The host presents a different certificate. In the office, in «Устройства» (Devices), press «Привязать заново» (Pair again) in this handheld's row; on the handheld tap the message and enter the new code. Data and the queue on the handheld are kept.",
              ],
              [
                "«Часы устройства расходятся с хостом — проверьте время на ТСД» (The device clock differs from the host — check the time on the handheld)",
                "Set the same time and time zone on the handheld as on the host computer.",
              ],
              [
                "«Хост восстанавливается из копии — работа продолжается» (The host is being restored from a backup — work continues)",
                "The administrator is restoring the host from a backup. Keep working: the queue goes to the host after the restore.",
              ],
            ],
          },
          {
            kind: "paragraph",
            text: "If a question is not resolved, tell the site administrator: the office shows the handheld, its version and its link to the host in «Устройства» (Devices).",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
