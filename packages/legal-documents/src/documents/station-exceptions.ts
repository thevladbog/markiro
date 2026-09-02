import type { LegalDocumentSource } from "../types.js";

export const STATION_EXCEPTIONS_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: исключения и восстановление",
    summary:
      "Пошаговая инструкция оператора для нештатных ситуаций: перепечатка этикетки, расформирование короба, сбой печати, коды, занятые другим терминалом.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает действия оператора в нештатных ситуациях: испорченная или потерянная этикетка короба, короб собран с ошибкой, принтер не напечатал этикетку, станция показывает коды, занятые другим терминалом. Вход на станцию описан в инструкции MKR-INS-01, штатный рабочий цикл — в MKR-INS-02.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Номера коробов и продукты на вашей станции будут отличаться.",
          },
        ],
      },
      {
        id: "exceptions-screen",
        heading: "2. Экран «Исключения»",
        blocks: [
          {
            kind: "step",
            title: "Откройте экран «Исключения»",
            text: "Нажмите кнопку «Исключения» на рабочем экране. Станция покажет действия над закрытыми коробами этой смены: «Перепечатать этикетку» и «Расформировать короб». Кнопка «Вернуться к работе» в любой момент возвращает к сканированию.",
            image: { id: "exception-action", caption: "Экран «Исключения»: выбор действия" },
          },
        ],
      },
      {
        id: "reprint",
        heading: "3. Перепечатка этикетки короба",
        blocks: [
          {
            kind: "paragraph",
            text: "Перепечатывайте этикетку, если она повреждена, не читается сканером, испорчена принтером или её запросил контроль качества. Содержимое короба и его номер SSCC не меняются — печатается та же этикетка.",
          },
          {
            kind: "step",
            title: "Укажите короб",
            text: "Выберите «Перепечатать этикетку». Станция попросит указать закрытый короб: отсканируйте его этикетку или выберите короб из списка (номер SSCC и число позиций).",
            image: {
              id: "exception-target",
              caption: "Выбор закрытого короба: сканом этикетки или из списка",
            },
            expected: "Станция показала справочник причин.",
          },
          {
            kind: "step",
            title: "Выберите причину и подтвердите",
            text: "Укажите причину из списка: «Этикетка повреждена», «Этикетка не читается», «Замятие принтера / нет печати», «Запрос контроля качества» или «Другая причина». Затем подтвердите действие кнопкой «Подтвердить перепечатку».",
            image: { id: "exception-reason", caption: "Справочник причин перепечатки" },
            expected: "Принтер напечатал этикетку, станция показала «Действие выполнено».",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Старую этикетку снимите и уничтожьте. На коробе должна остаться ровно одна этикетка — два одинаковых SSCC в обороте недопустимы.",
          },
        ],
      },
      {
        id: "disassemble",
        heading: "4. Расформирование короба",
        blocks: [
          {
            kind: "paragraph",
            text: "Расформируйте короб, если он собран с ошибкой: неверный товар, неверное количество, повреждена упаковка или короб отклонён контролем качества. Причину вы выберете из справочника на экране; для нетипового случая есть «Другая причина».",
          },
          {
            kind: "step",
            title: "Выберите короб и причину",
            text: "На экране «Исключения» выберите «Расформировать короб», укажите закрытый короб (сканом этикетки или из списка) и причину.",
            expected: "Станция показала экран подтверждения.",
          },
          {
            kind: "step",
            title: "Подтвердите необратимое действие",
            text: "Станция предупредит: «Действие необратимо» — номер короба будет аннулирован навсегда. Проверьте, что выбран нужный короб, и нажмите «Расформировать безвозвратно».",
            image: { id: "exception-confirm", caption: "Двойное подтверждение расформирования" },
            expected: "Станция показала «Действие выполнено», короб пропал из списка закрытых.",
          },
          {
            kind: "step",
            title: "Переупакуйте единицы",
            text: "Единицы из расформированного короба остаются проверенными — заново отсканируйте их в новый короб обычным рабочим циклом. Новый короб получит новый номер SSCC; этикетку расформированного короба уничтожьте.",
            image: { id: "exception-result", caption: "Результат действия" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Аннулированный SSCC нельзя использовать повторно, а расформирование нельзя отменить. Если короб расформирован по ошибке — сообщите мастеру и соберите содержимое в новый короб.",
          },
        ],
      },
      {
        id: "box-print-recovery",
        heading: "5. Сбой печати при закрытии короба",
        blocks: [
          {
            kind: "step",
            title: "Экран «Этикетка короба не напечатана»",
            text: "Если при закрытии короба принтер не сработал, станция показывает экран восстановления с причиной: проблема печати, для смены не выбран шаблон этикетки или этикетку не удалось подготовить. Устраните причину (проверьте ленту и замятие принтера) и нажмите «Повторить печать».",
            image: {
              id: "box-print-failed",
              caption: "Восстановление печати этикетки короба",
            },
            expected: "Принтер напечатал этикетку, работа продолжилась.",
          },
          {
            kind: "step",
            title: "Крайний случай — «Продолжить без этикетки»",
            text: "Если печать сейчас невозможна, нажмите «Продолжить без этикетки» и подтвердите. Короб уже закрыт и учтён — его нужно будет промаркировать этикеткой позже через перепечатку (раздел 3). Пометьте такой короб, чтобы не потерять его.",
          },
          {
            kind: "step",
            title: "Если сверка не проходит",
            text: "При сверке напечатанной этикетки сканируйте именно код SSCC с этикетки этого короба. «Это другая этикетка» — в руках этикетка от другого короба: найдите правильную или нажмите «Печатать заново». «Это не групповой код» — отсканирован код маркировки единицы, а не этикетка короба.",
            image: {
              id: "print-mismatch",
              caption: "Сверка печати: в руках этикетка другого короба",
            },
          },
        ],
      },
      {
        id: "conflicts",
        heading: "6. Коды, занятые другим терминалом",
        blocks: [
          {
            kind: "paragraph",
            text: "Если один и тот же код прошёл через две станции, код закрепляется за терминалом, отсканировавшим его раньше. На проигравшей станции такой код попадает в список расхождений, а счётчик «Дубли» в строке состояния растёт. Это не авария и не ошибка оператора.",
          },
          {
            kind: "step",
            title: "Посмотрите список расхождений",
            text: "Откройте «Дубли кодов» с рабочего экрана. Для каждой позиции указано, за каким терминалом закреплён код и когда: «Закреплён за … в …».",
            image: { id: "conflicts", caption: "Список кодов, занятых другим терминалом" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Не сканируйте такие коды повторно. Продолжайте работу — расхождение проверит менеджер в кабинете.",
          },
        ],
      },
      {
        id: "hardware",
        heading: "7. Оборудование посреди смены",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "Сканер показывает «Нет связи» — остановите работу, проверьте кабель сканера. Если связь не вернулась, позовите наладчика.",
              "Принтер не печатает — станция сама покажет экран восстановления при закрытии короба (раздел 5). Проверьте ленту, питание и кабель принтера.",
              "Строка состояния показывает «Не настроено» у сканера или принтера — рабочее место не настроено до конца, работать нельзя, позовите наладчика.",
            ],
          },
          {
            kind: "paragraph",
            text: "Подключение и настройка оборудования — задача наладчика и описаны в отдельной инструкции по настройке рабочего места.",
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
                term: "После перепечатки на руках две этикетки",
                detail:
                  "На коробе остаётся новая, старую уничтожьте. Обе несут один SSCC — в обороте должна быть одна.",
              },
              {
                term: "Расформировал не тот короб",
                detail:
                  "Отменить нельзя. Сообщите мастеру, соберите содержимое в новый короб обычным циклом — станция выдаст новый SSCC.",
              },
              {
                term: "Короб не находится сканом на экране выбора",
                detail:
                  "«Короб не найден среди закрытых коробов этой смены» — этикетка от короба другой смены или станции. Выберите короб из списка или обратитесь к мастеру.",
              },
              {
                term: "Счётчик «Дубли» вырос",
                detail:
                  "Это список кодов, занятых другим терминалом (раздел 6). Работу не останавливайте, повторно не сканируйте.",
              },
              {
                term: "Закрыл короб без этикетки и забыл какой",
                detail:
                  "Откройте «Исключения» → «Перепечатать этикетку»: в списке видны все закрытые короба этой смены с числом позиций.",
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
    title: "Scanning station: exceptions and recovery",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Step-by-step operator guide for unusual situations: reprinting a label, disassembling a box, print failures, and codes kept by another terminal.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the operator's actions in unusual situations: a damaged or lost box label, a box assembled by mistake, a printer that did not print the label, or the station showing codes kept by another terminal. Signing in is covered by instruction MKR-INS-01, the normal work cycle by MKR-INS-02.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots use demo data. Box numbers and products on your station will differ.",
          },
        ],
      },
      {
        id: "exceptions-screen",
        heading: "2. The “Exceptions” screen",
        blocks: [
          {
            kind: "step",
            title: "Open the “Exceptions” screen",
            text: "Tap the “Exceptions” button on the work screen. The station shows the actions available for this shift's closed boxes: “Reprint label” and “Disassemble box”. The “Back to work” button returns to scanning at any moment.",
            image: { id: "exception-action", caption: "The “Exceptions” screen: choosing an action" },
          },
        ],
      },
      {
        id: "reprint",
        heading: "3. Reprinting a box label",
        blocks: [
          {
            kind: "paragraph",
            text: "Reprint the label when it is damaged, cannot be read by the scanner, was spoiled by the printer, or quality control asked for it. The box contents and its SSCC number do not change — the same label is printed again.",
          },
          {
            kind: "step",
            title: "Point at the box",
            text: "Choose “Reprint label”. The station asks you to identify the closed box: scan its label or pick the box from the list (SSCC number and item count).",
            image: {
              id: "exception-target",
              caption: "Choosing a closed box: by scanning its label or from the list",
            },
            expected: "The station showed the reason catalog.",
          },
          {
            kind: "step",
            title: "Choose a reason and confirm",
            text: "Pick a reason from the list: “Damaged label”, “Unreadable label”, “Printer jam / no output”, “Quality-control request” or “Other reason”. Then confirm with the “Confirm reprint” button.",
            image: { id: "exception-reason", caption: "The reprint reason catalog" },
            expected: "The printer printed the label and the station showed “Action completed”.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Remove and destroy the old label. Exactly one label must remain on the box — two identical SSCCs in circulation are not allowed.",
          },
        ],
      },
      {
        id: "disassemble",
        heading: "4. Disassembling a box",
        blocks: [
          {
            kind: "paragraph",
            text: "Disassemble a box when it was assembled by mistake: wrong product, wrong quantity, damaged packaging, or the box was rejected by quality control. You pick the reason from the on-screen catalog; for anything unusual there is “Other reason”.",
          },
          {
            kind: "step",
            title: "Choose the box and the reason",
            text: "On the “Exceptions” screen choose “Disassemble box”, identify the closed box (by scanning its label or from the list) and pick the reason.",
            expected: "The station showed the confirmation screen.",
          },
          {
            kind: "step",
            title: "Confirm the irreversible action",
            text: "The station warns: “This cannot be undone” — the box number will be voided forever. Check that the right box is selected and tap “Disassemble permanently”.",
            image: { id: "exception-confirm", caption: "Double confirmation of the disassembly" },
            expected: "The station showed “Action completed” and the box disappeared from the closed list.",
          },
          {
            kind: "step",
            title: "Repack the units",
            text: "Units from the disassembled box remain verified — scan them into a new box using the normal work cycle. The new box gets a new SSCC number; destroy the disassembled box's label.",
            image: { id: "exception-result", caption: "The action result" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "A voided SSCC cannot be reused, and a disassembly cannot be undone. If a box was disassembled by mistake, tell your supervisor and pack its contents into a new box.",
          },
        ],
      },
      {
        id: "box-print-recovery",
        heading: "5. A print failure while closing a box",
        blocks: [
          {
            kind: "step",
            title: "The “The box label was not printed” screen",
            text: "If the printer fails while a box is being closed, the station shows a recovery screen with the cause: a printing problem, no label template selected for the shift, or the label could not be prepared. Fix the cause (check the ribbon and for a printer jam) and tap “Retry printing”.",
            image: {
              id: "box-print-failed",
              caption: "Recovering the box label print",
            },
            expected: "The printer printed the label and work continued.",
          },
          {
            kind: "step",
            title: "The last resort — “Continue without a label”",
            text: "If printing is impossible right now, tap “Continue without a label” and confirm. The box is already closed and recorded — it will need to be labelled later through a reprint (section 3). Mark such a box so it does not get lost.",
          },
          {
            kind: "step",
            title: "If the verification does not pass",
            text: "During printed-label verification, scan the SSCC code from this box's label specifically. “This is a different label” — you are holding a label from another box: find the right one or tap “Print again”. “This is not a group code” — you scanned a unit's marking code, not a box label.",
            image: {
              id: "print-mismatch",
              caption: "Print verification: the label in hand is from another box",
            },
          },
        ],
      },
      {
        id: "conflicts",
        heading: "6. Codes kept by another terminal",
        blocks: [
          {
            kind: "paragraph",
            text: "If the same code passed through two stations, the code is kept by the terminal that scanned it first. On the losing station the code goes into the discrepancy list, and the “Conflicts” counter in the status bar grows. This is not an emergency and not an operator error.",
          },
          {
            kind: "step",
            title: "Review the discrepancy list",
            text: "Open “Conflicts” from the work screen. Each entry shows which terminal keeps the code and when: “Kept by … at …”.",
            image: { id: "conflicts", caption: "The list of codes kept by another terminal" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Do not rescan these codes. Keep working — a manager will review the discrepancy in the cabinet.",
          },
        ],
      },
      {
        id: "hardware",
        heading: "7. Hardware in the middle of a shift",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "The scanner shows “No connection” — stop working and check the scanner cable. If the connection does not come back, call a technician.",
              "The printer does not print — the station itself shows the recovery screen when a box is closed (section 5). Check the printer's ribbon, power and cable.",
              "The status bar shows “Not configured” for the scanner or the printer — the workstation setup is incomplete, work must not continue; call a technician.",
            ],
          },
          {
            kind: "paragraph",
            text: "Connecting and configuring the hardware is the technician's job and is covered by the separate workstation setup instruction.",
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
                term: "Two labels in hand after a reprint",
                detail:
                  "The new one stays on the box; destroy the old one. Both carry the same SSCC — only one may be in circulation.",
              },
              {
                term: "Disassembled the wrong box",
                detail:
                  "It cannot be undone. Tell your supervisor and pack the contents into a new box using the normal cycle — the station issues a new SSCC.",
              },
              {
                term: "A box cannot be found by scanning on the selection screen",
                detail:
                  "“This box is not among this shift's closed boxes” — the label belongs to a box from another shift or station. Pick the box from the list or ask your supervisor.",
              },
              {
                term: "The “Conflicts” counter grew",
                detail:
                  "This is the list of codes kept by another terminal (section 6). Do not stop working and do not rescan them.",
              },
              {
                term: "Closed a box without a label and forgot which one",
                detail:
                  "Open “Exceptions” → “Reprint label”: the list shows all of this shift's closed boxes with their item counts.",
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
