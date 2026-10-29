import type { LegalDocumentSource } from "../types.js";

export const CABINET_SHIFT_CLOSE_CONTENT = {
  ru: {
    locale: "ru",
    title: "Офис: ход смены, закрытие и выгрузки",
    summary:
      "Инструкция администратора и технолога Маркиро Автоном на вторую половину жизни смены: обзор производства, карточка смены и её разделы, закрытие смены в офисе, данные после закрытия, выгрузки для ГИС МТ и 1С и причины, по которым формат недоступен.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает работу в офисе Маркиро Автоном, пока смена идёт и после её окончания: обзор производства, карточку смены, закрытие смены в офисе и выгрузку файлов для ГИС МТ и учётной системы. Планирование смены описано в MKR-INS-08; открывает смену, ведёт рабочий цикл и обычно закрывает смену оператор на станции — MKR-INS-01 и MKR-INS-02.",
          },
          {
            kind: "paragraph",
            text: "Всё, что ниже, относится к сменам в состояниях «Активна» и «Закрыта». Смотреть ход смены и выгружать файлы могут обе роли офиса — администратор и технолог; закрыть смену в офисе и указать причину может любой, кто планирует смены.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационной площадке. Названия, номера и количества у вас будут другими.",
          },
        ],
      },
      {
        id: "monitoring",
        heading: "2. Обзор производства",
        blocks: [
          {
            kind: "step",
            title: "Начинайте день с раздела «Обзор»",
            text: "«Обзор» открывается первым после входа. Сверху — показатели за сутки: «Единиц принято», «Коробов», «Паллет» и «Расхождений» со сравнением со вчерашним днём. Ниже — «Выпуск по дням · 7 дней» и карточки линий: смена, товар, выполнение плана. Справа — «Требует внимания», сводка «Смены» на сегодня и завтра и «Состояние системы»: устройства, резервные копии и лицензия.",
            image: { id: "overview", caption: "Раздел «Обзор»" },
          },
          {
            kind: "paragraph",
            text: "В «Требует внимания» офис собирает то, что ждёт человека: расхождения кодов, устройства без связи, несделанные или устаревшие резервные копии. Когда всё спокойно, там стоит «Остальное в порядке». Кнопка у сообщения ведёт к месту, где его разбирают.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Станции работают и без связи с хостом: сканы копятся на станции и уходят на хост, когда связь вернётся. Поэтому цифры активной смены в офисе могут отставать от станции — это не потеря данных.",
          },
        ],
      },
      {
        id: "panel",
        heading: "3. Карточка смены",
        blocks: [
          {
            kind: "step",
            title: "Посмотрите итоги смены",
            text: "В разделе «Смены» значок списка в строке активной или закрытой смены открывает «Итоги смены …»: «План, шт», «Принято кодов», «Кодов в закрытых коробах», «Закрыто коробов», «Открыто коробов», «Последние данные со станции» и «Устройства смены».",
            image: { id: "shift-totals", caption: "Окно «Итоги смены»" },
          },
          {
            kind: "step",
            title: "Откройте карточку смены",
            text: "Номер смены в списке открывает её карточку. Сверху — статус и дата смены, кнопки «Выгрузка», «Закрыть» и «Бланк смены»; ниже — разделы смены: «Итоги», «Станции», «Короба», «Паллеты», «Сканирования», «Исключения», «Отклонённые записи», «Конфликты» и «Выгрузки». У смены в режиме «Проверка» нет коробов, паллет и исключений; «Паллеты» есть только у смены с паллетами, «Станции» — когда в смену входили устройства.",
            image: { id: "shift-card", caption: "Карточка активной смены, раздел «Итоги»" },
          },
          {
            kind: "step",
            title: "Проверьте короба",
            text: "«Короба» — список коробов смены: «SSCC», «Кодов», «Закрыт», «Паллета», «Состояние» («Открыт», «Закрыт» или «Расформирован») и «Этикетка». У открытого короба SSCC ещё нет — стоит «Без SSCC». Поле «Последние цифры SSCC» отбирает короба по концу номера.",
            image: { id: "shift-boxes", caption: "Раздел «Короба»" },
          },
          {
            kind: "step",
            title: "Проверьте паллеты",
            text: "«Паллеты» показывают каждую паллету смены: «SSCC», «Коробов», «Кодов», «Закрыта», «Состояние» и формы — «Состав» и, у закрытой паллеты, «Ярлык». Пока паллету собирают, она «Открыта» и без SSCC. Кнопка «Ярлыки паллет смены» над разделами печатает ярлыки всех паллет, для которых они есть.",
            image: { id: "shift-pallets", caption: "Раздел «Паллеты»" },
          },
          {
            kind: "step",
            title: "Найдите скан",
            text: "«Сканирования» — «История сканирований»: «Каждый скан смены, новые сверху. Код показан не целиком: GTIN и последние символы серийного номера.» Отбор — по результату («Принят», «Дубликат», «Другой товар», «Не распознан»), станции, датам, коробу и концу серийного номера; кнопка «Показать».",
            image: { id: "shift-scans", caption: "Раздел «Сканирования»" },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Станции",
                detail:
                  "Устройства, входившие в смену: когда вошли, сколько приняли кодов, коробов и паллет и закрыли ли свою часть.",
              },
              {
                term: "Исключения",
                detail:
                  "Что операторы сделали с коробами и паллетами вне обычного цикла — перепечатка, расформирование — с причиной, станцией и оператором (MKR-INS-03).",
              },
              {
                term: "Отклонённые записи",
                detail:
                  "Записи станции, которые хост не принял, с причиной отказа. Хост хранит каждый отказ.",
              },
              {
                term: "Конфликты",
                detail:
                  "Код, принятый двумя сканами: код остаётся за самым ранним сканом, второй проиграл. Разбирают такие случаи в разделе «Конфликты».",
              },
            ],
          },
        ],
      },
      {
        id: "closing",
        heading: "4. Закрытие смены",
        blocks: [
          {
            kind: "paragraph",
            text: "Обычно смену закрывает оператор на станции — это описано в MKR-INS-02. Если смена закрыта ниже плана, станция попросит назвать причину расхождения, и офис покажет её в списке: «Причина расхождения: …».",
          },
          {
            kind: "step",
            title: "Закройте смену в офисе, если станция её не закончит",
            text: "Меню «…» в строке активной смены → «Закрыть» или кнопка «Закрыть» в карточке. Офис предупреждает: «Закрывайте смену в офисе, только если станция её уже не закончит: например, станция сломалась. Станция не сможет продолжить эту смену; данные, которые она пришлёт позже, будут приняты и отмечены.» Если устройства ещё не закрыли свои части, окно перечислит их: «Не закрыли: …». Заполните «Причина закрытия» — «От 3 до 500 символов, одной строкой. Её увидят в списке смен и в журнале действий.» — и нажмите «Закрыть смену».",
            image: { id: "shift-close", caption: "Закрытие смены в офисе" },
            expected: "Офис сообщил «Смена … закрыта.»",
          },
          {
            kind: "step",
            title: "Проверьте закрытую смену",
            text: "Отберите «Статус» → «Закрыта». В строке закрытой смены — статус «Закрыта», выпуск и под статусом «Закрыта в офисе: …» с вашей причиной.",
            image: { id: "shift-closed", caption: "Смена, закрытая в офисе" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если в смене работали несколько устройств, действие называется «Закрыть целиком»: «Закрытие в офисе закрывает смену для всех устройств сразу: каждое устройство, которое ещё не закрыло свою часть, закрывается вместе с ней.» Закрытую смену заново не открыть.",
          },
          {
            kind: "paragraph",
            text: "Если устройства закрыли общую смену, не назвав причину расхождения с планом, в строке появится «Причина не указана». Меню «…» → «Указать причину»: выберите причину из списка и нажмите «Сохранить причину» — она попадёт в журнал действий.",
          },
        ],
      },
      {
        id: "late",
        heading: "5. Данные после закрытия",
        blocks: [
          {
            kind: "paragraph",
            text: "Станция может прислать сканы и короба уже после того, как смену закрыли, — например, вернувшись в сеть. Хост их принимает и отмечает, а смену они не открывают. Такая смена помечается «Данные после закрытия».",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Выгрузка, сделанная до поздних данных, устарела. Офис предупредит об этом при новой выгрузке: «После закрытия смены пришли данные (…): выгрузка их содержит, а выгрузка, сделанная до этого, устарела.» Сформируйте выгрузку заново и используйте новый файл.",
          },
        ],
      },
      {
        id: "exports",
        heading: "6. Выгрузки для ГИС МТ и 1С",
        blocks: [
          {
            kind: "paragraph",
            text: "Выгрузка — файл с кодами смены для загрузки в ГИС МТ или в учётную систему. Файлы формируются только по закрытой смене.",
          },
          {
            kind: "step",
            title: "Выберите формат",
            text: "Кнопка «Выгрузка» в карточке или меню «…» → «Выгрузка» открывает окно «Выгрузка смены …». Сверху — товар, дата производства и счёт: сколько кодов в смене и в закрытых коробах, сколько закрытых коробов и паллет. Ниже — «Формат»: недоступный формат подписан причиной.",
            image: { id: "export-formats", caption: "Окно «Выгрузка смены»: форматы" },
          },
          {
            kind: "table",
            columns: ["Формат", "Что в файле"],
            columnRatios: [2, 3],
            rows: [
              [
                "[TXT][Без коробов] Отчет смены, [CSV][Без коробов] Отчет смены",
                "Коды смены списком, без коробов",
              ],
              [
                "[TXT][С коробами] Отчет смены, [TXT][С коробами][Обратная] Отчет смены, [CSV][С коробами] Отчет смены",
                "Коды по коробам с SSCC; в обратной раскладке короб пишется кодами вперёд, SSCC — в конце",
              ],
              ["[XML][ГИСМТ] Отчет об агрегации", "Документ агрегации коробов для ГИС МТ"],
              [
                "[TXT][Паллеты] Отчет смены, [CSV][Паллеты] Отчет смены, [TXT][Паллеты → короба] Отчет смены",
                "Паллеты смены с их коробами",
              ],
              [
                "[XML][ГИСМТ] Паллетная агрегация, [XML][ГИСМТ] Агрегация паллет без кодов",
                "Документы агрегации паллет для ГИС МТ",
              ],
            ],
          },
          {
            kind: "paragraph",
            text: "Если файл нужно загружать частями, отметьте «Разделить на части» и задайте «Строк в части, не больше» — целое число от 2 до 1 000 000; короб и паллета с коробами не разрываются между частями. Ниже в окне перечислены паллеты смены: «XML паллеты» формирует документ для Честного знака на одну закрытую паллету.",
          },
          {
            kind: "step",
            title: "Сформируйте и сохраните файлы",
            text: "Нажмите «Сформировать и сохранить». Файлы сохраняются в папку выгрузок внутри папки «Документы» этого компьютера, в новую папку для каждой выгрузки. Офис покажет «Сохранено файлов: … Папка: …» и кнопку «Открыть папку».",
            image: { id: "export-saved", caption: "Выгрузка сохранена" },
            expected: "Файлы лежат в новой папке выгрузки.",
          },
          {
            kind: "step",
            title: "Найдите прежние выгрузки",
            text: "Раздел «Выгрузки» карточки — «Выгрузки смены»: когда, какой формат и файл, сколько кодов, коробов, паллет и частей и кто выгрузил. Хост хранит каждый файл: «Скачать» отдаёт его без изменений и сверяет контрольную сумму, даже если копии в папке на компьютере уже нет. Ниже — «Печатные формы смены» и «Хранение файлов на хосте».",
            image: { id: "shift-exports", caption: "Раздел «Выгрузки» карточки смены" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "По умолчанию хост хранит файлы всегда. Срок хранения задаёт администратор в «Хранение файлов на хосте»; заданный срок сразу удаляет файлы старше него, и удалённые файлы придётся сформировать заново. Там же выбирается «Папка для выгрузок» этого компьютера, в том числе общая сетевая папка.",
          },
        ],
      },
      {
        id: "failures",
        heading: "7. Почему формат недоступен",
        blocks: [
          {
            kind: "step",
            title: "Смена ещё не закрыта",
            text: "У активной смены все форматы подписаны «Смена должна быть закрыта перед формированием отчета.» Дождитесь закрытия на станции или закройте смену в офисе (раздел 4).",
            image: {
              id: "export-not-closed",
              caption: "Выгрузка активной смены: форматы недоступны",
            },
          },
          {
            kind: "step",
            title: "Не все коды в закрытых коробах",
            text: "Если смену закрыли с открытым коробом, форматы с коробами подписаны «Не все коды смены распределены по закрытым коробам.» Доступны форматы «Без коробов». Форматы с паллетами требуют закрытых паллет: «В смене нет закрытых паллет: коробы не ставились на паллеты либо ни одна паллета ещё не закрыта.»",
            image: {
              id: "export-open-box",
              caption: "Смена с открытым коробом: форматы с коробами недоступны",
            },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Нет ИНН или названия организации",
                detail:
                  "Документ для Честного знака требует их: заполните «Профиль» организации. ИНН должен быть из 10 цифр — ИНН индивидуального предпринимателя программа пока не принимает.",
              },
              {
                term: "Короб не помещается в часть",
                detail:
                  "При «Разделить на части» короб или паллета с коробами больше заданного числа строк. Увеличьте «Строк в части, не больше».",
              },
              {
                term: "Неразобранные конфликты",
                detail:
                  "Офис предупредит о них, но выгрузку не запретит. Проверьте их в разделе «Конфликты».",
              },
              {
                term: "Короба на незакрытых паллетах",
                detail:
                  "Они выгружаются без паллеты; когда паллета закроется, выгрузите смену снова.",
              },
            ],
          },
        ],
      },
      {
        id: "faq",
        heading: "8. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Цифры в офисе меньше, чем на станции",
                detail:
                  "Станция ещё не передала часть сканов: она копит их без связи и отправляет при восстановлении. Проверьте связь станции в разделе «Устройства».",
              },
              {
                term: "Кнопка «Закрыть» не видна",
                detail:
                  "Закрыть в офисе можно только активную смену. Запланированную смену удаляют (MKR-INS-08).",
              },
              {
                term: "Файл выгрузки потерялся на компьютере",
                detail:
                  "Откройте карточку смены, раздел «Выгрузки», и нажмите «Скачать»: хост хранит каждый файл.",
              },
              {
                term: "После выгрузки пришли новые данные",
                detail:
                  "Смена помечена «Данные после закрытия». Сформируйте выгрузку заново: прежняя устарела.",
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
    title: "Office: a shift's course, closing and exports",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Guide for Markiro Autonom office administrators and technologists to the second half of a shift's life: the production overview, the shift card and its sections, closing a shift in the office, data arriving after closing, exports for GIS MT and 1C, and why a format is unavailable.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers work in the Markiro Autonom office while a shift runs and after it ends: the production overview, the shift card, closing a shift in the office, and exporting files for GIS MT and the accounting system. Shift planning is covered by MKR-INS-08; the operator at the station opens the shift, runs the work cycle and usually closes the shift — see MKR-INS-01 and MKR-INS-02.",
          },
          {
            kind: "paragraph",
            text: "The application interface is in Russian only, so the screenshots show the Russian screens. Interface labels are quoted in Russian, followed by an English gloss in parentheses.",
          },
          {
            kind: "paragraph",
            text: "Everything below concerns shifts in the «Активна» (Active) and «Закрыта» (Closed) states. Both office roles — administrator and technologist — can follow a shift and export files; anyone who plans shifts can close a shift in the office and give a reason.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots were taken on a demonstration site. Your names, numbers and quantities will differ.",
          },
        ],
      },
      {
        id: "monitoring",
        heading: "2. Production overview",
        blocks: [
          {
            kind: "step",
            title: "Start the day with «Обзор» (Overview)",
            text: "«Обзор» (Overview) opens first after signing in. At the top are the day's figures: «Единиц принято» (Units accepted), «Коробов» (Boxes), «Паллет» (Pallets) and «Расхождений» (Discrepancies), compared with yesterday. Below are «Выпуск по дням · 7 дней» (Output by day · 7 days) and the line cards: shift, product and plan progress. On the right are «Требует внимания» (Needs attention), the «Смены» (Shifts) summary for today and tomorrow, and «Состояние системы» (System state): devices, backups and the license.",
            image: { id: "overview", caption: "The «Обзор» (Overview) section" },
          },
          {
            kind: "paragraph",
            text: "«Требует внимания» (Needs attention) gathers what waits for a person: code discrepancies, devices without a link, backups not made or out of date. When all is calm it reads «Остальное в порядке» (Everything else is fine). The button next to a message leads to the place where it is dealt with.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Stations keep working without a link to the host: scans accumulate at the station and reach the host when the link returns. So an active shift's figures in the office may lag behind the station — no data is lost.",
          },
        ],
      },
      {
        id: "panel",
        heading: "3. The shift card",
        blocks: [
          {
            kind: "step",
            title: "Look at the shift's totals",
            text: "In the «Смены» (Shifts) section the list icon in the row of an active or closed shift opens «Итоги смены …» (Totals of shift …): plan, codes accepted, codes in closed boxes, boxes closed, boxes open, the last data from the station and the shift's devices.",
            image: { id: "shift-totals", caption: "The «Итоги смены» (Shift totals) window" },
          },
          {
            kind: "step",
            title: "Open the shift card",
            text: "The shift number in the list opens its card. At the top are the status and shift date and the «Выгрузка» (Export), «Закрыть» (Close) and «Бланк смены» (Shift sheet) buttons; below are the shift's sections: «Итоги» (Totals), «Станции» (Stations), «Короба» (Boxes), «Паллеты» (Pallets), «Сканирования» (Scans), «Исключения» (Exceptions), «Отклонённые записи» (Rejected records), «Конфликты» (Conflicts) and «Выгрузки» (Exports). A Validation shift has no boxes, pallets or exceptions; «Паллеты» exists only for a shift with pallets, «Станции» once devices have entered the shift.",
            image: {
              id: "shift-card",
              caption: "Card of an active shift, the «Итоги» (Totals) section",
            },
          },
          {
            kind: "step",
            title: "Check the boxes",
            text: "«Короба» (Boxes) lists the shift's boxes: SSCC, codes, closed at, pallet, state («Открыт» open, «Закрыт» closed or «Расформирован» disassembled) and label. An open box has no SSCC yet and reads «Без SSCC» (No SSCC). The «Последние цифры SSCC» (Last digits of the SSCC) field filters boxes by the end of the number.",
            image: { id: "shift-boxes", caption: "The «Короба» (Boxes) section" },
          },
          {
            kind: "step",
            title: "Check the pallets",
            text: "«Паллеты» (Pallets) shows every pallet of the shift: SSCC, boxes, codes, closed at, state and forms — «Состав» (Contents) and, for a closed pallet, «Ярлык» (Placard). While a pallet is being assembled it is «Открыта» (Open) and has no SSCC. The «Ярлыки паллет смены» (Shift pallet placards) button above the sections prints the placards of all pallets that have one.",
            image: { id: "shift-pallets", caption: "The «Паллеты» (Pallets) section" },
          },
          {
            kind: "step",
            title: "Find a scan",
            text: "«Сканирования» (Scans) holds the scan history: every scan of the shift, newest first; a code is shown partly — the GTIN and the last characters of the serial number. Filters: result («Принят» accepted, «Дубликат» duplicate, «Другой товар» other product, «Не распознан» not recognised), station, dates, box and the end of the serial number; then «Показать» (Show).",
            image: { id: "shift-scans", caption: "The «Сканирования» (Scans) section" },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Stations",
                detail:
                  "Devices that entered the shift: when they entered, how many codes, boxes and pallets they accepted and whether they closed their part.",
              },
              {
                term: "Exceptions",
                detail:
                  "What operators did to boxes and pallets outside the normal cycle — reprint, disassembly — with the reason, station and operator (MKR-INS-03).",
              },
              {
                term: "Rejected records",
                detail:
                  "Station records the host did not accept, with the reason. The host keeps every refusal.",
              },
              {
                term: "Conflicts",
                detail:
                  "A code accepted by two scans: the code stays with the earliest scan and the other one lost. Such cases are dealt with in the «Конфликты» (Conflicts) section.",
              },
            ],
          },
        ],
      },
      {
        id: "closing",
        heading: "4. Closing a shift",
        blocks: [
          {
            kind: "paragraph",
            text: "Normally the operator closes the shift at the station — see MKR-INS-02. If the shift closes below plan, the station asks for the reason, and the office shows it in the list as «Причина расхождения: …» (Reason for the discrepancy: …).",
          },
          {
            kind: "step",
            title: "Close the shift in the office if the station will not finish it",
            text: "«…» menu in an active shift's row → «Закрыть» (Close), or the «Закрыть» button in the card. The office warns: close a shift in the office only if the station will not finish it — for example, the station broke down; the station will not be able to continue the shift, and data it sends later will be accepted and marked. If devices have not closed their parts yet, the window lists them: «Не закрыли: …» (Not closed: …). Fill in «Причина закрытия» (Reason for closing) — 3 to 500 characters on one line, shown in the list of shifts and in the action log — and click «Закрыть смену» (Close the shift).",
            image: { id: "shift-close", caption: "Closing a shift in the office" },
            expected: "The office reports «Смена … закрыта.» (Shift … closed.)",
          },
          {
            kind: "step",
            title: "Check the closed shift",
            text: "Filter «Статус» (Status) → «Закрыта» (Closed). The closed shift's row shows the status «Закрыта» (Closed), the output, and under the status «Закрыта в офисе: …» (Closed in the office: …) with your reason.",
            image: { id: "shift-closed", caption: "A shift closed in the office" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If several devices worked in the shift, the action is called «Закрыть целиком» (Close whole): closing in the office closes the shift for all devices at once, and every device that has not closed its part is closed with it. A closed shift cannot be reopened.",
          },
          {
            kind: "paragraph",
            text: "If devices closed a shared shift without giving the reason for the discrepancy with the plan, the row shows «Причина не указана» (Reason not given). «…» menu → «Указать причину» (Give a reason): choose the reason from the list and click «Сохранить причину» (Save the reason) — it goes into the action log.",
          },
        ],
      },
      {
        id: "late",
        heading: "5. Data after closing",
        blocks: [
          {
            kind: "paragraph",
            text: "A station may send scans and boxes after the shift has been closed — for example, when it comes back online. The host accepts and marks them, and they do not reopen the shift. Such a shift is marked «Данные после закрытия» (Data after closing).",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "An export made before the late data is out of date. The office warns about this on the next export: data arrived after the shift was closed; this export contains it, and the export made before is out of date. Make the export again and use the new file.",
          },
        ],
      },
      {
        id: "exports",
        heading: "6. Exports for GIS MT and 1C",
        blocks: [
          {
            kind: "paragraph",
            text: "An export is a file with the shift's codes for loading into GIS MT or the accounting system. Files are made only for a closed shift.",
          },
          {
            kind: "step",
            title: "Choose a format",
            text: "The «Выгрузка» (Export) button in the card, or «…» menu → «Выгрузка», opens the «Выгрузка смены …» (Export of shift …) window. At the top are the product, the production date and the count: codes in the shift and in closed boxes, closed boxes and pallets. Below is «Формат» (Format): an unavailable format is labelled with its reason.",
            image: { id: "export-formats", caption: "The export window: formats" },
          },
          {
            kind: "table",
            columns: ["Format", "What the file holds"],
            columnRatios: [2, 3],
            rows: [
              [
                "[TXT][Без коробов] Отчет смены, [CSV][Без коробов] Отчет смены",
                "The shift's codes as a list, without boxes",
              ],
              [
                "[TXT][С коробами] Отчет смены, [TXT][С коробами][Обратная] Отчет смены, [CSV][С коробами] Отчет смены",
                "Codes by box with the SSCC; the reversed layout writes a box codes first and its SSCC last",
              ],
              ["[XML][ГИСМТ] Отчет об агрегации", "Box aggregation document for GIS MT"],
              [
                "[TXT][Паллеты] Отчет смены, [CSV][Паллеты] Отчет смены, [TXT][Паллеты → короба] Отчет смены",
                "The shift's pallets with their boxes",
              ],
              [
                "[XML][ГИСМТ] Паллетная агрегация, [XML][ГИСМТ] Агрегация паллет без кодов",
                "Pallet aggregation documents for GIS MT",
              ],
            ],
          },
          {
            kind: "paragraph",
            text: "If the file must be loaded in parts, tick «Разделить на части» (Split into parts) and set «Строк в части, не больше» (Lines per part, at most) — a whole number from 2 to 1,000,000; a box, and a pallet with its boxes, are never split between parts. The window also lists the shift's pallets: «XML паллеты» (Pallet XML) makes a Chestny Znak document for one closed pallet.",
          },
          {
            kind: "step",
            title: "Make and save the files",
            text: "Click «Сформировать и сохранить» (Make and save). The files are saved to the «Документы\\Markiro\\Выгрузки» folder of this computer, in a new folder for each export. The office shows «Сохранено файлов: … Папка: …» (Files saved: … Folder: …) and the «Открыть папку» (Open folder) button.",
            image: { id: "export-saved", caption: "The export is saved" },
            expected: "The files are in a new export folder.",
          },
          {
            kind: "step",
            title: "Find earlier exports",
            text: "The card's «Выгрузки» (Exports) section lists the shift's exports: when, which format and file, how many codes, boxes, pallets and parts, and who exported. The host keeps every file: «Скачать» (Download) returns it unchanged and checks the checksum, even if the copy on the computer is gone. Below are «Печатные формы смены» (Shift printed forms) and «Хранение файлов на хосте» (File storage on the host).",
            image: {
              id: "shift-exports",
              caption: "The «Выгрузки» (Exports) section of the shift card",
            },
          },
          {
            kind: "callout",
            tone: "info",
            text: "By default the host keeps files forever. The administrator sets a retention period in «Хранение файлов на хосте» (File storage on the host); a period deletes older files at once, and deleted files have to be made again. The same place sets this computer's «Папка для выгрузок» (Exports folder), a shared network folder included.",
          },
        ],
      },
      {
        id: "failures",
        heading: "7. Why a format is unavailable",
        blocks: [
          {
            kind: "step",
            title: "The shift is not closed yet",
            text: "For an active shift every format reads «Смена должна быть закрыта перед формированием отчета.» (The shift must be closed before the report is made.) Wait for the station to close it or close the shift in the office (section 4).",
            image: {
              id: "export-not-closed",
              caption: "Export of an active shift: formats unavailable",
            },
          },
          {
            kind: "step",
            title: "Not all codes are in closed boxes",
            text: "If the shift was closed with an open box, the box formats read «Не все коды смены распределены по закрытым коробам.» (Not all of the shift's codes are in closed boxes.) The «Без коробов» (Without boxes) formats remain available. Pallet formats need closed pallets: otherwise they read that the shift has no closed pallets — boxes were not stacked on pallets, or no pallet is closed yet.",
            image: {
              id: "export-open-box",
              caption: "A shift with an open box: box formats unavailable",
            },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "No INN or organization name",
                detail:
                  "A Chestny Znak document requires both: fill in the organization's «Профиль» (Profile). The INN must have 10 digits — a sole proprietor's INN is not accepted yet.",
              },
              {
                term: "A box does not fit into a part",
                detail:
                  "With «Разделить на части» (Split into parts), a box, or a pallet with its boxes, has more lines than the limit. Raise «Строк в части, не больше» (Lines per part, at most).",
              },
              {
                term: "Unreviewed conflicts",
                detail:
                  "The office warns about them but does not forbid the export. Check them in the «Конфликты» (Conflicts) section.",
              },
              {
                term: "Boxes on unclosed pallets",
                detail:
                  "They are exported without a pallet; once the pallet closes, export the shift again.",
              },
            ],
          },
        ],
      },
      {
        id: "faq",
        heading: "8. Frequently asked questions",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The office shows fewer than the station",
                detail:
                  "The station has not sent part of its scans yet: it keeps them while offline and sends them when the link returns. Check the station's link in the «Устройства» (Devices) section.",
              },
              {
                term: "There is no «Закрыть» button",
                detail:
                  "Only an active shift can be closed in the office. A planned shift is deleted instead (MKR-INS-08).",
              },
              {
                term: "The export file is lost on the computer",
                detail:
                  "Open the shift card, the «Выгрузки» (Exports) section, and click «Скачать» (Download): the host keeps every file.",
              },
              {
                term: "New data arrived after the export",
                detail:
                  "The shift is marked «Данные после закрытия» (Data after closing). Make the export again: the earlier one is out of date.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "If your problem is not described above, contact Markiro support: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
