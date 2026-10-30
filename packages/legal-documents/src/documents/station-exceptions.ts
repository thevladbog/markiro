import type { LegalDocumentSource } from "../types.js";

export const STATION_EXCEPTIONS_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция: исключения и восстановление",
    summary:
      "Пошаговая инструкция оператора Маркиро Автоном для нештатных ситуаций: снятие кодов из короба, перепечатка этикетки, расформирование короба и паллеты, сбой печати и повторная печать этикеток любых смен.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает, что делать оператору станции Маркиро Автоном, когда работа идёт не по плану: в короб попал лишний код, этикетка испорчена, короб или паллету нужно расформировать, принтер не напечатал этикетку, этикетку нужно напечатать снова для уже закрытой смены. Обычный рабочий цикл описан в MKR-INS-02.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Номера SSCC, смены и товары на вашей станции будут другими.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Каждое исключение записывается с вашим именем и причиной и уходит на хост. Расформирование нельзя отменить: перед подтверждением проверьте номер короба или паллеты.",
          },
        ],
      },
      {
        id: "menu",
        heading: "2. Экран «Исключения»",
        blocks: [
          {
            kind: "step",
            title: "Откройте «Исключения»",
            text: "На рабочем экране нажмите «Исключения». Станция спросит «Что нужно сделать?» и предложит действия: «Снять последний код», «Очистить короб», «Перепечатать этикетку», «Расформировать короб», «Перепечатать этикетку паллеты» и «Расформировать паллету». Недоступные сейчас действия серые: например, действий с паллетами нет, пока в смене нет закрытых паллет. «Назад» возвращает к работе.",
            image: { id: "exceptions", caption: "Исключения: что нужно сделать" },
          },
        ],
      },
      {
        id: "open-box",
        heading: "3. Открытый короб",
        blocks: [
          {
            kind: "paragraph",
            text: "«Снять последний код» убирает из открытого короба последний принятый код — станция пишет «Последний код снят из короба.». Если сняли по ошибке, отсканируйте этот код снова. Кнопка «Снять последний» на рабочем экране делает то же самое.",
          },
          {
            kind: "step",
            title: "Очистите короб, если его нужно собрать заново",
            text: "«Очистить короб» на рабочем экране или в «Исключениях» спрашивает «Очистить короб?»: из открытого короба уйдут все коды, их можно будет отсканировать снова. Нажмите «Очистить короб» для подтверждения или «Назад».",
            image: { id: "exception-clear", caption: "Подтверждение очистки открытого короба" },
          },
        ],
      },
      {
        id: "closed-box",
        heading: "4. Закрытый короб: перепечатка и расформирование",
        blocks: [
          {
            kind: "step",
            title: "Выберите короб",
            text: "Нажмите «Перепечатать этикетку» или «Расформировать короб». Отсканируйте этикетку короба или наберите на клавиатуре последние цифры его SSCC; пока цифры не набраны, справа показаны последние закрытые короба смены. Нажмите нужный короб.",
            image: {
              id: "exception-target",
              caption: "Выбор короба по SSCC: последние закрытые короба",
            },
          },
          {
            kind: "step",
            title: "Укажите причину",
            text: "Для перепечатки — «Этикетка повреждена», «Этикетка не читается», «Замятие в принтере», «Требование контроля качества» или «Другая причина». Для расформирования — «Не тот товар», «Неверное количество», «Повреждена упаковка», «Брак по качеству» или «Другая причина». После «Другая причина» станция предложит описать причину своими словами — это необязательно.",
            image: { id: "exception-reason", caption: "Причина перепечатки этикетки короба" },
          },
          {
            kind: "step",
            title: "Подтвердите действие",
            text: "Станция покажет, что произойдёт. Перепечатка: новая этикетка будет с тем же SSCC — на коробе должна остаться одна. Расформирование: SSCC короба больше не будет использован, коды короба снова станут свободны, отменить это нельзя — снимите этикетку с короба. Нажмите «Перепечатать» или «Расформировать», либо «Назад».",
            image: { id: "exception-confirm", caption: "Подтверждение расформирования короба" },
          },
          {
            kind: "step",
            title: "Проверьте результат",
            text: "Станция сообщит результат, например «Этикетка отправлена на принтер.». «Вернуться к работе» возвращает к рабочему экрану, «Другое действие» — к списку исключений.",
            image: {
              id: "exception-result",
              caption: "Исключение выполнено: этикетка отправлена на принтер",
            },
            expected: "Исключение записано; коды расформированного короба можно сканировать снова.",
          },
        ],
      },
      {
        id: "pallets",
        heading: "5. Паллеты",
        blocks: [
          {
            kind: "step",
            title: "Перепечатка и расформирование паллеты",
            text: "«Перепечатать этикетку паллеты» и «Расформировать паллету» работают так же, как с коробом: отсканируйте этикетку паллеты или наберите последние цифры её SSCC, выберите паллету, укажите причину и подтвердите. При расформировании SSCC паллеты больше не используется, а её короба остаются закрытыми, со своими кодами. Снимите с паллеты её этикетку.",
            image: { id: "pallet-exceptions", caption: "Выбор паллеты для расформирования" },
          },
        ],
      },
      {
        id: "print-failure",
        heading: "6. Сбой печати",
        blocks: [
          {
            kind: "step",
            title: "Этикетка не напечатана",
            text: "Если принтер не принял задание, станция показывает «Этикетка короба не напечатана», а в шапке — «Принтер: ошибка». Работа на станции остановлена, пока вы не решите, что делать с этикеткой. Проверьте принтер — питание, бумагу, кабель или сеть — и нажмите «Напечатать снова». «Другой принтер» отправляет этикетку на другой принтер рабочего места, «Настроить принтер» открывает настройку принтеров (MKR-INS-04).",
            image: {
              id: "print-failed",
              caption: "Этикетка короба не напечатана: принтер не принял задание",
            },
          },
          {
            kind: "step",
            title: "Неизвестно, напечаталась ли этикетка",
            text: "Если связь с принтером оборвалась посреди передачи, станция не знает, вышла ли этикетка, и показывает «Неизвестно, напечаталась ли этикетка». Посмотрите на принтер. При печати через драйвер Windows сначала нажмите «Проверить очередь Windows» и проверьте очередь принтера в Windows: старое задание ещё может напечататься. Отсутствие задания в очереди не подтверждает выход этикетки. Если этикетка вышла, нажмите «Этикетка напечаталась»; если нет — «Напечатать снова». Не печатайте вторую этикетку, если первая вышла: на коробе должна быть одна.",
            image: { id: "print-unknown", caption: "Станция просит проверить, вышла ли этикетка" },
          },
          {
            kind: "paragraph",
            text: "«Продолжить без этикетки» продолжает работу, когда принтер починить сразу нельзя. Станция переспросит «Продолжить без этикетки?»: короб уже закрыт, и его нужно будет промаркировать позже — напечатать этикетку снова можно в «Исключениях». Для паллеты всё так же.",
          },
        ],
      },
      {
        id: "reprint",
        heading: "7. Повторная печать этикеток",
        blocks: [
          {
            kind: "paragraph",
            text: "Если этикетку нужно напечатать снова для короба, паллеты или единицы продукции из любой смены и с любой станции — например, на складе, — используйте «Повторная печать этикеток» на экране «Смены линии». Перепечатка не создаёт новых кодов, коробов и паллет и не меняет количество продукции. Искать коды можно только при связи с хостом.",
          },
          {
            kind: "step",
            title: "Подготовьте сеанс перепечатки",
            text: "Выберите причину перепечатки: «Не напечаталась», «Повреждена» или «Утеряна» — она действует на все этикетки сеанса. При необходимости включите «Проверка распечатки повторным сканированием». В блоке «Что и на чём печатаем» проверьте шаблоны и принтеры для коробов, паллет, кодов единиц и листов А4; «Изменить» меняет их. Нажмите «Начать перепечатку».",
            image: {
              id: "reprint-setup",
              caption: "Повторная печать этикеток: причина и что на чём печатается",
            },
          },
          {
            kind: "step",
            title: "Отсканируйте этикетку",
            text: "Отсканируйте код единицы, короба или паллеты — или нажмите «Ввести код вручную». Станция найдёт код на хосте, покажет, что это за короб или паллета, и отправит одну новую этикетку на принтер: «Этикетка передана на принтер». «Следующий код» — к следующей этикетке, «Напечатать ещё раз» — ещё одна этикетка того же кода с новой причиной.",
            image: { id: "reprint-session", caption: "Найден короб, этикетка передана на принтер" },
          },
          {
            kind: "paragraph",
            text: "Закончив, нажмите «Завершить сеанс» и подтвердите: записи сеанса уйдут на хост. «К сменам» возвращает к списку смен, не завершая сеанс, — его можно продолжить позже.",
          },
        ],
      },
      {
        id: "queue",
        heading: "8. Записи, не принятые хостом",
        blocks: [
          {
            kind: "paragraph",
            text: "Если хост отклонил запись станции или она конфликтует с записью другой станции, это видно в «Синхронизация» и на экране «Очередь отправки» (MKR-INS-02) в разделах «Не приняты хостом», «Конфликты» и «Вытесненные коды». Сами такие записи не исчезнут: сообщите администратору.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "9. Частые проблемы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Короба нет в списке",
                detail:
                  "В списке — только закрытые короба текущей смены. Наберите больше цифр SSCC или отсканируйте этикетку. Короб из другой смены перепечатывают через «Повторная печать этикеток».",
              },
              {
                term: "Исключение не выполнено",
                detail:
                  "Станция объясняет причину: например, этикетка короба ещё ждёт решения на рабочем экране или короб изменился, пока вы выбирали. Решите этикетку и повторите.",
              },
              {
                term: "Перепечатать нельзя, шаблон обновили",
                detail:
                  "Шаблон этикетки обновили после её печати: перепечатать эту этикетку на рабочем экране нельзя. Используйте «Повторная печать этикеток» или обратитесь к администратору.",
              },
              {
                term: "Принтер продолжает отказывать",
                detail:
                  "Проверьте адрес и настройку принтера в «Рабочее место» (MKR-INS-04) или позовите наладчика.",
              },
              {
                term: "Повторная печать не находит код",
                detail:
                  "Нет связи с хостом: найти код нельзя. Начатую печать решить можно; поиск вернётся вместе со связью.",
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
    title: "Station: exceptions and recovery",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Step-by-step guide for Markiro Autonom operators for exceptions: removing codes from a box, reprinting a label, disassembling a box or a pallet, print failures, and reprinting labels of any shift.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers what a Markiro Autonom station operator does when work does not go to plan: a wrong code got into a box, a label is spoiled, a box or a pallet has to be disassembled, the printer did not print a label, or a label has to be printed again for a shift that is already closed. The normal work cycle is covered in MKR-INS-02.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The station interface is in Russian only. Screen labels are quoted in Russian, with an English translation in brackets. The screenshots use demo data: SSCC numbers, shifts and products on your station will differ.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Every exception is recorded with your name and the reason and goes to the host. A disassembly cannot be undone: check the box or pallet number before you confirm.",
          },
        ],
      },
      {
        id: "menu",
        heading: "2. The “Исключения” (Exceptions) screen",
        blocks: [
          {
            kind: "step",
            title: "Open “Исключения” (Exceptions)",
            text: "On the work screen tap “Исключения” (Exceptions). The station asks “Что нужно сделать?” (What needs to be done?) and offers: “Снять последний код” (Remove the last code), “Очистить короб” (Clear the box), “Перепечатать этикетку” (Reprint the label), “Расформировать короб” (Disassemble a box), “Перепечатать этикетку паллеты” (Reprint a pallet label) and “Расформировать паллету” (Disassemble a pallet). Actions not available right now are grey: for example, there are no pallet actions until the shift has a closed pallet. “Назад” (Back) returns to work.",
            image: { id: "exceptions", caption: "Exceptions: what needs to be done" },
          },
        ],
      },
      {
        id: "open-box",
        heading: "3. The open box",
        blocks: [
          {
            kind: "paragraph",
            text: "“Снять последний код” (Remove the last code) takes the last accepted code out of the open box — the station says “Последний код снят из короба.” (The last code was removed from the box). If you removed it by mistake, scan the code again. The “Снять последний” (Remove last) button on the work screen does the same.",
          },
          {
            kind: "step",
            title: "Clear the box if it has to be packed again",
            text: "“Очистить короб” (Clear the box) on the work screen or under “Исключения” (Exceptions) asks “Очистить короб?” (Clear the box?): every code leaves the open box and can be scanned again. Tap “Очистить короб” (Clear the box) to confirm, or “Назад” (Back).",
            image: { id: "exception-clear", caption: "Confirming the clearing of the open box" },
          },
        ],
      },
      {
        id: "closed-box",
        heading: "4. A closed box: reprint and disassembly",
        blocks: [
          {
            kind: "step",
            title: "Choose the box",
            text: "Tap “Перепечатать этикетку” (Reprint the label) or “Расформировать короб” (Disassemble a box). Scan the box label or type the last digits of its SSCC on the keypad; until you type digits, the last closed boxes of the shift are listed on the right. Tap the box.",
            image: {
              id: "exception-target",
              caption: "Choosing a box by its SSCC: the last closed boxes",
            },
          },
          {
            kind: "step",
            title: "Give the reason",
            text: "For a reprint: “Этикетка повреждена” (Label damaged), “Этикетка не читается” (Label unreadable), “Замятие в принтере” (Printer jam), “Требование контроля качества” (Quality control request) or “Другая причина” (Other reason). For a disassembly: “Не тот товар” (Wrong product), “Неверное количество” (Wrong quantity), “Повреждена упаковка” (Packaging damaged), “Брак по качеству” (Rejected by quality) or “Другая причина” (Other reason). After “Другая причина” (Other reason) the station offers to describe the reason in your own words — this is optional.",
            image: { id: "exception-reason", caption: "The reason for reprinting a box label" },
          },
          {
            kind: "step",
            title: "Confirm the action",
            text: "The station shows what will happen. A reprint: the new label carries the same SSCC — only one may stay on the box. A disassembly: the box's SSCC will not be used again and its codes become free again; this cannot be undone — remove the label from the box. Tap “Перепечатать” (Reprint) or “Расформировать” (Disassemble), or “Назад” (Back).",
            image: { id: "exception-confirm", caption: "Confirming the disassembly of a box" },
          },
          {
            kind: "step",
            title: "Check the result",
            text: "The station reports the result, for example “Этикетка отправлена на принтер.” (The label was sent to the printer). “Вернуться к работе” (Back to work) returns to the work screen, “Другое действие” (Another action) to the list of exceptions.",
            image: {
              id: "exception-result",
              caption: "Exception done: the label was sent to the printer",
            },
            expected:
              "The exception is recorded; the codes of a disassembled box can be scanned again.",
          },
        ],
      },
      {
        id: "pallets",
        heading: "5. Pallets",
        blocks: [
          {
            kind: "step",
            title: "Reprinting and disassembling a pallet",
            text: "“Перепечатать этикетку паллеты” (Reprint a pallet label) and “Расформировать паллету” (Disassemble a pallet) work like the box actions: scan the pallet label or type the last digits of its SSCC, choose the pallet, give the reason and confirm. A disassembly retires the pallet's SSCC, while its boxes stay closed with their codes. Remove the pallet's label.",
            image: { id: "pallet-exceptions", caption: "Choosing a pallet to disassemble" },
          },
        ],
      },
      {
        id: "print-failure",
        heading: "6. Print failures",
        blocks: [
          {
            kind: "step",
            title: "The label was not printed",
            text: "If the printer did not take the job, the station shows “Этикетка короба не напечатана” (The box label was not printed), and the header shows “Принтер: ошибка” (Printer: error). Work on the station stops until you decide what to do with the label. Check the printer — power, paper, cable or network — and tap “Напечатать снова” (Print again). “Другой принтер” (Another printer) sends the label to another printer of the workstation, “Настроить принтер” (Set up the printer) opens the printer setup (MKR-INS-04).",
            image: {
              id: "print-failed",
              caption: "The box label was not printed: the printer did not take the job",
            },
          },
          {
            kind: "step",
            title: "It is unknown whether the label printed",
            text: "If the connection to the printer broke off mid-transfer, the station does not know whether the label came out and shows “Неизвестно, напечаталась ли этикетка” (Unknown whether the label printed). Look at the printer. When printing through a Windows driver, first tap “Проверить очередь Windows” (Check the Windows queue) and inspect the printer queue in Windows: the earlier job may still print. A job missing from the queue does not confirm that the label printed. If the label came out, tap “Этикетка напечаталась” (The label printed); if not, “Напечатать снова” (Print again). Do not print a second label if the first one came out: a box carries one label.",
            image: {
              id: "print-unknown",
              caption: "The station asks you to check whether the label came out",
            },
          },
          {
            kind: "paragraph",
            text: "“Продолжить без этикетки” (Continue without a label) carries on when the printer cannot be fixed at once. The station asks again “Продолжить без этикетки?” (Continue without a label?): the box is already closed and has to be labelled later — the label can be printed again under “Исключения” (Exceptions). The same goes for a pallet.",
          },
        ],
      },
      {
        id: "reprint",
        heading: "7. Label reprint",
        blocks: [
          {
            kind: "paragraph",
            text: "When a label has to be printed again for a box, a pallet or a unit from any shift and any station — for example, in the warehouse — use “Повторная печать этикеток” (Label reprint) on the “Смены линии” (Line shifts) screen. A reprint creates no new codes, boxes or pallets and does not change the quantity of products. Codes can be looked up only while the station reaches the host.",
          },
          {
            kind: "step",
            title: "Prepare the reprint session",
            text: "Choose the reason for the reprint: “Не напечаталась” (Not printed), “Повреждена” (Damaged) or “Утеряна” (Lost) — it applies to every label of the session. If needed, turn on “Проверка распечатки повторным сканированием” (Check the print by scanning it again). Under “Что и на чём печатаем” (What prints on what) check the templates and printers for boxes, pallets, unit codes and A4 sheets; “Изменить” (Change) changes them. Tap “Начать перепечатку” (Start the reprint).",
            image: {
              id: "reprint-setup",
              caption: "Label reprint: the reason and what prints on what",
            },
          },
          {
            kind: "step",
            title: "Scan the label",
            text: "Scan the code of a unit, a box or a pallet — or tap “Ввести код вручную” (Enter the code by hand). The station finds the code on the host, shows which box or pallet it is and sends one new label to the printer: “Этикетка передана на принтер” (The label was handed to the printer). “Следующий код” (Next code) moves on to the next label, “Напечатать ещё раз” (Print once more) prints another label of the same code with a new reason.",
            image: {
              id: "reprint-session",
              caption: "A box found, its label handed to the printer",
            },
          },
          {
            kind: "paragraph",
            text: "When you are done, tap “Завершить сеанс” (End the session) and confirm: the session's records go to the host. “К сменам” (To the shifts) returns to the shift list without ending the session — it can be continued later.",
          },
        ],
      },
      {
        id: "queue",
        heading: "8. Records the host did not accept",
        blocks: [
          {
            kind: "paragraph",
            text: "If the host refused a station record or it conflicts with another station's record, this shows under “Синхронизация” (Sync) and on the “Очередь отправки” (Send queue) screen (MKR-INS-02) in “Не приняты хостом” (Not accepted by the host), “Конфликты” (Conflicts) and “Вытесненные коды” (Displaced codes). Such records do not go away by themselves: tell an administrator.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "9. Common problems",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The box is not in the list",
                detail:
                  "The list holds only the closed boxes of the current shift. Type more digits of the SSCC or scan the label. A box of another shift is reprinted through “Повторная печать этикеток” (Label reprint).",
              },
              {
                term: "The exception was not done",
                detail:
                  "The station explains why: for example, the box label still waits for a decision on the work screen, or the box changed while you were choosing. Settle the label and try again.",
              },
              {
                term: "A reprint is refused because the template changed",
                detail:
                  "The label template was updated after the label was printed: this label cannot be reprinted on the work screen. Use “Повторная печать этикеток” (Label reprint) or contact an administrator.",
              },
              {
                term: "The printer keeps failing",
                detail:
                  "Check the printer's address and setup under “Рабочее место” (Workstation, MKR-INS-04) or call a technician.",
              },
              {
                term: "The label reprint does not find the code",
                detail:
                  "There is no connection to the host, so codes cannot be looked up. A started print can still be settled; the lookup comes back with the connection.",
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
