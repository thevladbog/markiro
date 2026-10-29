import type { LegalDocumentSource } from "../types.js";

export const STATION_WORK_CYCLE_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция: рабочий цикл — сканирование, короба и паллеты",
    summary:
      "Пошаговая инструкция оператора Маркиро Автоном: рабочий экран и сигналы сканирования, закрытие коробов и паллет, проверка этикетки, работа без связи с хостом, выход из смены и её закрытие.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает работу оператора на открытой смене станции Маркиро Автоном: сканирование кодов маркировки, наполнение и закрытие коробов, сборку паллет, работу без связи с хостом и закрытие смены. Вход и открытие смены описаны в MKR-INS-01, нештатные ситуации — в MKR-INS-03.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия товаров, номера смен и коды на вашей станции будут другими.",
          },
        ],
      },
      {
        id: "work-screen",
        heading: "2. Рабочий экран",
        blocks: [
          {
            kind: "step",
            title: "Что показывает рабочий экран",
            text: "Вверху — лента смены: товар, номер смены, GTIN, режим и счётчик «Принято в смене» с планом. Слева — «Открытый короб»: клетки заполняются с каждым принятым кодом, справа вверху — сколько кодов в коробе из скольких. Справа — «Последний скан» с результатом последнего сканирования, «Коробов закрыто» и SSCC «Последний короб», ниже — «История сканирований». В смене с паллетами под коробом — полоса паллеты. Внизу — «Исключения», «Выйти из смены» и «Закрыть смену».",
            image: {
              id: "work-scan-wait",
              caption: "Рабочий экран: в открытом коробе 5 из 12, станция ждёт скан",
            },
          },
          {
            kind: "paragraph",
            text: "В шапке — значки связи с хостом, принтера, сканера и очереди отправки. Пока всё в порядке, они свёрнуты; при проблеме значок раскрывается подписью, например «Связи нет», «Принтер: ошибка» или «Очередь 2».",
          },
        ],
      },
      {
        id: "scanning",
        heading: "3. Сканирование и сигналы",
        blocks: [
          {
            kind: "paragraph",
            text: "Сканируйте коды маркировки по одному. Результат каждого скана появляется в «Последний скан» и в истории; при включённом звуке станция подаёт звуковой сигнал (MKR-INS-04).",
          },
          {
            kind: "step",
            title: "«Принят» — код принят",
            text: "Код принят в смену и положен в открытый короб: под результатом видно «В коробе N из M.», клетка короба заполнилась, «Принято в смене» выросло на один. Сканируйте следующую единицу.",
            image: { id: "scan-ok", caption: "Код принят: в коробе 6 из 12" },
          },
          {
            kind: "step",
            title: "«Дубль» — код уже был принят",
            text: "Этот код уже принят раньше — станция пишет, когда и, если в другой смене, в какой. Повторно он не засчитывается и в короб не попадает. Отложите единицу и сообщите мастеру.",
            image: { id: "scan-duplicate", caption: "Дубль: код уже принят в этой смене" },
          },
          {
            kind: "step",
            title: "«Ошибка» — код не принят",
            text: "Код не подходит смене: например, «Чужой товар: GTIN 04601234567022.» — код другого товара, или «Это GTIN товара, а не код маркировки.» — отсканирован штрихкод, а не код маркировки. Код не засчитан. Отложите единицу и сообщите мастеру.",
            image: { id: "scan-error", caption: "Ошибка: код чужого товара" },
          },
          {
            kind: "paragraph",
            text: "Кнопка «Вся история» открывает все сканы смены: время, оператор, позиция в коробе, результат и код; «К смене» возвращает к работе.",
          },
          {
            kind: "step",
            title: "Просмотрите историю при необходимости",
            text: "История показывается постранично: «Предыдущая страница» и «Следующая страница» листают её.",
            image: { id: "scan-history", caption: "История сканирований смены" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "В режиме «Проверка» коробов нет: каждый код проверяется и принимается без короба и паллеты, этикетки коробов не печатаются.",
          },
        ],
      },
      {
        id: "boxes",
        heading: "4. Короба",
        blocks: [
          {
            kind: "step",
            title: "Заполненный короб закрывается сам",
            text: "Когда в коробе набирается столько кодов, сколько задано в смене, станция сама закрывает короб, присваивает ему SSCC и отправляет этикетку на принтер. «Коробов закрыто» растёт, в «Последний короб» — SSCC нового короба, а открытый короб пуст до следующего кода: «Короб откроется с первым кодом». Наклейте этикетку на короб.",
            image: { id: "box-closed", caption: "Короб 12 из 12 закрыт, этикетка ушла на принтер" },
          },
          {
            kind: "step",
            title: "Неполный короб закройте кнопкой",
            text: "Если короб нужно закрыть раньше, нажмите «Закрыть короб». Станция спросит «Закрыть неполный короб?» и покажет, сколько в нём кодов. «Закрыть короб» закрывает его и печатает этикетку, «Продолжить сборку» возвращает к работе.",
            image: { id: "box-close-confirm", caption: "Подтверждение закрытия неполного короба" },
          },
          {
            kind: "step",
            title: "Если включена проверка этикетки — отсканируйте её",
            text: "Когда на станции включено «Проверять этикетку короба» (MKR-INS-04), после печати станция показывает «Проверьте этикетку» и ждёт скан SSCC с напечатанной этикетки. Пока этикетка не проверена, следующий код не принимается. Если отсканирована чужая этикетка, станция пишет «Это этикетка другого короба». «Напечатать снова» печатает этикетку ещё раз, «Пропустить проверку» продолжает работу без проверки.",
            image: {
              id: "print-check",
              caption: "Проверка этикетки: станция ждёт скан SSCC короба",
            },
          },
          {
            kind: "paragraph",
            text: "Номера SSCC выдаёт хост — заранее, блоками, поэтому короба закрываются и без связи с хостом, пока у станции есть запас номеров. Когда запас подходит к концу, в шапке появляется «Заканчиваются номера SSCC»: восстановите связь с хостом. Если номера кончились, станция пишет «Нет номеров SSCC: короб не закрыт».",
          },
          {
            kind: "paragraph",
            text: "Кнопки «Снять последний» и «Очистить короб» убирают коды из открытого короба; как ими пользоваться, описано в MKR-INS-03.",
          },
        ],
      },
      {
        id: "pallets",
        heading: "5. Паллеты",
        blocks: [
          {
            kind: "paragraph",
            text: "В смене «С паллетами» каждый закрытый короб встаёт на открытую паллету. Полоса под коробом показывает «Паллета N из M коробов», процент и сколько коробов осталось. Когда на паллету встаёт последний короб, станция закрывает паллету, присваивает ей SSCC и отправляет на принтер этикетку паллеты; следующий короб начинает новую паллету.",
          },
          {
            kind: "step",
            title: "Неполную паллету закройте досрочно",
            text: "Нажмите «Закрыть паллету досрочно». Станция спросит «Закрыть паллету досрочно?» и покажет, сколько на ней коробов. «Закрыть паллету» закрывает её с этими коробами и печатает этикетку, «Не закрывать» возвращает к работе.",
            image: {
              id: "pallet-close-confirm",
              caption: "Подтверждение досрочного закрытия паллеты",
            },
          },
        ],
      },
      {
        id: "offline",
        heading: "6. Работа без связи с хостом",
        blocks: [
          {
            kind: "step",
            title: "Продолжайте работу",
            text: "Если связь с хостом пропала, значок в шапке раскрывается в «Связи нет», а рядом появляется «Очередь N» — сколько записей ждёт отправки. Станция продолжает принимать коды и закрывать короба: записи хранятся на этом компьютере и уходят на хост сами, когда связь вернётся.",
            image: {
              id: "offline",
              caption: "Нет связи с хостом: скан принят, две записи в очереди",
            },
          },
          {
            kind: "paragraph",
            text: "Без связи нельзя создать новую смену, открыть смену, которую станция ещё не вела, присоединиться к чужой смене и искать коды для повторной печати. Не выключайте компьютер станции и не отвязывайте её, пока очередь не пуста.",
          },
          {
            kind: "step",
            title: "Проверьте синхронизацию",
            text: "Кнопка со стрелками в шапке открывает «Синхронизация»: состояние связи с хостом и время его последнего ответа, когда обновлялись справочники, сколько записей не отправлено и «Запас номеров SSCC». «Повторить сейчас» заставляет станцию снова обратиться к хосту, «Скопировать» копирует подробности для поддержки.",
            image: { id: "sync-panel", caption: "Синхронизация: всё в порядке" },
          },
          {
            kind: "step",
            title: "Посмотрите очередь отправки",
            text: "На экране «Смены линии» кнопка «Очередь отправки» показывает записи по группам: «Ждут отправки на хост», «Не приняты хостом», «Конфликты» и «Вытесненные коды». Записи, которые хост не принял, и конфликты разбирает администратор (MKR-INS-03).",
            image: {
              id: "queue-waiting",
              caption: "Очередь отправки: два скана ждут связи с хостом",
            },
          },
        ],
      },
      {
        id: "close",
        heading: "7. Выход из смены и закрытие смены",
        blocks: [
          {
            kind: "paragraph",
            text: "«Выйти из смены» возвращает к списку «Смены линии»: смена остаётся открытой, на её карточке — «Продолжить». Если работу продолжает другой оператор, нажмите в шапке «Сменить оператора» — смена тоже останется открытой.",
          },
          {
            kind: "step",
            title: "Закройте или очистите открытый короб",
            text: "Нажмите «Закрыть смену». Пока в открытом коробе есть коды, станция пишет «Смену пока не закрыть»: вернитесь «Назад к работе», закройте короб или очистите его в «Исключениях».",
            image: {
              id: "close-blocked",
              caption: "Смену пока не закрыть: в открытом коробе 5 кодов",
            },
          },
          {
            kind: "step",
            title: "Проверьте итоги и подтвердите закрытие",
            text: "Экран «Закрытие смены» показывает товар, «План», «Факт», «Отклонение», «Коробов закрыто» и «В среднем в коробе». Если факт не совпадает с планом, выберите причину. Если на паллете есть короба, станция предлагает закрыть её вместе со сменой — тогда кнопка называется «Закрыть паллету и смену», иначе «Подтвердить закрытие». Закрытие нельзя отменить: в смену больше нельзя сканировать.",
            image: {
              id: "close-shift",
              caption: "Закрытие смены: итоги, причина расхождения и открытая паллета",
            },
          },
          {
            kind: "step",
            title: "Дождитесь подтверждения",
            text: "Станция показывает «Смена … закрыта на этой станции» и итог: сколько принято и сколько коробов. Данные уходят на хост автоматически. «К списку смен» возвращает к списку.",
            image: { id: "close-done", caption: "Смена закрыта на этой станции" },
            expected: "Смена закрыта; выгрузки для ГИС МТ готовит офис (MKR-INS-09).",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Если смену ведут несколько станций, кнопка называется «Закрыть мою часть»: закрывается часть этой станции, а смена закроется, когда закроют остальные.",
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
                term: "Станция принимает каждый код как ошибку",
                detail:
                  "Проверьте, тот ли товар идёт на линии и та ли открыта смена: товар и GTIN смены видны на ленте вверху экрана.",
              },
              {
                term: "Короб не закрывается",
                detail:
                  "Если станция пишет «Нет номеров SSCC: короб не закрыт», ей нужна связь с хостом, чтобы получить новые номера. Позовите наладчика.",
              },
              {
                term: "Паллета заполнена, но не закрыта",
                detail:
                  "Номеров SSCC для паллет нет: паллета закроется, как только их пришлёт хост, а следующие короба встают на неё. Проверьте связь с хостом.",
              },
              {
                term: "Этикетка не напечаталась",
                detail: "Действия при сбое печати описаны в MKR-INS-03.",
              },
              {
                term: "Очередь отправки не уменьшается",
                detail:
                  "Проверьте связь в «Синхронизация» и нажмите «Повторить сейчас». Если связи нет долго, позовите наладчика.",
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
    title: "Station: work cycle — scanning, boxes and pallets",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Step-by-step guide for Markiro Autonom operators: the work screen and scan signals, closing boxes and pallets, the label check, working without a connection to the host, leaving and closing the shift.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the operator's work on an open shift of a Markiro Autonom station: scanning marking codes, filling and closing boxes, building pallets, working without a connection to the host and closing the shift. Signing in and opening a shift are covered in MKR-INS-01, exceptions in MKR-INS-03.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The station interface is in Russian only. Screen labels are quoted in Russian, with an English translation in brackets. The screenshots use demo data: product names, shift numbers and codes on your station will differ.",
          },
        ],
      },
      {
        id: "work-screen",
        heading: "2. The work screen",
        blocks: [
          {
            kind: "step",
            title: "What the work screen shows",
            text: "At the top is the shift band: the product, the shift number, the GTIN, the mode and the “Принято в смене” (Accepted in shift) counter with the plan. On the left is “Открытый короб” (Open box): a cell fills with every accepted code, and the top right shows how many codes the box holds out of how many. On the right are “Последний скан” (Last scan) with the result of the last scan, “Коробов закрыто” (Boxes closed) and the SSCC of “Последний короб” (Last box), and below them “История сканирований” (Scan history). On a shift with pallets the pallet strip is under the box. At the bottom are “Исключения” (Exceptions), “Выйти из смены” (Leave the shift) and “Закрыть смену” (Close the shift).",
            image: {
              id: "work-scan-wait",
              caption: "The work screen: 5 of 12 in the open box, the station waits for a scan",
            },
          },
          {
            kind: "paragraph",
            text: "The header carries icons for the host connection, the printer, the scanner and the send queue. While all is well they stay collapsed; a problem expands an icon into a caption, for example “Связи нет” (No connection), “Принтер: ошибка” (Printer: error) or “Очередь 2” (Queue 2).",
          },
        ],
      },
      {
        id: "scanning",
        heading: "3. Scanning and signals",
        blocks: [
          {
            kind: "paragraph",
            text: "Scan marking codes one at a time. The result of every scan appears under “Последний скан” (Last scan) and in the history; with sound on, the station also beeps (MKR-INS-04).",
          },
          {
            kind: "step",
            title: "“Принят” (Accepted) — the code is accepted",
            text: "The code is accepted into the shift and put into the open box: under the result you see “В коробе N из M.” (N of M in the box), a box cell is filled and “Принято в смене” (Accepted in shift) has grown by one. Scan the next unit.",
            image: { id: "scan-ok", caption: "Code accepted: 6 of 12 in the box" },
          },
          {
            kind: "step",
            title: "“Дубль” (Duplicate) — the code was accepted before",
            text: "The code has already been accepted — the station says when and, if in another shift, in which one. It is not counted again and does not go into the box. Set the unit aside and tell your supervisor.",
            image: {
              id: "scan-duplicate",
              caption: "Duplicate: the code is already accepted in this shift",
            },
          },
          {
            kind: "step",
            title: "“Ошибка” (Error) — the code is not accepted",
            text: "The code does not fit the shift: for example “Чужой товар: GTIN 04601234567022.” (Wrong product: GTIN 04601234567022) — a code of another product, or “Это GTIN товара, а не код маркировки.” (This is the product's GTIN, not a marking code) — a barcode was scanned instead of a marking code. The code is not counted. Set the unit aside and tell your supervisor.",
            image: { id: "scan-error", caption: "Error: a code of another product" },
          },
          {
            kind: "paragraph",
            text: "The “Вся история” (Full history) button opens every scan of the shift: the time, the operator, the position in the box, the result and the code; “К смене” (Back to the shift) returns to work.",
          },
          {
            kind: "step",
            title: "Look through the history when needed",
            text: "The history is shown page by page: “Предыдущая страница” (Previous page) and “Следующая страница” (Next page) turn the pages.",
            image: { id: "scan-history", caption: "The shift's scan history" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "In “Проверка” (Validation) mode there are no boxes: every code is checked and accepted without a box or a pallet, and no box labels are printed.",
          },
        ],
      },
      {
        id: "boxes",
        heading: "4. Boxes",
        blocks: [
          {
            kind: "step",
            title: "A full box closes by itself",
            text: "When the box holds as many codes as the shift sets, the station closes the box itself, gives it an SSCC and sends the label to the printer. “Коробов закрыто” (Boxes closed) grows, “Последний короб” (Last box) shows the new box's SSCC, and the open box is empty until the next code: “Короб откроется с первым кодом” (The box opens with the first code). Stick the label on the box.",
            image: {
              id: "box-closed",
              caption: "Box 12 of 12 closed, its label sent to the printer",
            },
          },
          {
            kind: "step",
            title: "Close an incomplete box with the button",
            text: "To close a box early, tap “Закрыть короб” (Close box). The station asks “Закрыть неполный короб?” (Close an incomplete box?) and shows how many codes it holds. “Закрыть короб” (Close box) closes it and prints the label, “Продолжить сборку” (Keep filling) returns to work.",
            image: {
              id: "box-close-confirm",
              caption: "Confirming the close of an incomplete box",
            },
          },
          {
            kind: "step",
            title: "If the label check is on, scan the label",
            text: "When “Проверять этикетку короба” (Check the box label) is on at the station (MKR-INS-04), after printing the station shows “Проверьте этикетку” (Check the label) and waits for a scan of the SSCC on the printed label. The next code is not accepted until the label is checked. If another label is scanned, the station says “Это этикетка другого короба” (This is another box's label). “Напечатать снова” (Print again) prints the label once more, “Пропустить проверку” (Skip the check) goes on without the check.",
            image: {
              id: "print-check",
              caption: "Label check: the station waits for a scan of the box SSCC",
            },
          },
          {
            kind: "paragraph",
            text: "SSCC numbers come from the host in advance, in blocks, so boxes close even without a connection to the host while the station has numbers in stock. When the stock runs low, the header shows “Заканчиваются номера SSCC” (SSCC numbers running out): restore the connection to the host. When the numbers are gone, the station says “Нет номеров SSCC: короб не закрыт” (No SSCC numbers: the box is not closed).",
          },
          {
            kind: "paragraph",
            text: "The “Снять последний” (Remove last) and “Очистить короб” (Clear box) buttons take codes out of the open box; how to use them is covered in MKR-INS-03.",
          },
        ],
      },
      {
        id: "pallets",
        heading: "5. Pallets",
        blocks: [
          {
            kind: "paragraph",
            text: "On a “С паллетами” (With pallets) shift every closed box goes onto the open pallet. The strip under the box shows “Паллета N из M коробов” (Pallet: N of M boxes), a percentage and how many boxes are left. When the last box goes onto the pallet, the station closes the pallet, gives it an SSCC and sends the pallet label to the printer; the next box starts a new pallet.",
          },
          {
            kind: "step",
            title: "Close an incomplete pallet early",
            text: "Tap “Закрыть паллету досрочно” (Close the pallet early). The station asks “Закрыть паллету досрочно?” (Close the pallet early?) and shows how many boxes are on it. “Закрыть паллету” (Close the pallet) closes it with these boxes and prints the label, “Не закрывать” (Do not close) returns to work.",
            image: {
              id: "pallet-close-confirm",
              caption: "Confirming the early close of a pallet",
            },
          },
        ],
      },
      {
        id: "offline",
        heading: "6. Working without a connection to the host",
        blocks: [
          {
            kind: "step",
            title: "Keep working",
            text: "If the connection to the host is lost, the header icon expands into “Связи нет” (No connection), and “Очередь N” (Queue N) appears next to it — how many records wait to be sent. The station keeps accepting codes and closing boxes: the records stay on this computer and go to the host by themselves when the connection is back.",
            image: {
              id: "offline",
              caption: "No connection to the host: the scan is accepted, two records are queued",
            },
          },
          {
            kind: "paragraph",
            text: "Without a connection you cannot create a new shift, open a shift the station has not run before, join another station's shift or look up codes for a reprint. Do not switch off the station's computer and do not unpair the station while the queue is not empty.",
          },
          {
            kind: "step",
            title: "Check the sync",
            text: "The arrows button in the header opens “Синхронизация” (Sync): the state of the host connection and the time of its last answer, when reference data was last updated, how many records are unsent and “Запас номеров SSCC” (SSCC number stock). “Повторить сейчас” (Retry now) makes the station contact the host again, “Скопировать” (Copy) copies the details for support.",
            image: { id: "sync-panel", caption: "Sync: all is well" },
          },
          {
            kind: "step",
            title: "Look at the send queue",
            text: "On the “Смены линии” (Line shifts) screen the “Очередь отправки” (Send queue) button shows the records by group: “Ждут отправки на хост” (Waiting to be sent to the host), “Не приняты хостом” (Not accepted by the host), “Конфликты” (Conflicts) and “Вытесненные коды” (Displaced codes). Records the host did not accept and conflicts are resolved by an administrator (MKR-INS-03).",
            image: {
              id: "queue-waiting",
              caption: "Send queue: two scans wait for the host connection",
            },
          },
        ],
      },
      {
        id: "close",
        heading: "7. Leaving and closing the shift",
        blocks: [
          {
            kind: "paragraph",
            text: "“Выйти из смены” (Leave the shift) returns to the “Смены линии” (Line shifts) list: the shift stays open and its card reads “Продолжить” (Continue). If another operator takes over, tap “Сменить оператора” (Change operator) in the header — the shift stays open as well.",
          },
          {
            kind: "step",
            title: "Close or clear the open box",
            text: "Tap “Закрыть смену” (Close the shift). While the open box holds codes, the station says “Смену пока не закрыть” (The shift cannot be closed yet): go “Назад к работе” (Back to work), close the box or clear it under “Исключения” (Exceptions).",
            image: {
              id: "close-blocked",
              caption: "The shift cannot be closed yet: 5 codes in the open box",
            },
          },
          {
            kind: "step",
            title: "Check the totals and confirm the close",
            text: "The “Закрытие смены” (Closing the shift) screen shows the product, “План” (Plan), “Факт” (Actual), “Отклонение” (Deviation), “Коробов закрыто” (Boxes closed) and “В среднем в коробе” (Average per box). If the actual output differs from the plan, choose a reason. If the pallet holds boxes, the station offers to close it with the shift — the button then reads “Закрыть паллету и смену” (Close the pallet and the shift), otherwise “Подтвердить закрытие” (Confirm the close). The close cannot be undone: nothing more can be scanned into the shift.",
            image: {
              id: "close-shift",
              caption:
                "Closing the shift: totals, the reason for the deviation and the open pallet",
            },
          },
          {
            kind: "step",
            title: "Wait for the confirmation",
            text: "The station shows “Смена … закрыта на этой станции” (Shift … is closed on this station) and the totals: how much was accepted and how many boxes. The data goes to the host automatically. “К списку смен” (To the shift list) returns to the list.",
            image: { id: "close-done", caption: "The shift is closed on this station" },
            expected: "The shift is closed; the office prepares the GIS MT exports (MKR-INS-09).",
          },
          {
            kind: "callout",
            tone: "info",
            text: "When several stations run the shift, the button reads “Закрыть мою часть” (Close my part): this station's part closes, and the shift closes once the others have closed theirs.",
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
                term: "The station rejects every code",
                detail:
                  "Check that the right product is on the line and the right shift is open: the shift's product and GTIN are on the band at the top of the screen.",
              },
              {
                term: "A box does not close",
                detail:
                  "If the station says “Нет номеров SSCC: короб не закрыт” (No SSCC numbers: the box is not closed), it needs a connection to the host to get new numbers. Call a technician.",
              },
              {
                term: "The pallet is full but not closed",
                detail:
                  "There are no SSCC numbers for pallets: the pallet closes as soon as the host sends them, and the next boxes go onto it. Check the connection to the host.",
              },
              {
                term: "The label did not print",
                detail: "What to do when printing fails is covered in MKR-INS-03.",
              },
              {
                term: "The send queue does not shrink",
                detail:
                  "Check the connection under “Синхронизация” (Sync) and tap “Повторить сейчас” (Retry now). If the connection stays down, call a technician.",
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
