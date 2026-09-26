import type { LegalDocumentSource } from "../types.js";

export const STATION_WORK_CYCLE_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: рабочий цикл — проверка и агрегация",
    summary:
      "Пошаговая инструкция оператора: сканирование кодов и сигналы станции, наполнение и закрытие коробов, работа без сети, пауза и закрытие смены.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает работу оператора на станции сканирования Маркиро в течение смены: сканирование кодов маркировки, сигналы станции, наполнение и закрытие коробов в режиме агрегации, работу без сети и завершение смены. Вход на станцию и старт смены описаны в инструкции MKR-INS-01.",
          },
          {
            kind: "paragraph",
            text: "Режим смены задаётся при её создании: «Проверка» — станция только проверяет и учитывает каждый код; «Агрегация» — принятые единицы дополнительно укладываются в короба, станция ведёт их учёт и печатает этикетки коробов.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия продуктов, номера смен и счётчики на вашей станции будут отличаться.",
          },
        ],
      },
      {
        id: "scan-cycle",
        heading: "2. Цикл сканирования и сигналы",
        blocks: [
          {
            kind: "paragraph",
            text: "Рабочий экран устроен так: вверху — лента смены с продуктом (фото, название, GTIN) и итогом смены; слева — результат последнего скана, а в режиме агрегации — открытый короб; справа — журнал смены с последними сканами этой станции. Внизу — кнопки «Исключения», «Пауза» и «Закрыть смену».",
          },
          {
            kind: "step",
            title: "Отсканируйте код маркировки",
            text: "Возьмите единицу продукции и наведите сканер на код DataMatrix. Станция обрабатывает сканы по одному: дождитесь сигнала по текущей единице, прежде чем сканировать следующую.",
            image: { id: "work-scan-wait", caption: "Рабочий экран: станция ждёт скан" },
            expected: "Станция подала звук и показала результат скана.",
          },
          {
            kind: "step",
            title: "Код принят — продолжайте",
            text: "Принятый скан станция показывает на рабочем экране: в режиме проверки — зелёная панель с галочкой и кодом, в режиме агрегации — галочка с серийным номером на панели короба. Итог «В смене» на ленте смены увеличивается. В режиме агрегации положите единицу в открытый короб; в режиме проверки — передайте дальше по линии.",
            image: { id: "scan-ok", caption: "Рабочий экран: код принят (зелёная панель)" },
          },
          {
            kind: "step",
            title: "Сигнал «ДУБЛЬ» — отложите единицу",
            text: "Этот код уже сканировали: станция показывает время первого скана. Не кладите единицу в короб — отложите её отдельно. Если дубли идут подряд, остановитесь и сообщите мастеру: возможно, продукция уже проходила через станцию.",
            image: { id: "scan-duplicate", caption: "Сигнал «ДУБЛЬ» со временем первого скана" },
          },
          {
            kind: "step",
            title: "Красный сигнал — не пропускайте единицу дальше",
            text: "«НЕВЕРНЫЙ КОД» — отсканирован не код маркировки или код повреждён: расправьте упаковку и повторите скан; если код не читается, отложите единицу. «ЧУЖОЙ ГТИН» — продукт не относится к этой смене: уберите его с линии. «ОШИБКА ЗАПИСИ» — станция не смогла сохранить скан: остановитесь и позовите наладчика.",
            image: { id: "scan-error", caption: "Красный сигнал: единицу нельзя пропускать" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Полноэкранный сигнал гаснет сам через несколько секунд. Если вы отвлеклись — сверьтесь с панелью «Журнал смены»: там видны последние сканы с вердиктом, серийным номером и временем.",
          },
        ],
      },
      {
        id: "validation-mode",
        heading: "3. Режим «Проверка»",
        blocks: [
          {
            kind: "paragraph",
            text: "В режиме проверки задача оператора — прогнать каждую единицу через сканер и следить за сигналами. Коробов и печати в этом режиме нет.",
          },
          {
            kind: "unordered-list",
            items: [
              "Ход смены показывает лента смены: «В смене · все терминалы» — сколько единиц приняли в смене все терминалы. Если задан план, после итога указан план, ниже — полоса и процент выполнения, например «14 % плана». Если в смене работают и другие терминалы, добавляется доля этой станции — «этот терминал 302».",
              "Подпись «В смене · этот терминал» станция показывает, пока не получила итог с сервера, — например, если смену открыли без связи: тогда в числе только её собственные сканы. Если итог с сервера не обновлялся дольше двух минут, а в смене работают другие терминалы, вместо доли станции указано время последнего ответа — «другие терминалы — на 11:58».",
              "Панель «Журнал смены» показывает последние сканы этой станции: вердикт, серийный номер и время. GTIN указан только в строках «ЧУЖОЙ ГТИН»; отмена последнего скана добавляет строку «Отменено».",
              "Счётчики «Ошибки» и «Дубли» в заголовке журнала считают отклонённые сканы этой станции за всю смену и не обнуляются после паузы, смены оператора или перезапуска станции.",
              "Когда план наберут сканы этой станции, она сообщит «План выполнен» — дальше действуйте по указанию мастера.",
            ],
          },
        ],
      },
      {
        id: "aggregation-mode",
        heading: "4. Режим «Агрегация»",
        blocks: [
          {
            kind: "step",
            title: "Наполняйте открытый короб",
            text: "Панель короба показывает его номер («Короб № 1»), заполнение — сколько позиций уже в коробе из его вместимости — и серийный номер последнего принятого кода с галочкой. Кладите единицу в короб только после того, как на панели появилась галочка с её серийным номером.",
            image: {
              id: "work-aggregation",
              caption: "Рабочий экран агрегации: панель открытого короба",
            },
          },
          {
            kind: "step",
            title: "Заполненный короб станция закрывает сама",
            text: "Когда в короб легла последняя позиция по его вместимости, станция сама закрывает его: присваивает коробу номер SSCC и отправляет этикетку на принтер. Наклейте этикетку на этот короб сразу — не откладывайте её в сторону. Кнопка «Закрыть короб» закрывает короб раньше — например, неполный короб в конце смены. Если на панели написано «Вместимость не задана», станция не знает, когда короб полон, — закрывайте каждый короб этой кнопкой.",
            image: {
              id: "box-full",
              caption: "Короб заполнен: станция закрывает его и печатает этикетку",
            },
            expected: "Принтер напечатал этикетку короба.",
          },
          {
            kind: "step",
            title: "Сверьте напечатанную этикетку",
            text: "Если на станции включена сверка печати, появится экран «Отсканируйте распечатанную этикетку»: наведите сканер на код SSCC на этикетке. Сообщение «Это другая этикетка» означает, что в руках этикетка от другого короба — найдите правильную или нажмите «Печатать заново». Кнопка «Пропустить» пропускает сверку; пропуск фиксируется в учёте.",
            image: { id: "print-verification", caption: "Сверка напечатанной этикетки короба" },
            expected: "Станция подтвердила этикетку и открыла следующий короб.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Каждая этикетка принадлежит одному конкретному коробу: номер SSCC уникален. Наклеенная на чужой короб этикетка ломает учёт всей партии.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Кнопка «Отменить последний скан» убирает из открытого короба последнюю добавленную позицию, «Очистить короб» удаляет все его позиции — используйте их только по указанию мастера.",
          },
        ],
      },
      {
        id: "offline",
        heading: "5. Работа без сети",
        blocks: [
          {
            kind: "step",
            title: "Продолжайте работать при «Нет связи»",
            text: "Если в строке состояния у индикатора «Сервер» появилась подпись «Нет связи», станция продолжает принимать сканы и копит их локально — сколько сканов ждут отправки, показывает индикатор «Синх.». Работайте как обычно: при восстановлении связи данные уйдут на сервер сами. Итог «В смене» тем временем учитывает сканы других терминалов на момент последнего ответа сервера (см. раздел 3).",
            image: { id: "offline", caption: "Работа без сети: сканы копятся на станции" },
            expected: "После восстановления связи число у индикатора «Синх.» уменьшается до нуля.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Позовите администратора, если при работающей сети число у индикатора «Синх.» долго не уменьшается или у индикатора появилась подпись «Не отправляется». В режиме агрегации долгий офлайн может исчерпать запас номеров коробов — станция сообщит «Номера для коробов закончились» и приостановит сканирование до восстановления связи.",
          },
        ],
      },
      {
        id: "pause-close",
        heading: "6. Пауза и закрытие смены",
        blocks: [
          {
            kind: "step",
            title: "Прервитесь кнопкой «Пауза»",
            text: "Кнопка «Пауза» выводит вас из смены, не закрывая её: станция возвращается к экрану выбора смены, а продолжить смену после перерыва можете вы или другой оператор. Если часть сканов ещё не дошла до сервера, станция предупредит об этом и предложит «Остаться» или «Всё равно выйти»; данные сохраняются на станции и уйдут при связи.",
          },
          {
            kind: "step",
            title: "Закройте смену в конце работы",
            text: "Нажмите «Закрыть смену». В режиме агрегации сначала закройте открытый короб — станция напомнит: «Сначала закройте открытый короб». Если фактическое количество не совпало с планом, станция попросит указать причину расхождения.",
            expected: "Смена закрыта, станция вернулась к экрану выбора смены.",
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
                term: "Дубли идут один за другим",
                detail:
                  "Похоже, эта продукция уже сканировалась. Остановитесь, отложите пачку и позовите мастера.",
              },
              {
                term: "Принтер не напечатал этикетку короба",
                detail:
                  "Станция покажет экран «Этикетка короба не напечатана» с вариантами перепечатать или продолжить без этикетки. Действия при сбоях печати подробно описаны в инструкции по исключениям.",
              },
              {
                term: "Номера для коробов закончились",
                detail:
                  "Запас номеров SSCC исчерпан в офлайне. Восстановите связь со станцией (позовите администратора), затем вернитесь к работе.",
              },
              {
                term: "Число у индикатора «Синх.» растёт, хотя сеть работает",
                detail:
                  "Не останавливайте работу — сканы не теряются. Сообщите администратору: очередь отправки требует внимания.",
              },
              {
                term: "Сканер перестал читать коды",
                detail:
                  "Проверьте индикатор сканера в строке состояния — при проблеме он раскрывается подписью, полный вид открывает кнопка «Развернуть» — и кабель. Если связь не восстановилась — позовите наладчика.",
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
    title: "Scanning station: the work cycle — validation and aggregation",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Step-by-step operator guide: scanning codes and station signals, filling and closing boxes, working offline, pausing and closing the shift.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the operator's work at a Markiro scanning station during a shift: scanning marking codes, station signals, filling and closing boxes in aggregation mode, working offline and finishing the shift. Signing in and starting a shift are covered by instruction MKR-INS-01.",
          },
          {
            kind: "paragraph",
            text: "The shift mode is set when the shift is created: “Validation” — the station only checks and records every code; “Aggregation” — accepted units are additionally packed into boxes, and the station tracks them and prints box labels.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots use demo data. Product names, shift numbers and counters on your station will differ.",
          },
        ],
      },
      {
        id: "scan-cycle",
        heading: "2. The scan cycle and signals",
        blocks: [
          {
            kind: "paragraph",
            text: "The work screen is laid out as follows: at the top, the shift band with the product (photo, name, GTIN) and the shift total; on the left, the result of the last scan, and in aggregation mode the open box; on the right, the shift journal with this station's latest scans. At the bottom are the “Exceptions”, “Pause” and “Close shift” buttons.",
          },
          {
            kind: "step",
            title: "Scan a marking code",
            text: "Take a unit of product and point the scanner at the DataMatrix code. The station processes scans one at a time: wait for the signal for the current unit before scanning the next one.",
            image: {
              id: "work-scan-wait",
              caption: "Work screen: the station is waiting for a scan",
            },
            expected: "The station beeped and showed the scan result.",
          },
          {
            kind: "step",
            title: "Code accepted — keep going",
            text: "The station shows an accepted scan on the work screen: in validation mode, a green panel with a check mark and the code; in aggregation mode, a check mark with the serial number on the box panel. The “In shift” total on the shift band goes up. In aggregation mode, put the unit into the open box; in validation mode, pass it on down the line.",
            image: { id: "scan-ok", caption: "Work screen: the code is accepted (green panel)" },
          },
          {
            kind: "step",
            title: "The “DUPLICATE” signal — set the unit aside",
            text: "This code has already been scanned: the station shows the time of the first scan. Do not put the unit into a box — set it aside separately. If duplicates keep coming, stop and tell your supervisor: the product may have already passed through the station.",
            image: {
              id: "scan-duplicate",
              caption: "The “DUPLICATE” signal with the time of the first scan",
            },
          },
          {
            kind: "step",
            title: "A red signal — do not let the unit through",
            text: "“WRONG CODE” — the scan was not a marking code or the code is damaged: flatten the packaging and scan again; if the code cannot be read, set the unit aside. “WRONG GTIN” — the product does not belong to this shift: remove it from the line. “WRITE FAILED” — the station could not save the scan: stop and call a technician.",
            image: { id: "scan-error", caption: "A red signal: the unit must not pass" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "The full-screen signal fades out by itself after a few seconds. If you got distracted, check the “Shift journal” panel: it lists the latest scans with the verdict, serial number and time.",
          },
        ],
      },
      {
        id: "validation-mode",
        heading: "3. “Validation” mode",
        blocks: [
          {
            kind: "paragraph",
            text: "In validation mode the operator's job is to run every unit through the scanner and watch the signals. There are no boxes and no printing in this mode.",
          },
          {
            kind: "unordered-list",
            items: [
              "The shift band shows the shift progress: “In shift · all terminals” is how many units all terminals have accepted in the shift. If a plan is set, the plan follows the total, with a bar and the share completed below, for example “14% of plan”. If other terminals work the shift too, this station's share is added — “this terminal 302”.",
              "The station shows the “In shift · this terminal” label until it has received the total from the server — for example, when the shift was opened without a connection: the number then counts only its own scans. If the server total has not been refreshed for more than two minutes and other terminals work the shift, the time of the last answer replaces this station's share — “other terminals as of 11:58 AM”.",
              "The “Shift journal” panel shows this station's latest scans: the verdict, serial number and time. The GTIN is shown only on “WRONG GTIN” rows; undoing the last scan adds an “Undone” row.",
              "The “Errors” and “Duplicates” counters in the journal header count this station's rejected scans for the whole shift and are not reset by a pause, an operator change or a station restart.",
              "When this station's own scans reach the plan, it reports “Plan completed” — follow your supervisor's directions from there.",
            ],
          },
        ],
      },
      {
        id: "aggregation-mode",
        heading: "4. “Aggregation” mode",
        blocks: [
          {
            kind: "step",
            title: "Fill the open box",
            text: "The box panel shows the box number (“Box no. 1”), how full it is — how many items are already in the box out of its capacity — and the serial number of the last accepted code with a check mark. Put a unit into the box only once the check mark with its serial number has appeared on the panel.",
            image: {
              id: "work-aggregation",
              caption: "Aggregation work screen: the open box panel",
            },
          },
          {
            kind: "step",
            title: "The station closes a full box by itself",
            text: "When the last item that fits the box's capacity goes in, the station closes the box by itself: it assigns the box an SSCC number and sends the label to the printer. Stick the label onto this box right away — do not put it aside. The “Close box” button closes a box earlier — for example, a partially filled box at the end of the shift. If the panel says “Capacity not set”, the station cannot tell when a box is full, so close every box with this button.",
            image: {
              id: "box-full",
              caption: "The box is full: the station closes it and prints the label",
            },
            expected: "The printer printed the box label.",
          },
          {
            kind: "step",
            title: "Verify the printed label",
            text: "If print verification is enabled on the station, the “Scan the printed label” screen appears: point the scanner at the SSCC code on the label. The “This is a different label” message means you are holding a label from another box — find the right one or tap “Print again”. The “Skip” button skips the verification; the skip is recorded.",
            image: { id: "print-verification", caption: "Verifying the printed box label" },
            expected: "The station confirmed the label and opened the next box.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Every label belongs to one specific box: the SSCC number is unique. A label stuck onto the wrong box breaks the records of the whole batch.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "“Undo last scan” removes the last added item from the open box, and “Clear box” removes all of its items — use them only when your supervisor says so.",
          },
        ],
      },
      {
        id: "offline",
        heading: "5. Working offline",
        blocks: [
          {
            kind: "step",
            title: "Keep working during “No connection”",
            text: "If the “Server” indicator in the status bar shows “No connection”, the station keeps accepting scans and stores them locally — the “Sync” indicator shows how many scans are waiting to be sent. Work as usual: once the connection is back, the data goes to the server by itself. Meanwhile the “In shift” total counts the other terminals' scans as of the server's last answer (see section 3).",
            image: { id: "offline", caption: "Working offline: scans accumulate on the station" },
            expected:
              "After the connection is restored the number on the “Sync” indicator goes down to zero.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Call an administrator if the number on the “Sync” indicator does not go down for a long time while the network is up, or the indicator shows “Not syncing”. In aggregation mode a long offline period can exhaust the box number reserve — the station will report “Box numbers have run out” and pause scanning until the connection is back.",
          },
        ],
      },
      {
        id: "pause-close",
        heading: "6. Pausing and closing the shift",
        blocks: [
          {
            kind: "step",
            title: "Take a break with “Pause”",
            text: "The “Pause” button takes you out of the shift without closing it: the station returns to the shift selection screen, and after the break you or another operator can continue the shift. If some scans have not reached the server yet, the station warns about it and offers “Stay” or “Leave anyway”; the data stays on the station and is sent once there is a connection.",
          },
          {
            kind: "step",
            title: "Close the shift at the end of work",
            text: "Tap “Close shift”. In aggregation mode close the open box first — the station reminds you: “Close the open box first”. If the actual quantity does not match the plan, the station asks for the reason for the difference.",
            expected: "The shift is closed and the station returned to the shift selection screen.",
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
                term: "Duplicates keep coming one after another",
                detail:
                  "This product has probably been scanned before. Stop, set the batch aside and call your supervisor.",
              },
              {
                term: "The printer did not print the box label",
                detail:
                  "The station shows the “The box label was not printed” screen with options to reprint or continue without a label. Print failure handling is covered in detail by the exceptions instruction.",
              },
              {
                term: "Box numbers have run out",
                detail:
                  "The SSCC number reserve was exhausted while offline. Restore the station's connection (call an administrator), then get back to work.",
              },
              {
                term: "The number on the “Sync” indicator grows although the network is up",
                detail:
                  "Do not stop working — scans are not lost. Tell an administrator: the send queue needs attention.",
              },
              {
                term: "The scanner stopped reading codes",
                detail:
                  "Check the scanner indicator in the status bar — a problem indicator expands into a caption, and the “Expand” button opens the full view — and check the cable. If the connection does not come back, call a technician.",
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
