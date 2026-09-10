import type { LegalDocumentSource } from "../types.js";

export const CABINET_SHIFT_CLOSE_CONTENT = {
  ru: {
    locale: "ru",
    title: "Кабинет: наблюдение, закрытие и отчёты смены",
    summary:
      "Инструкция менеджера на вторую половину жизни смены: наблюдение за производством по дашборду, закрытие смены из кабинета, данные после закрытия, отчёты для ГИС МТ и разбор их отказов.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает работу менеджера кабинета, пока смена идёт и после её окончания: наблюдение за производством, закрытие смены из кабинета, разбор данных, пришедших после закрытия, и формирование отчётов для ГИС МТ. Подготовка и планирование смены описаны в MKR-INS-08; открывает смену и ведёт рабочий цикл оператор на станции — MKR-INS-01 и MKR-INS-02.",
          },
          {
            kind: "paragraph",
            text: "Смена проходит состояния «Активна» — идёт выпуск — и «Закрыта» — выпуск окончен, доступны отчёты. Всё, что ниже, относится к этим двум состояниям; смена в состоянии «Запланирована» описана в MKR-INS-08.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Номера, количества и названия в вашем кабинете будут другими.",
          },
        ],
      },
      {
        id: "monitoring",
        heading: "2. Наблюдение за производством",
        blocks: [
          {
            kind: "step",
            title: "Начинайте день с обзора",
            text: "Раздел «Обзор» открывает дашборд «Производство сегодня». Слева вверху — вердикт «Контроль производства»: «Производство под контролем» означает, что активных причин для вмешательства нет, и кабинет так и пишет: «Активных причин для вмешательства нет.» Ниже — счётчики дня: «Проверено поштучно», «Закрыто коробов», «Единиц в коробах», «Активные смены», а панель «Смены прямо сейчас» перечисляет идущие смены с выпуском по каждой.",
            image: {
              id: "dashboard-under-control",
              caption: "Дашборд: производство под контролем",
            },
          },
          {
            kind: "step",
            title: "Реагируйте на вердикт «Требует внимания»",
            text: "Когда есть причины вмешаться, вердикт меняется на «Требует внимания» (а при серьёзных проблемах — на «Критическое состояние»), и рядом перечислены сами причины — на снимке это «Поздние данные затронули 1 смену». Причина — ссылка: она ведёт к затронутому разделу. Панель «Сигналы контроля» объясняет, насколько цифрам можно верить прямо сейчас.",
            image: {
              id: "dashboard-attention",
              caption: "Дашборд: вердикт «Требует внимания» и его причина",
            },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Пока есть активные смены, сводка дня помечена «Предварительные данные», а в сигналах видно «Активная смена: данные могут измениться» — станции досылают сканы по мере связи, и счётчики растут. Это не сбой: окончательными цифры становятся после закрытия смен. Динамика и темп производства в этот документ не входят.",
          },
        ],
      },
      {
        id: "panel",
        heading: "3. Панель смены",
        blocks: [
          {
            kind: "paragraph",
            text: "Всё, что известно кабинету о смене, и все действия над ней собраны в одной панели. В строке списка есть единственная кнопка «Подробнее» — она эту панель и открывает.",
          },
          {
            kind: "step",
            title: "Откройте панель смены",
            text: "Нажмите «Подробнее» в строке. Панель открывается справа поверх списка и озаглавлена номером смены. Первым идёт «Результат смены»: для агрегации это «Закрыто коробов» и «Кодов в закрытых коробах», для проверки — «Принято кодов», и рядом всегда «План, шт». Ниже — «Параметры смены» с датами, линией, режимом и контрагентом.",
            image: {
              id: "shifts-active",
              caption: "Панель активной смены: результат, сотрудники и действия",
            },
            expected: "Панель открыта, метрики показывают фактический выпуск на текущий момент.",
          },
          {
            kind: "step",
            title: "Посмотрите, кто работал в смене",
            text: "Блок «Сотрудники в смене» перечисляет операторов с их активностью и счётчиками принятых сканов и закрытых коробов. Если часть операций пришла без сотрудника, кабинет предупреждает об этом отдельной плашкой — обычно так выглядят сканы, сделанные до входа оператора или после его выхода.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Если статистику не удалось загрузить, кабинет говорит об этом прямо в панели и предлагает «Повторить». Остальные данные смены и действия при этом остаются доступны — сбой статистики не мешает закрыть смену.",
          },
        ],
      },
      {
        id: "labels",
        heading: "4. История этикеток",
        blocks: [
          {
            kind: "paragraph",
            text: "Для смены, где включена печать дубликата Data Matrix (её настройка описана в MKR-INS-08), в панели появляется «История этикеток». Раздел показывает, что происходило с каждой напечатанной этикеткой: сводку попыток отправки, проверки и перепечаток, а ниже — сами попытки с временем и состоянием.",
          },
          {
            kind: "step",
            title: "Проверьте проблемные попытки",
            text: "Записи, требующие внимания, видны сразу: у них не завершена проверка или печать не подтверждена. Разверните попытку, чтобы увидеть события по ней. Пока такие записи есть, стоит выяснить у линии, все ли этикетки наклеены.",
            image: {
              id: "shift-labels-history",
              caption: "История этикеток смены с дубликатом",
            },
          },
        ],
      },
      {
        id: "closing",
        heading: "5. Закрытие смены",
        blocks: [
          {
            kind: "paragraph",
            text: "Штатно смену закрывает оператор со станции в конце работы — это описано в MKR-INS-02. Кабинетное закрытие — запасной путь: станция вышла из строя, осталась без связи или оператор ушёл, не закрыв смену.",
          },
          {
            kind: "step",
            title: "Закройте смену из кабинета",
            text: "Откройте смену кнопкой «Подробнее» и найдите внизу панели раздел «Действия со сменой». Кнопка «Закрыть смену» есть только у активной смены: у запланированной вместо неё «Удалить», а у закрытой раздела «Действия со сменой» нет вовсе.",
          },
          {
            kind: "step",
            title: "Укажите причину",
            text: "В окне «Закрыть смену» заполните «Причина закрытия». Пока в поле меньше трёх значащих символов, кнопка подтверждения неактивна — короткой отписки вроде точки кабинет не примет. Причина сохраняется в смене и видна в списке под статусом «Закрыта».",
            image: { id: "shift-close", caption: "Закрытие смены с обязательной причиной" },
            expected: "Смена в списке со статусом «Закрыта», под ним — указанная причина.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Закрывайте смену из кабинета, только когда уверены, что выпуск действительно окончен. Станция, оставшаяся в закрытой смене, продолжит работать по прежним настройкам до повторного входа, а её сканы придут уже как данные после закрытия (раздел 6).",
          },
        ],
      },
      {
        id: "late-data",
        heading: "6. Данные после закрытия",
        blocks: [
          {
            kind: "step",
            title: "Следите за бейджем в списке",
            text: "Если после закрытия смены со станции доехали ещё сканы — например, станция была без связи в момент закрытия, — кабинет помечает смену бейджем «Данные после закрытия». Итоги такой смены изменились по сравнению с моментом закрытия.",
            image: { id: "shifts-late-badge", caption: "Смена с данными после закрытия" },
          },
          {
            kind: "paragraph",
            text: "Сам по себе бейдж не требует действий — данные уже учтены. Важно другое: отчёты, сформированные до прихода этих данных, устарели. У таких отчётов кабинет показывает предупреждение «Данные смены изменились — сформируйте новый отчет.» (раздел 8) — сформируйте отчёт заново и передавайте в ГИС МТ свежий.",
          },
        ],
      },
      {
        id: "exports",
        heading: "7. Отчёты для ГИС МТ",
        blocks: [
          {
            kind: "step",
            title: "Откройте отчёты закрытой смены",
            text: "Откройте закрытую смену кнопкой «Подробнее»: в панели появится раздел «Отчеты смены». У незакрытой смены на его месте стоит пояснение, что заказать и выгрузить отчёты можно только после закрытия. В блоке «Формат отчета» — форматы из утверждённого серверного каталога: «[TXT][Без коробов] Отчет смены», «[TXT][С коробами] Отчет смены», «[CSV][Без коробов] Отчет смены», «[CSV][С коробами] Отчет смены» и «[XML][ГИСМТ] Отчет об агрегации». Отметка «Разделить отчет на части» добавляет поле «Максимум строк в части» — допустимо целое число от 2 до 1 000 000; без разделения отчёт выходит одним файлом.",
            image: { id: "exports-catalog", caption: "Выбор формата отчёта и разделение на части" },
          },
          {
            kind: "step",
            title: "Дождитесь готовности и скачайте части",
            text: "Нажмите «Сформировать отчет» внизу окна. В блоке «Сформированные отчеты» виден каждый запуск: статус («В очереди», «Формируется», «Готов», «Ошибка»), кто сформировал, формат и параметры («Без разделения» или «до N строк в части»), итоговые коды и короба. У готового отчёта части перечислены отдельно — «Часть 1», «Часть 2» — с числом строк, кодов и коробов; каждая скачивается своей кнопкой «Скачать». Пока запуск «В очереди» или «Формируется», раздел обновляется сам.",
            image: {
              id: "exports-history",
              caption: "Сформированные отчёты: готовый с частями и формирующийся",
            },
            expected: "Все части отчёта скачаны.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Ссылка на скачивание действует несколько минут — если загрузка не началась, нажмите «Скачать» ещё раз. Формирование выполняется на сервере: панель можно закрыть и вернуться позже, запуск не пропадёт.",
          },
        ],
      },
      {
        id: "export-errors",
        heading: "8. Почему отчёт не формируется",
        blocks: [
          {
            kind: "step",
            title: "Прочитайте причину у неудавшегося запуска",
            text: "Запуск со статусом «Ошибка» показывает причину словами кабинета — на снимке это «Не все коды смены распределены по коробам.» — и кнопку «Повторить». «Повторить» есть у любого неудавшегося запуска: после устранения причины формирование можно перезапустить тем же составом, не выбирая формат заново.",
            image: { id: "exports-failed", caption: "Неудавшийся отчёт: причина и повтор" },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Смена ещё не закрыта",
                detail:
                  "«Смена должна быть закрыта перед формированием отчета.» Отчёты доступны только по закрытой смене: дождитесь закрытия оператором или закройте смену из кабинета (раздел 5).",
              },
              {
                term: "Коды не разложены по коробам",
                detail:
                  "«Не все коды смены распределены по коробам.» Форматы с коробами требуют, чтобы каждый код смены лежал в коробе. Доложите коды в короба на станции либо сформируйте формат «[TXT][Без коробов] Отчет смены» или «[CSV][Без коробов] Отчет смены».",
              },
              {
                term: "Не указан ИНН организации",
                detail:
                  "«Укажите ИНН организации в профиле, чтобы сформировать отчет для ГИС МТ.» Заполните ИНН в настройках профиля организации и повторите формирование.",
              },
              {
                term: "Короб не помещается в часть",
                detail:
                  "«Короб не помещается в установленное ограничение строк.» Короб не разрезается между частями: поднимите «Максимум строк в части» выше размера самого большого короба или отключите разделение.",
              },
              {
                term: "Пустая смена или смена без даты",
                detail:
                  "«В смене нет кодов для отчета.» — отчитываться не о чем. «У смены не указана дата.» — заполните дату смены в её карточке (MKR-INS-08) и повторите.",
              },
              {
                term: "Некорректные данные смены",
                detail:
                  "«У одного из коробов некорректный SSCC — отчет сформировать нельзя.» и «В смене есть код маркировки, который не удалось разобрать для отчета.» — данные повреждены; такое не чинится из окна отчётов, обратитесь в поддержку.",
              },
              {
                term: "Временный сбой",
                detail:
                  "«Не удалось сформировать отчет. Повторите попытку.», «Не удалось сохранить отчет. Повторите попытку.», «Не удалось поставить отчет в очередь. Повторите попытку.» — инфраструктурные ошибки; нажмите «Повторить», при повторении — в поддержку.",
              },
            ],
          },
          {
            kind: "step",
            title: "Обновляйте устаревшие отчёты",
            text: "Если после формирования пришли данные (раздел 6), готовый отчёт помечается предупреждением «Данные смены изменились — сформируйте новый отчет.» Скачанные ранее файлы не обновляются сами — сформируйте новый запуск и передавайте в ГИС МТ его.",
            image: { id: "exports-stale", caption: "Отчёт устарел после поздних данных" },
          },
        ],
      },
      {
        id: "faq",
        heading: "9. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Цифры на дашборде меняются сами",
                detail:
                  "Идут активные смены: станции досылают сканы, сводка помечена «Предварительные данные». Окончательные цифры — после закрытия смен.",
              },
              {
                term: "У смены нет кнопки закрытия",
                detail:
                  "«Закрыть смену» есть только у активной смены. Запланированную можно изменить или удалить (MKR-INS-08), закрытую — только отчитать.",
              },
              {
                term: "Не находите кнопку отчётов",
                detail:
                  "«Сформировать отчет» появляется у смены в статусе «Закрыта». У активной смены отчётов нет — сначала закройте смену.",
              },
              {
                term: "Отчёт был готов, а теперь помечен предупреждением",
                detail:
                  "После формирования пришли данные со станции — смена помечена «Данные после закрытия», отчёт устарел. Сформируйте новый и используйте его.",
              },
              {
                term: "Часть отчёта не скачивается",
                detail:
                  "Ссылка на скачивание короткоживущая. Нажмите «Скачать» у нужной части ещё раз — кабинет выдаст свежую ссылку.",
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
    title: "Cabinet: monitoring, closing and shift reports",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Manager's guide for the second half of a shift's life: watching production on the dashboard, closing a shift from the cabinet, data that arrives after the close, reports for GIS MT and the reasons they fail.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the cabinet manager's work while a shift is running and after it ends: watching production, closing a shift from the cabinet, dealing with data that arrives after the close, and generating reports for GIS MT. Preparing and planning a shift are covered by MKR-INS-08; the operator opens the shift and runs the work cycle on the station — MKR-INS-01 and MKR-INS-02.",
          },
          {
            kind: "paragraph",
            text: "A shift goes through the states “Active” — production is under way — and “Closed” — production is over and the reports are available. Everything below concerns these two states; the “Planned” state is covered by MKR-INS-08.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots use demo data. The numbers, quantities and names in your cabinet will differ. The wordmark in the sidebar keeps its Russian spelling: it is the Markiro logo, not a translated interface string.",
          },
        ],
      },
      {
        id: "monitoring",
        heading: "2. Watching production",
        blocks: [
          {
            kind: "step",
            title: "Start the day with the overview",
            text: "The “Overview” section opens the “Production today” dashboard. At the top left is the “Production control” verdict: “Production is under control” means there are no active reasons to step in, and the cabinet says exactly that — “There are no active reasons for intervention.” Below are the counters for the day: “Validated individually”, “Closed boxes”, “Units in boxes”, “Active shifts”, and the “Shifts running now” panel lists the shifts under way with the output of each.",
            image: {
              id: "dashboard-under-control",
              caption: "The dashboard: production is under control",
            },
          },
          {
            kind: "step",
            title: "React to the “Needs attention” verdict",
            text: "When there are reasons to step in, the verdict changes to “Needs attention” (and for serious problems to “Critical condition”), and the reasons themselves are listed next to it — in the screenshot that is “Late data affected 1 shift”. A reason is a link: it takes you to the affected section. The “Control signals” panel explains how far the current numbers can be trusted.",
            image: {
              id: "dashboard-attention",
              caption: "The dashboard: the “Needs attention” verdict and its reason",
            },
          },
          {
            kind: "callout",
            tone: "info",
            text: "While shifts are still active, the day's summary is marked “Provisional data” and the signals show “Active shift: data may change” — the stations keep sending scans as the connection allows, and the counters grow. This is not a fault: the numbers become final once the shifts are closed. Production dynamics and rate are outside this document.",
          },
        ],
      },
      {
        id: "panel",
        heading: "3. The shift panel",
        blocks: [
          {
            kind: "paragraph",
            text: "Everything the cabinet knows about a shift, and every action on it, is gathered in one panel. The row in the list carries a single button, “Details” — that is what opens the panel.",
          },
          {
            kind: "step",
            title: "Open the shift panel",
            text: "Press “Details” in the row. The panel opens on the right over the list and is titled with the shift number. “Shift output” comes first: for aggregation that is “Closed boxes” and “Codes in closed boxes”, for validation “Accepted codes”, and “Plan, units” always sits next to them. Below is “Shift parameters” with the dates, the line, the mode and the counterparty.",
            image: {
              id: "shifts-active",
              caption: "An active shift's panel: output, employees and actions",
            },
            expected: "The panel is open and the metrics show the actual output so far.",
          },
          {
            kind: "step",
            title: "See who worked in the shift",
            text: "The “Employees in this shift” block lists the operators with their activity and the “Accepted scans” and “Closed boxes” counters. If some of the operations arrived without an employee, the cabinet warns about it on a separate banner — “4 operations have no employee assigned.” in the screenshot above; that is usually what scans made before an operator signs in or after they sign out look like.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "If the statistics could not be loaded, the cabinet says so right inside the panel and offers “Retry”. The rest of the shift data and the actions stay available — a statistics failure does not stop you closing the shift.",
          },
        ],
      },
      {
        id: "labels",
        heading: "4. Label history",
        blocks: [
          {
            kind: "paragraph",
            text: "For a shift with Data Matrix duplicate printing enabled (setting it up is covered by MKR-INS-08), the panel gains a “Label history” section. It shows what happened to every printed label: a summary of the send attempts, verifications and reprints, and below it the attempts themselves with their time and state.",
          },
          {
            kind: "step",
            title: "Check the attempts that need work",
            text: "The summary tiles — “Sent to printer”, “Verified labels”, “Unfinished jobs”, “Reprint attempts” — show where the shift stands. Records that need work stand out by their state: “Needs attention” instead of “Label verified”, meaning the verification is unfinished or the print was not confirmed. Expand an attempt to see its events. While such records remain, check with the line that every label has been applied.",
            image: {
              id: "shift-labels-history",
              caption: "The label history of a shift with a duplicate",
            },
          },
        ],
      },
      {
        id: "closing",
        heading: "5. Closing a shift",
        blocks: [
          {
            kind: "paragraph",
            text: "Normally the operator closes the shift from the station at the end of the work — this is covered by MKR-INS-02. Closing from the cabinet is the fallback: the station broke down, lost its connection, or the operator left without closing the shift.",
          },
          {
            kind: "step",
            title: "Close the shift from the cabinet",
            text: "Open the shift with the “Details” button and find the “Shift actions” section at the bottom of the panel. The “Close shift” button is there only for an active shift: a planned one has “Delete” in its place, and a closed one has no “Shift actions” section at all.",
          },
          {
            kind: "step",
            title: "State a reason",
            text: "In the “Close shift” dialog fill in “Close reason”. While the field holds fewer than three meaningful characters the confirmation button stays disabled — the cabinet will not accept a token entry such as a single full stop. The reason is stored with the shift and shown in the list under the “Closed” status.",
            image: { id: "shift-close", caption: "Closing a shift with a mandatory reason" },
            expected:
              "The shift is in the list with the “Closed” status and the reason underneath.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Close a shift from the cabinet only when you are sure that production is really over. A station left inside a closed shift keeps working with the previous settings until the next sign-in, and its scans will arrive as data after the close (section 6).",
          },
        ],
      },
      {
        id: "late-data",
        heading: "6. Data after the close",
        blocks: [
          {
            kind: "step",
            title: "Watch for the badge in the list",
            text: "If more scans reach the cabinet from the station after the shift was closed — for example, the station had no connection at the moment of closing — the cabinet marks the shift with the “Data after close” badge. The totals of such a shift have changed since the moment it was closed.",
            image: { id: "shifts-late-badge", caption: "A shift with data after the close" },
          },
          {
            kind: "paragraph",
            text: "The badge on its own calls for no action — the data is already counted. What matters is different: reports generated before that data arrived are out of date. The cabinet marks such reports with the warning “Shift data changed — generate a new report” (section 8) — generate the report again and hand the fresh one to GIS MT.",
          },
        ],
      },
      {
        id: "exports",
        heading: "7. Reports for GIS MT",
        blocks: [
          {
            kind: "step",
            title: "Open the reports of a closed shift",
            text: "Open the closed shift with the “Details” button: the panel gains a “Shift reports” section. For a shift that is not closed yet, its place is taken by the note “Reports can be requested and downloaded after the shift is closed.” The “Report format” block lists the formats from the approved server catalog. The server delivers that catalog with Russian labels, and the cabinet shows them exactly as they arrive whatever the interface language: “[TXT][Без коробов] Отчет смены” (shift report, TXT, without boxes), “[TXT][С коробами] Отчет смены” (TXT, with boxes), “[CSV][Без коробов] Отчет смены” (CSV, without boxes), “[CSV][С коробами] Отчет смены” (CSV, with boxes) and “[XML][ГИСМТ] Отчет об агрегации” (the GIS MT aggregation XML). Ticking “Split report into parts” adds a “Maximum lines per part” field — a whole number from 2 to 1,000,000 is allowed; without splitting the report comes out as a single file.",
            image: {
              id: "exports-catalog",
              caption: "Choosing a report format and splitting it into parts",
            },
          },
          {
            kind: "step",
            title: "Wait for it and download the parts",
            text: "Press “Generate report” at the bottom of the panel. Every run is visible in the “Generated reports” block: its status (“Queued”, “Processing”, “Ready”, “Failed”), who it was “Created by”, the “Format” and the “Parameters” (“Not split” or “up to 1,000 lines per part”), and the resulting “Codes” and “Boxes”. A ready report lists its parts separately — “Part 1”, “Part 2” — with the number of lines, codes and boxes; each part has its own “Download” button. While a run is “Processing”, the section refreshes itself.",
            image: {
              id: "exports-history",
              caption: "Generated reports: a ready one with parts and one still being generated",
            },
            expected: "Every part of the report has been downloaded.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "A download link is valid for a few minutes — if the download does not start, press “Download” again. Generation runs on the server: you can close the panel and come back later, the run will not be lost.",
          },
        ],
      },
      {
        id: "export-errors",
        heading: "8. Why a report is not generated",
        blocks: [
          {
            kind: "step",
            title: "Read the reason on the failed run",
            text: "A run with the “Failed” status shows the reason in the cabinet's own words — in the screenshot that is “Not every shift code is assigned to a box.” — together with a “Retry” button. “Retry” is offered on every failed run: once the cause is gone, generation can be restarted with the same settings, without picking the format again.",
            image: { id: "exports-failed", caption: "A failed report: the reason and the retry" },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "The shift is not closed yet",
                detail:
                  "“The shift must be closed before generating a report.” Reports are available only for a closed shift: wait for the operator to close it, or close the shift from the cabinet (section 5).",
              },
              {
                term: "Codes are not packed into boxes",
                detail:
                  "“Not every shift code is assigned to a box.” The formats with boxes require every code of the shift to sit in a box. Pack the remaining codes into boxes on the station, or generate “[TXT][Без коробов] Отчет смены” or “[CSV][Без коробов] Отчет смены” instead.",
              },
              {
                term: "The organization INN is missing",
                detail:
                  "“Set the organization INN in the profile to generate the GIS MT report.” Fill the INN in the organization profile settings and generate the report again.",
              },
              {
                term: "A box does not fit into a part",
                detail:
                  "“A box does not fit within the lines-per-part limit.” A box is never split across parts: raise “Maximum lines per part” above the size of the largest box, or turn splitting off.",
              },
              {
                term: "An empty shift or a shift without a date",
                detail:
                  "“The shift has no codes to include in a report.” — there is nothing to report on. “The shift has no date.” — fill the shift date on its card (MKR-INS-08) and try again.",
              },
              {
                term: "Broken shift data",
                detail:
                  "“One of the boxes has an invalid SSCC, so the report cannot be generated.” and “The shift contains a marking code that could not be parsed for the report.” — the data is damaged; this cannot be fixed from the reports panel, contact support.",
              },
              {
                term: "A temporary failure",
                detail:
                  "“Could not generate the report. Try again.”, “Could not save the report. Try again.”, “Could not queue the report. Try again.” — infrastructure errors; press “Retry”, and if it happens again, contact support.",
              },
            ],
          },
          {
            kind: "step",
            title: "Refresh out-of-date reports",
            text: "If data arrived after the report was generated (section 6), the ready report is marked with the warning “Shift data changed — generate a new report”. Files downloaded earlier do not update themselves — start a new run and hand that one to GIS MT.",
            image: { id: "exports-stale", caption: "A report went out of date after late data" },
          },
        ],
      },
      {
        id: "faq",
        heading: "9. Frequent questions",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The dashboard numbers change on their own",
                detail:
                  "Shifts are active: the stations keep sending scans and the summary is marked “Provisional data”. The final numbers come after the shifts are closed.",
              },
              {
                term: "The shift has no close button",
                detail:
                  "“Close shift” exists only for an active shift. A planned one can be edited or deleted (MKR-INS-08); a closed one can only be reported on.",
              },
              {
                term: "You cannot find the report button",
                detail:
                  "“Generate report” appears for a shift with the “Closed” status. An active shift has no reports — close the shift first.",
              },
              {
                term: "A report was ready and is now marked with a warning",
                detail:
                  "Data arrived from the station after it was generated — the shift is marked “Data after close” and the report is out of date. Generate a new one and use that.",
              },
              {
                term: "A report part will not download",
                detail:
                  "The download link is short-lived. Press “Download” on the part you need once more and the cabinet will issue a fresh link.",
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
