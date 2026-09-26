import type { LegalDocumentSource } from "../types.js";

export const STATION_WORK_CYCLE_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: рабочий цикл — проверка и агрегация",
    summary:
      "Пошаговая инструкция оператора: сканирование кодов и сигналы станции, наполнение и закрытие коробов, сборка паллет, работа без сети, пауза и закрытие смены.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает работу оператора на станции сканирования Маркиро в течение смены: сканирование кодов маркировки, сигналы станции, наполнение и закрытие коробов в режиме агрегации, сборку паллет, работу без сети и завершение смены. Вход на станцию и старт смены описаны в инструкции MKR-INS-01.",
          },
          {
            kind: "paragraph",
            text: "Режим смены задаётся при её создании: «Проверка» — станция только проверяет и учитывает каждый код; «Агрегация» — принятые единицы дополнительно укладываются в короба, станция ведёт их учёт и печатает этикетки коробов, а в смене с паллетами ещё и собирает закрытые короба в паллеты.",
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
        id: "pallets",
        heading: "5. Паллеты",
        blocks: [
          {
            kind: "paragraph",
            text: "Если в смене включена сборка паллет, каждый закрытый короб станция сразу ставит на текущую паллету, а заполненную паллету закрывает и печатает её этикетку. Сборку паллет включают при планировании смены в кабинете или кнопкой «С паллетами» при создании смены в режиме «Агрегация» на станции. Сколько коробов встаёт на паллету, берётся из карточки товара; при планировании смены в кабинете это число можно изменить.",
          },
          {
            kind: "step",
            title: "Следите за полосой паллеты",
            text: "Под панелью короба — полоса «Паллета»: сколько коробов уже на паллете из её вместимости (например, 15 / 66) и процент заполнения. Ниже — сколько коробов осталось (например, «Остался 51 короб») и после слова «последний» — конец номера SSCC последнего поставленного короба. Кнопка «Состав паллеты» показывает короба текущей паллеты, «Закрыть паллету» закрывает её досрочно; пока на паллете нет коробов, обе недоступны.",
            image: {
              id: "work-pallet",
              caption: "Рабочий экран смены с паллетами: полоса паллеты под коробом",
            },
          },
          {
            kind: "step",
            title: "Заполненную паллету станция закрывает сама",
            text: "Когда закрывается короб, заполнивший паллету, станция закрывает и паллету: присваивает ей номер SSCC и печатает этикетку. Появляется экран «Паллета закрыта» с числом коробов, номером SSCC паллеты и принтером, на который идёт этикетка; пока идёт печать, на нём написано «Печатаем этикетку паллеты…». Наклейте этикетку на эту паллету и нажмите «Продолжить» — следующие короба пойдут на новую паллету.",
            image: { id: "pallet-closed", caption: "Паллета закрыта, этикетка напечатана" },
            expected: "На экране «Паллета закрыта» — «Этикетка напечатана».",
          },
          {
            kind: "step",
            title: "Если этикетка паллеты не напечатана",
            text: "При сбое печати станция покажет причину и кнопку «Повторить печать», а если причина в принтере — ещё и «Настроить принтер». Если печать прервалась — например, станцию перезапустили во время печати, — станция не знает, вышла ли этикетка, и показывает «Неизвестно, напечаталась ли этикетка». Сама она этикетку не повторяет: посмотрите на принтер и нажмите «Этикетка напечаталась», если этикетка вышла, или «Напечатать ещё раз», если нет. Кнопка «Сменить принтер» отправит этикетку на другой принтер станции.",
            image: {
              id: "pallet-print-unknown",
              caption: "Исход печати неизвестен: подтвердите или напечатайте ещё раз",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если печать сейчас невозможна, «Продолжить без этикетки» вернёт к работе: паллета уже закрыта и учтена — напечатайте её этикетку позже через «Перепечатать паллету» (инструкция по исключениям MKR-INS-03). Пометьте такую паллету, чтобы не потерять её.",
          },
          {
            kind: "step",
            title: "Посмотрите состав паллеты",
            text: "«Состав паллеты» открывает список коробов текущей паллеты: номер SSCC каждого короба и время закрытия. Пока список открыт, сканирование приостановлено; кнопка «К сборке» возвращает к работе.",
            image: { id: "pallet-contents", caption: "Состав паллеты: короба и время закрытия" },
          },
          {
            kind: "step",
            title: "Закройте паллету досрочно",
            text: "Чтобы закрыть неполную паллету — например, в конце партии, — нажмите «Закрыть паллету». Станция спросит «Закрыть паллету досрочно» и покажет, сколько коробов на паллете; нажмите «Подтвердить» или «Остаться». Дальше — как при закрытии заполненной паллеты: номер SSCC и печать этикетки.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "«нет серий для паллеты» на полосе паллеты означает, что у станции закончились номера SSCC для паллет: заполненная паллета не закрывается, и следующие короба ставятся на неё сверх вместимости. Восстановите связь станции с сервером (позовите администратора) — станция получит новые номера и закроет паллету при закрытии следующего короба; после этого закрыть её можно и кнопкой «Закрыть паллету».",
          },
        ],
      },
      {
        id: "offline",
        heading: "6. Работа без сети",
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
        heading: "7. Пауза и закрытие смены",
        blocks: [
          {
            kind: "step",
            title: "Прервитесь кнопкой «Пауза»",
            text: "Кнопка «Пауза» выводит вас из смены, не закрывая её: станция возвращается к экрану выбора смены, а продолжить смену после перерыва можете вы или другой оператор. Если часть сканов ещё не дошла до сервера, станция предупредит об этом и предложит «Остаться» или «Всё равно выйти»; данные сохраняются на станции и уйдут при связи.",
          },
          {
            kind: "step",
            title: "Закройте смену в конце работы",
            text: "Нажмите «Закрыть смену». В режиме агрегации сначала закройте открытый короб — станция напомнит: «Сначала закройте открытый короб». В смене с паллетами, если на текущей паллете есть короба, станция спросит «На паллете 15 из 66 коробов — закрыть?»: «Закрыть паллету и смену» закроет паллету и напечатает её этикетку, как в разделе 5, — после «Продолжить» на экране «Паллета закрыта» станция закроет смену; «Остаться» вернёт к работе. Если номера для паллет закончились, станция сообщит «Номера для паллет закончились» — восстановите связь и повторите. Если фактическое количество не совпало с планом, станция попросит указать причину расхождения.",
            expected: "Смена закрыта, станция вернулась к экрану выбора смены.",
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
                term: "Этикетка паллеты испорчена или потерялась",
                detail:
                  "Перепечатайте её: «Исключения» → «Действия с паллетой» → «Перепечатать паллету» (инструкция по исключениям MKR-INS-03). Старую этикетку уничтожьте.",
              },
              {
                term: "Паллета не закрывается, хотя заполнена",
                detail:
                  "На полосе паллеты — «нет серий для паллеты»: у станции закончились номера для паллет. Восстановите связь станции с сервером (позовите администратора); подробнее — в разделе 5.",
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
      "This is an informational translation. The matching Russian revision is authoritative. Step-by-step operator guide: scanning codes and station signals, filling and closing boxes, building pallets, working offline, pausing and closing the shift.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the operator's work at a Markiro scanning station during a shift: scanning marking codes, station signals, filling and closing boxes in aggregation mode, building pallets, working offline and finishing the shift. Signing in and starting a shift are covered by instruction MKR-INS-01.",
          },
          {
            kind: "paragraph",
            text: "The shift mode is set when the shift is created: “Validation” — the station only checks and records every code; “Aggregation” — accepted units are additionally packed into boxes, and the station tracks them and prints box labels; on a shift with pallets it also builds the closed boxes into pallets.",
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
        id: "pallets",
        heading: "5. Pallets",
        blocks: [
          {
            kind: "paragraph",
            text: "If pallet assembly is on for the shift, the station puts every closed box onto the current pallet right away, and when the pallet is full it closes it and prints its label. Pallet assembly is switched on when the shift is planned in the cabinet, or with “With pallets” when an “Aggregation” shift is created at the station. The number of boxes per pallet comes from the product card; it can be changed when the shift is planned in the cabinet.",
          },
          {
            kind: "step",
            title: "Watch the pallet strip",
            text: "Under the box panel is the “Pallet” strip: how many boxes are already on the pallet out of its capacity (for example, 15 / 66) and how full it is in percent. Below are the boxes still to go (for example, “51 boxes remaining”) and, after the word “last”, the end of the SSCC of the last box put on it. The “Pallet contents” button lists the current pallet's boxes, and “Close pallet” closes it early; both are unavailable while the pallet has no boxes.",
            image: {
              id: "work-pallet",
              caption: "The work screen of a pallet shift: the pallet strip under the box",
            },
          },
          {
            kind: "step",
            title: "The station closes a full pallet by itself",
            text: "When the box that fills the pallet is closed, the station closes the pallet too: it assigns it an SSCC number and prints the label. The “Pallet closed” screen shows the box count, the pallet SSCC and the printer the label goes to; while printing, it says “Printing the pallet label…”. Stick the label onto this pallet and tap “Continue” — the next boxes go onto a new pallet.",
            image: { id: "pallet-closed", caption: "The pallet is closed and its label printed" },
            expected: "The “Pallet closed” screen shows “Label printed”.",
          },
          {
            kind: "step",
            title: "If the pallet label did not print",
            text: "If printing fails, the station shows the cause and a “Retry printing” button, plus “Set up printer” when the cause is the printer. If printing was interrupted — for example, the station restarted mid-print — the station cannot tell whether the label came out and shows “Unknown whether the label printed”. It never prints again by itself: check the printer and tap “The label already printed” if the label came out, or “Print again” if it did not. The “Change printer” button sends the label to another printer of the station.",
            image: {
              id: "pallet-print-unknown",
              caption: "The print outcome is unknown: confirm it or print again",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If printing is impossible right now, “Continue without a label” returns to work: the pallet is already closed and recorded — print its label later with “Reprint pallet” (the exceptions instruction MKR-INS-03). Mark such a pallet so it does not get lost.",
          },
          {
            kind: "step",
            title: "Check the pallet contents",
            text: "“Pallet contents” lists the boxes of the current pallet: each box's SSCC and closing time. While the list is open, scanning is paused; the “Back to assembly” button returns to work.",
            image: {
              id: "pallet-contents",
              caption: "Pallet contents: the boxes and their closing times",
            },
          },
          {
            kind: "step",
            title: "Close a pallet early",
            text: "To close a pallet that is not full — for example, at the end of a batch — tap “Close pallet”. The station asks to “Close pallet early” and shows how many boxes the pallet has; tap “Confirm” or “Stay”. The rest is the same as for a full pallet: an SSCC number and the label print.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "“no pallet serials left” on the pallet strip means the station has run out of SSCC numbers for pallets: a full pallet does not close, and the next boxes go onto it beyond capacity. Restore the station's connection to the server (call an administrator) — the station receives new numbers and closes the pallet when the next box is closed; after that you can also close it with “Close pallet”.",
          },
        ],
      },
      {
        id: "offline",
        heading: "6. Working offline",
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
        heading: "7. Pausing and closing the shift",
        blocks: [
          {
            kind: "step",
            title: "Take a break with “Pause”",
            text: "The “Pause” button takes you out of the shift without closing it: the station returns to the shift selection screen, and after the break you or another operator can continue the shift. If some scans have not reached the server yet, the station warns about it and offers “Stay” or “Leave anyway”; the data stays on the station and is sent once there is a connection.",
          },
          {
            kind: "step",
            title: "Close the shift at the end of work",
            text: "Tap “Close shift”. In aggregation mode close the open box first — the station reminds you: “Close the open box first”. On a pallet shift, if the current pallet has boxes, the station asks “The pallet has 15 of 66 boxes — close it?”: “Close pallet and shift” closes the pallet and prints its label as in section 5 — after “Continue” on the “Pallet closed” screen the station closes the shift; “Stay” returns to work. If pallet numbers have run out, the station reports “Pallet numbers have run out” — restore the connection and try again. If the actual quantity does not match the plan, the station asks for the reason for the difference.",
            expected: "The shift is closed and the station returned to the shift selection screen.",
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
                term: "The pallet label is damaged or lost",
                detail:
                  "Reprint it: “Exceptions” → “Pallet actions” → “Reprint pallet” (the exceptions instruction MKR-INS-03). Destroy the old label.",
              },
              {
                term: "The pallet does not close although it is full",
                detail:
                  "The pallet strip shows “no pallet serials left”: the station has run out of pallet numbers. Restore the station's connection to the server (call an administrator); see section 5 for details.",
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
