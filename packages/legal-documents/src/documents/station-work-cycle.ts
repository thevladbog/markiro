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
            kind: "step",
            title: "Отсканируйте код маркировки",
            text: "Возьмите единицу продукции и наведите сканер на код DataMatrix. Станция обрабатывает сканы по одному: дождитесь сигнала по текущей единице, прежде чем сканировать следующую.",
            image: { id: "work-scan-wait", caption: "Рабочий экран: станция ждёт скан" },
            expected: "Станция подала звук и показала результат скана.",
          },
          {
            kind: "step",
            title: "Код принят — продолжайте",
            text: "Принятый скан станция показывает на рабочем экране: зелёная панель с галочкой и кодом, счётчик «Принято» увеличивается. В режиме агрегации положите единицу в открытый короб; в режиме проверки — передайте дальше по линии.",
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
            text: "Полноэкранный сигнал гаснет сам через несколько секунд. Если вы отвлеклись — сверьтесь с панелью «Последние операции»: там видны последние сканы с вердиктами и временем.",
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
              "Счётчики «Принято» и «Отклонено» показывают ход смены; если задан план, под продуктом отображается «План: N».",
              "Панель «Последние операции» показывает недавние сканы с серийными номерами и временем.",
              "При выполнении плана станция сообщит «План выполнен» — дальше действуйте по указанию мастера.",
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
            text: "Панель короба на рабочем экране показывает его номер («Короб № 1») и число позиций. Кладите единицу в короб только после зелёной панели принятого кода.",
            image: {
              id: "work-aggregation",
              caption: "Рабочий экран агрегации: панель «Открытый короб»",
            },
          },
          {
            kind: "step",
            title: "Закройте заполненный короб",
            text: "Когда короб набрал вместимость, закройте его кнопкой «Закрыть короб». Станция присвоит коробу номер SSCC и отправит этикетку на принтер. Наклейте этикетку на этот короб сразу — не откладывайте её в сторону.",
            image: { id: "box-full", caption: "Короб заполнен и готов к закрытию" },
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
            text: "Неполный короб в конце смены закрывается той же кнопкой «Закрыть короб». Кнопка «Отменить последний скан» убирает из короба последнюю добавленную позицию, «Очистить короб» удаляет все позиции открытого короба — используйте их только по указанию мастера.",
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
            text: "Если в строке состояния «Сервер: Нет связи», станция продолжает принимать сканы и копит их локально — счётчик «Не отправлено» показывает очередь. Работайте как обычно: при восстановлении связи данные уйдут на сервер сами.",
            image: { id: "offline", caption: "Работа без сети: сканы копятся на станции" },
            expected: "После восстановления связи счётчик уменьшается до «Синхронизировано».",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Позовите администратора, если при работающей сети счётчик «Не отправлено» долго не уменьшается или в строке состояния «Синхронизация: Не отправляется». В режиме агрегации долгий офлайн может исчерпать запас номеров коробов — станция сообщит «Номера для коробов закончились» и приостановит сканирование до восстановления связи.",
          },
        ],
      },
      {
        id: "pause-close",
        heading: "6. Пауза и закрытие смены",
        blocks: [
          {
            kind: "step",
            title: "Прервитесь через «Пауза / завершить»",
            text: "Кнопка «Пауза» приостанавливает работу на перерыв. «Выйти из смены» освобождает станцию, не закрывая смену — её продолжите вы после перерыва или другой оператор. Если часть сканов ещё не дошла до сервера, станция предупредит об этом; данные сохраняются на станции и уйдут при связи.",
          },
          {
            kind: "step",
            title: "Закройте смену в конце работы",
            text: "Нажмите «Закрыть смену». В режиме агрегации сначала закройте открытый короб — станция напомнит: «Сначала закройте открытый короб». Если фактическое количество не совпало с планом, станция попросит указать причину расхождения. После закрытия показываются «Итоги смены».",
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
                term: "Счётчик «Не отправлено» растёт, хотя сеть работает",
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
            kind: "step",
            title: "Scan a marking code",
            text: "Take a unit of product and point the scanner at the DataMatrix code. The station processes scans one at a time: wait for the signal for the current unit before scanning the next one.",
            image: { id: "work-scan-wait", caption: "Work screen: the station is waiting for a scan" },
            expected: "The station beeped and showed the scan result.",
          },
          {
            kind: "step",
            title: "Code accepted — keep going",
            text: "The station shows an accepted scan on the work screen: a green panel with a check mark and the code, and the “Accepted” counter goes up. In aggregation mode, put the unit into the open box; in validation mode, pass it on down the line.",
            image: { id: "scan-ok", caption: "Work screen: the code is accepted (green panel)" },
          },
          {
            kind: "step",
            title: "The “DUPLICATE” signal — set the unit aside",
            text: "This code has already been scanned: the station shows the time of the first scan. Do not put the unit into a box — set it aside separately. If duplicates keep coming, stop and tell your supervisor: the product may have already passed through the station.",
            image: { id: "scan-duplicate", caption: "The “DUPLICATE” signal with the time of the first scan" },
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
            text: "The full-screen signal fades out by itself after a few seconds. If you got distracted, check the “Recent operations” panel: it lists the latest scans with verdicts and times.",
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
              "The “Accepted” and “Rejected” counters show the shift progress; if a plan is set, “Plan: N” is shown under the product.",
              "The “Recent operations” panel shows recent scans with serial numbers and times.",
              "When the plan is reached, the station reports “Plan completed” — follow your supervisor's directions from there.",
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
            text: "The box panel on the work screen shows its number (“Box no. 1”) and the item count. Put a unit into the box only after the green accepted-code panel.",
            image: {
              id: "work-aggregation",
              caption: "Aggregation work screen: the open box panel",
            },
          },
          {
            kind: "step",
            title: "Close the full box",
            text: "When the box reaches its capacity, close it with the “Close box” button. The station assigns the box an SSCC number and sends the label to the printer. Stick the label onto this box right away — do not put it aside.",
            image: { id: "box-full", caption: "The box is full and ready to be closed" },
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
            text: "A partially filled box at the end of the shift is closed with the same “Close box” button. “Undo last scan” removes the last added item from the box, and “Clear box” removes every item from the open box — use them only when your supervisor says so.",
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
            text: "If the status bar shows “Server: No connection”, the station keeps accepting scans and stores them locally — the “pending” counter shows the queue. Work as usual: once the connection is back, the data goes to the server by itself.",
            image: { id: "offline", caption: "Working offline: scans accumulate on the station" },
            expected: "After the connection is restored the counter goes down to “Synchronized”.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Call an administrator if the “pending” counter does not go down for a long time while the network is up, or the status bar shows “Sync: Not syncing”. In aggregation mode a long offline period can exhaust the box number reserve — the station will report “Box numbers have run out” and pause scanning until the connection is back.",
          },
        ],
      },
      {
        id: "pause-close",
        heading: "6. Pausing and closing the shift",
        blocks: [
          {
            kind: "step",
            title: "Take a break through “Pause / finish”",
            text: "The “Pause” button suspends work for a break. “Leave shift” releases the station without closing the shift — you or another operator can continue it after the break. If some scans have not reached the server yet, the station warns about it; the data stays on the station and is sent once there is a connection.",
          },
          {
            kind: "step",
            title: "Close the shift at the end of work",
            text: "Tap “Close shift”. In aggregation mode close the open box first — the station reminds you: “Close the open box first”. If the actual quantity does not match the plan, the station asks for the reason for the difference. After closing, the “Shift summary” is shown.",
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
                term: "The “pending” counter grows although the network is up",
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
