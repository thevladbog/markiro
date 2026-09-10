import type { LegalDocumentSource } from "../types.js";

export const CABINET_INVENTORY_CLOSE_CONTENT = {
  ru: {
    locale: "ru",
    title: "Кабинет: контроль, закрытие и документы инвентаризации",
    summary:
      "Инструкция менеджера после запуска инвентаризации: наблюдение за ходом, исправления, закрытие, поздние события, итоговые документы и завершение.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает работу менеджера после запуска инвентаризации: наблюдение за ходом пересчёта, исправления, закрытие задания, разбор поздних событий, формирование итоговых документов и завершение. Подготовка и запуск описаны в инструкции MKR-INS-06, работа операторов на терминалах — в MKR-INS-05.",
          },
          {
            kind: "paragraph",
            text: "Задание проходит три состояния: «В работе» — идёт пересчёт; «Закрыта» — результат зафиксирован, но ещё можно разобрать поздние события и сформировать документы; «Завершена» — работа окончена, изменения недоступны.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Номера, количества и названия в вашем кабинете будут другими.",
          },
        ],
      },
      {
        id: "live",
        heading: "2. Ход инвентаризации",
        blocks: [
          {
            kind: "step",
            title: "Следите за счётчиками и участниками",
            text: "Страница инвентаризации показывает текущие результаты: «Ожидается», «Проверено», «Не найдено», «Расхождения». Ниже видно участников — терминалы, работающие по заданию, и имена операторов на них — и их текущее состояние: на снимке это «В работе» и «Нет связи»; кабинет также показывает статус, когда оператор выходит из задания. Панели «Новые короба» и «Последние события» показывают ход пересчёта по коробам — вместе с состоянием печати каждого — и недавние сканы.",
            image: { id: "live", caption: "Ход инвентаризации: счётчики, участники, короба" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Строка о несинхронизированных событиях означает, что часть сканов ещё не дошла с терминалов. Это нормально при слабой связи: дождитесь синхронизации, прежде чем судить о расхождениях.",
          },
        ],
      },
      {
        id: "corrections",
        heading: "3. Исправления",
        blocks: [
          {
            kind: "paragraph",
            text: "Исправления доступны, только пока инвентаризация идёт. Каждое действие требует причину и сохраняется как неизменяемое аудиторское свидетельство: саму запись отменить нельзя. У части действий есть встречное — отменённый скан восстанавливается, дату можно указать заново; у остальных встречного действия нет.",
          },
          {
            kind: "step",
            title: "Найдите нужное событие и выберите действие",
            text: "Откройте «Исправления». События собраны в панели «События сканирования»: вкладка «Расхождения» показывает только позиции, требующие внимания, «Все сканирования» — весь список; найти конкретный скан помогают поиск и фильтры «Тип события» и «Классификация». Каждое событие подписано кодом в читаемом виде, полный код копируется кнопкой «Копировать код». Набор кнопок зависит от состояния позиции: у одного события это «Отменить скан» и «Изменить дату», у другого — «Отменить скан» и «Убрать из короба», у уже отменённого — только «Восстановить скан», а у части событий действий нет вовсе. Флажки слева и «Выбрать страницу» позволяют отменить сканы или изменить дату сразу у нескольких событий — кнопки пакетного действия появляются после выбора, а причина и результат сохраняются в аудите отдельно для каждого затронутого кода. В панели «Новые короба» действие «Аннулировать короб» есть у каждого ещё не аннулированного короба, а «Поставить перепечать в очередь» — только у закрытого и напечатанного.",
            image: {
              id: "corrections-list",
              caption: "Исправления: события сканирования и короба",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "«Аннулировать короб» — необратимое действие: обратного исправления для него нет, и кабинет не переспрашивает — короб аннулируется сразу после указания причины. Короб, аннулированный из кабинета, навсегда остаётся блокировкой закрытия: такую инвентаризацию можно будет закрыть только аварийно, а сам короб и его состав не попадут в итоговые документы по коробам. Сверяйте номер короба до сохранения. Короб может оказаться аннулированным и без вашего участия — кабинет помечает такой «Аннулирован (конфликт сканов)», а аннулированный из кабинета — «Аннулирован (из кабинета)». Первый ещё можно вернуть в работу на линии, см. раздел 4.",
          },
          {
            kind: "step",
            title: "Укажите причину и сохраните",
            text: "Под списком откроется форма «Исправление» с выбранным кодом. Заполните «Причина исправления» — поле обязательно, — а для смены даты ещё и «Новая дата производства». Кнопка подтверждения названа по действию — на снимке это «Изменить дату». Нажмите её — запись уйдёт в аудит.",
            image: { id: "corrections-form", caption: "Форма исправления с причиной" },
            expected: "Кабинет сообщил, что исправление сохранено в аудите.",
          },
        ],
      },
      {
        id: "close",
        heading: "4. Закрытие инвентаризации",
        blocks: [
          {
            kind: "step",
            title: "Запустите проверку перед закрытием",
            text: "Нажмите «Закрыть инвентаризацию». Система проверит терминалы, локальные очереди, короба и обязательные расхождения. Безопасное закрытие доступно, только когда не осталось ни одной блокировки: операторы вышли из задания, очереди терминалов пусты, все короба закрыты и напечатаны, расхождений нет. Тогда кабинет сообщит, что блокировок нет и результат будет зафиксирован в текущей ревизии, — нажмите «Закрыть безопасно».",
            image: { id: "close-ready", caption: "Проверка перед закрытием: блокировок нет" },
            expected: "Инвентаризация закрыта, результат зафиксирован.",
          },
          {
            kind: "step",
            title: "Разберите блокировки",
            text: "Кабинет перечисляет, что мешает закрытию. Блокировки со снимка снимаются на линии: «Активные терминалы» и «Терминалы без связи» — попросите операторов выйти из задания; «Несинхронизированные события» — дождитесь, пока терминалы догрузят сканы; «Открытые короба» и «Открытые короба по данным терминалов» — попросите закрыть короба. Так же снимается и незавершённая печать коробов: блокировка уходит, когда терминал допечатает этикетку. Когда причина устранена, повторите проверку.",
            image: { id: "close-blocked", caption: "Проверка перед закрытием: список блокировок" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Ещё две блокировки снимаются не так просто. Аннулированные короба кабинет перечисляет двумя отдельными строками, и что с ними делать, зависит от того, какая строка перед вами. «Короба, аннулированные при конфликте сканов» — их система аннулировала сама; оператор может вернуть такой короб в работу с терминала, о чём кабинет и пишет подсказкой под строкой, — тогда блокировка снимется, но собирать короб придётся заново (это описано в инструкции MKR-INS-05). «Короба, аннулированные из кабинета» — это ваше собственное действие «Аннулировать короб»; отменить его нельзя, и такая блокировка останется до аварийного закрытия. Тот же признак стоит и у самого короба в панели «Новые короба» и на странице «Исправления»: «Аннулирован (конфликт сканов)» или «Аннулирован (из кабинета)». Обязательные расхождения без решения разбираются в кабинете. Неизвестный и не учитываемый скан снимает кнопка «Отменить скан»: отменённые сканы не считаются расхождением и закрытию не мешают, а если отменили лишнее — «Восстановить скан» вернёт код в исходную категорию. Расхождение по дате производства снимает «Изменить дату»: блокировка уходит, когда указанная дата совпадает с датой из снимка. У кода, который лежит в открытом коробе, этой кнопки сразу нет — сначала нажмите «Убрать из короба», после чего «Изменить дату» появится; у кода в закрытом или аннулированном коробе нет и «Убрать из короба» — такое расхождение тоже закрывается кнопкой «Отменить скан». Неустранимой остаётся только блокировка коробов, аннулированных из кабинета: с ней задание закрывается аварийно.",
          },
          {
            kind: "step",
            title: "Аварийное закрытие — только когда блокировки устранить нельзя",
            text: "Если ждать нельзя (например, терминал вышел из строя), доступно аварийное закрытие: заполните «Причина аварийного закрытия» и подтвердите «Я понимаю, что блокировки останутся в зафиксированном результате», затем нажмите «Закрыть аварийно».",
            image: { id: "close-emergency", caption: "Аварийное закрытие с обязательной причиной" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Аварийное закрытие не устраняет блокировки: вы подтверждаете, что они «останутся в зафиксированном результате». В самих документах их не будет — итоговые документы не содержат ни списка блокировок, ни причины аварийного закрытия, они остаются только в задании и в аудите. Последствия видны иначе: короба, оставшиеся открытыми или аннулированными, вообще не попадут в документы по коробам, а коды, сканы которых не успели дойти с терминалов, останутся ненайденными и попадут в список кодов к списанию. Пользуйтесь этим путём, только когда обычное закрытие действительно невозможно.",
          },
        ],
      },
      {
        id: "late-events",
        heading: "5. Поздние события",
        blocks: [
          {
            kind: "step",
            title: "Разберите пакеты, пришедшие после закрытия",
            text: "События, догнавшие сервер после закрытия, собираются в пакеты со статусом «Требует решения». Отметьте нужные пакеты, укажите «Причина решения» и нажмите «Исключить выбранные» — так они не будут учтены в результате. За один раз можно выбрать не более 100 пакетов. Если нужно переобработать данные целиком, используйте кнопку «Возобновить для повторной обработки»: она возвращает в работу всю инвентаризацию, а не только выбранный пакет, и работает так же, как кнопка «Возобновить» из раздела 7 — ревизия результата увеличится, отметки о закрытии будут сняты, а уже сформированные документы аннулируются и станут недоступны для скачивания (см. раздел 7).",
            image: { id: "late-events", caption: "Поздние события: пакеты и решения" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Пока есть пакеты со статусом «Требует решения», завершить инвентаризацию нельзя — кабинет попросит сначала обработать поздние события.",
          },
        ],
      },
      {
        id: "documents",
        heading: "6. Итоговые документы",
        blocks: [
          {
            kind: "step",
            title: "Выберите форматы и сформируйте документы",
            text: "После закрытия откройте «Итоговые документы», в блоке «Что сформировать» отметьте нужные форматы из утверждённого каталога и нажмите «Сформировать документы».",
            image: { id: "documents-catalog", caption: "Выбор форматов итоговых документов" },
          },
          {
            kind: "step",
            title: "Дождитесь готовности и скачайте",
            text: "В блоке «История формирования» видно состояние каждого запуска, например «Формируется» или «Готово» — встречаются и другие состояния, включая постановку в очередь и ошибку формирования. Готовые документы скачиваются по одному или кнопкой «Скачать ZIP». Если формирование не удалось, кнопка повтора появляется не при всякой ошибке: когда её нет, отметьте форматы в блоке «Что сформировать» и сформируйте документы заново.",
            image: { id: "documents-history", caption: "История формирования и скачивание" },
            expected: "Все документы текущего результата скачаны.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Документы привязаны к ревизии результата. Если инвентаризацию возобновить, ранее сформированные документы аннулируются и их больше не скачать. Задание при этом возвращается в работу, поэтому сформировать документы заново получится только после повторного закрытия.",
          },
        ],
      },
      {
        id: "completion",
        heading: "7. Завершение и возобновление",
        blocks: [
          {
            kind: "step",
            title: "Завершите инвентаризацию",
            text: "Когда документы скачаны и проверены, отметьте «Итоговые документы скачаны и проверены» и нажмите «Завершить инвентаризацию». После завершения задание становится недоступным для изменений.",
            image: { id: "completion", caption: "Завершение инвентаризации" },
            expected: "Инвентаризация завершена.",
          },
          {
            kind: "step",
            title: "Возобновляйте только при реальной необходимости",
            text: "Закрытую инвентаризацию можно возобновить кнопкой «Возобновить». Кабинет перечислит последствия и попросит подтверждение «Подтвердить возобновление». Возобновление увеличивает ревизию результата и снимает отметки о закрытии; уже сформированные итоговые документы аннулируются и становятся недоступны для скачивания — после повторного закрытия их придётся сформировать заново; ожидающие поздние события снова можно будет обработать. Подтверждайте, только если готовы пересобрать результат и документы заново.",
            image: { id: "reopen", caption: "Подтверждение возобновления инвентаризации" },
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
                term: "Кнопка закрытия не срабатывает из-за терминалов",
                detail:
                  "Операторы ещё в задании или терминал потерял связь. Попросите выйти из задания и дождитесь синхронизации, затем повторите проверку.",
              },
              {
                term: "Расхождений больше, чем ожидалось",
                detail:
                  "Сначала дождитесь синхронизации всех событий: несинхронизированные сканы не учтены в счётчиках. Оставшиеся расхождения разбираются исправлениями: ошибочный или чужой скан снимает «Отменить скан» — отменённые сканы расхождением не считаются, — а расхождение по дате производства закрывает «Изменить дату» (см. раздел 4).",
              },
              {
                term: "Завершение недоступно",
                detail:
                  "Завершение открывается после того, как итоговые документы сформированы, скачаны и отмечены как проверенные, а поздние события обработаны.",
              },
              {
                term: "Документы отмечены как аннулированные",
                detail:
                  "Инвентаризацию возобновляли — документы относятся к предыдущей ревизии результата, и скачать их уже нельзя. Закройте задание ещё раз, затем сформируйте документы заново и скачайте.",
              },
              {
                term: "Ошиблись в исправлении",
                detail:
                  "Исправления неизменяемы и остаются в аудите. Отменённый скан вернёт кнопка «Восстановить скан», дату можно указать заново — история сохранит оба действия. Для «Аннулировать короб» встречного действия нет: короб останется аннулированным, и закрыть инвентаризацию получится только аварийно.",
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
    title: "Cabinet: monitoring, closing and inventory documents",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Manager's guide for the work after an inventory is launched: watching the progress, corrections, closing, late events, final documents and completion.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the manager's work after an inventory is launched: watching the recount progress, corrections, closing the task, resolving late events, generating the final documents and completing the inventory. Preparation and launch are covered by instruction MKR-INS-06, and the operators' work on the terminals by MKR-INS-05.",
          },
          {
            kind: "paragraph",
            text: "A task goes through three states: “Running” — the recount is under way; “Closed” — the result is frozen, but late events can still be resolved and documents generated; “Completed” — the work is over and no changes are possible.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots use demo data. The numbers, quantities and names in your cabinet will differ.",
          },
        ],
      },
      {
        id: "live",
        heading: "2. Inventory progress",
        blocks: [
          {
            kind: "step",
            title: "Watch the counters and the participants",
            text: "The inventory page shows the current results: “Expected”, “Verified”, “Missing”, “Discrepancies”. Below them you see the participants — the terminals working on the task and the names of the operators on them — and their current state: in the screenshot these are “Active” and “Offline”; the cabinet also shows a state when an operator leaves the task. The “New boxes” and “Recent events” panels show the recount progress box by box — together with the print state of each — and the recent scans.",
            image: {
              id: "live",
              caption: "Inventory progress: counters, participants, boxes",
            },
          },
          {
            kind: "callout",
            tone: "info",
            text: "A line about unsynced events means that some of the scans have not reached the server from the terminals yet. This is normal on a weak connection: wait for the sync before judging the discrepancies.",
          },
        ],
      },
      {
        id: "corrections",
        heading: "3. Corrections",
        blocks: [
          {
            kind: "paragraph",
            text: "Corrections are available only while the inventory is running. Every action requires a reason and is retained as immutable audit evidence: the record itself cannot be revoked. Some actions have a counterpart — a voided scan can be restored and a date can be set again; the rest have no counterpart.",
          },
          {
            kind: "step",
            title: "Find the event you need and pick an action",
            text: "Open “Corrections”. The events are gathered in the “Scan events” panel: the “Discrepancies” tab shows only the items that need attention, “All scans” shows the whole list; the search and the “Event type” and “Classification” filters help you find a particular scan. Every event is labelled with its code in a readable form, and the full code is copied with the “Copy code” button. The set of buttons depends on the state of the item: on one event these are “Void scan” and “Change date”, on another “Void scan” and “Remove from box”, on an already voided one only “Restore scan”, and some events have no actions at all. The checkboxes on the left and “Select page” let you void scans or change the date on several events at once — the batch action buttons appear once you make a selection, and the reason and the outcome are recorded in the audit trail separately for every affected code. In the “New boxes” panel, “Invalidate box” is available on every box that has not been invalidated yet, while “Queue reprint request” is available only on a box that is closed and printed.",
            image: {
              id: "corrections-list",
              caption: "Corrections: scan events and boxes",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "“Invalidate box” is irreversible: there is no counter-correction for it, and the cabinet does not ask again — the box is invalidated as soon as you give a reason. A box invalidated from the cabinet stays a closing blocker forever: such an inventory can then only be closed as an emergency, and the box itself and its contents will not appear in the final box documents. Check the box number before saving. A box may also turn out invalidated without you — the cabinet marks such a box “Invalidated (scan conflict)”, and one invalidated from the cabinet “Invalidated (from the cabinet)”. The first one can still be returned to work on the line, see section 4.",
          },
          {
            kind: "step",
            title: "Give a reason and save",
            text: "The “Correction” form with the selected code opens below the list. Fill in “Correction reason” — the field is required — and, for a date change, also “New production date”. The confirmation button is named after the action — in the screenshot it is “Change date”. Press it and the record goes to the audit trail.",
            image: { id: "corrections-form", caption: "The correction form with a reason" },
            expected: "The cabinet reported that the correction was saved to the audit trail.",
          },
        ],
      },
      {
        id: "close",
        heading: "4. Closing the inventory",
        blocks: [
          {
            kind: "step",
            title: "Run the pre-close check",
            text: "Press “Close inventory”. The system checks the stations, the local queues, the boxes and the required discrepancies. A safe close is available only when not a single blocker is left: the operators have left the task, the terminal queues are empty, every box is closed and printed, and there are no discrepancies. The cabinet then reports that there are no blockers and that the result will freeze at the current revision — press “Close safely”.",
            image: { id: "close-ready", caption: "The pre-close check: no blockers" },
            expected: "The inventory is closed and the result is frozen.",
          },
          {
            kind: "step",
            title: "Resolve the blockers",
            text: "The cabinet lists what stands in the way of closing. The blockers in the screenshot are cleared on the line: “Active stations” and “Offline stations” — ask the operators to leave the task; “Unsynced events” — wait until the terminals upload the scans; “Open boxes” and “Open boxes reported by stations” — ask for the boxes to be closed. Unfinished box printing is cleared the same way: the blocker goes away once the terminal finishes printing the label. Once the cause is gone, run the check again.",
            image: { id: "close-blocked", caption: "The pre-close check: the list of blockers" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Two more blockers are not that easy to clear. The cabinet lists invalidated boxes as two separate lines, and what to do with them depends on which line you are looking at. “Boxes invalidated by a scan conflict” — the system invalidated those itself; an operator can return such a box to work from the terminal, which the cabinet says in a hint under the line — the blocker then clears, but the box has to be packed again (this is covered by instruction MKR-INS-05). “Boxes invalidated from the cabinet” is your own “Invalidate box” action; it cannot be undone, and that blocker stays until an emergency close. The same marker is shown on the box itself in the “New boxes” panel and on the “Corrections” page: “Invalidated (scan conflict)” or “Invalidated (from the cabinet)”. Required discrepancies without a decision are resolved in the cabinet. An unknown or ineligible scan is cleared by the “Void scan” button: voided scans do not count as a discrepancy and do not stand in the way of closing, and if you voided too much, “Restore scan” returns the code to its original category. A production-date discrepancy is cleared by “Change date”: the blocker goes away once the date you set matches the date from the snapshot. A code that lies in an open box has no such button at first — press “Remove from box” first and “Change date” appears; a code in a closed or invalidated box has no “Remove from box” either, and such a discrepancy is closed with the “Void scan” button as well. Only the blocker of boxes invalidated from the cabinet cannot be cleared: with it the task is closed as an emergency.",
          },
          {
            kind: "step",
            title: "An emergency close — only when the blockers cannot be cleared",
            text: "If waiting is not an option (a terminal broke down, for example), an emergency close is available: fill in “Emergency close reason”, confirm “I understand that the blockers will remain in the frozen result”, then press “Emergency close”.",
            image: {
              id: "close-emergency",
              caption: "An emergency close with a mandatory reason",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "An emergency close does not clear the blockers: you confirm that they “will remain in the frozen result”. They will not be in the documents themselves — the final documents contain neither the list of blockers nor the reason for the emergency close, and both stay in the task and in the audit trail. The consequences show up differently: boxes left open or invalidated will not appear in the box documents at all, and the codes whose scans did not make it from the terminals stay missing and end up in the list of codes to write off. Use this path only when a normal close is truly impossible.",
          },
        ],
      },
      {
        id: "late-events",
        heading: "5. Late events",
        blocks: [
          {
            kind: "step",
            title: "Resolve the batches that arrived after the close",
            text: "Events that caught up with the server after the close are gathered into batches with the “Decision required” status. Tick the batches you need, give a “Decision reason” and press “Exclude selected” — they will then not be counted in the result. No more than 100 batches can be selected at a time. If the data has to be reprocessed as a whole, use the “Reopen for replay” button: it returns the whole inventory to work rather than the selected batch alone, and works the same way as the “Reopen” button from section 7 — the result revision will increase, the close details will be cleared, and the documents that were already generated will be invalidated and can no longer be downloaded (see section 7).",
            image: { id: "late-events", caption: "Late events: batches and decisions" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "While there are batches with the “Decision required” status, the inventory cannot be completed — the cabinet will ask you to resolve the late events first.",
          },
        ],
      },
      {
        id: "documents",
        heading: "6. Final documents",
        blocks: [
          {
            kind: "step",
            title: "Pick the formats and generate the documents",
            text: "After the close, open “Final documents”, tick the formats you need from the approved catalog under “Documents to generate” and press “Generate documents”.",
            image: { id: "documents-catalog", caption: "Picking the final document formats" },
          },
          {
            kind: "step",
            title: "Wait until they are ready and download them",
            text: "The “Generation history” block shows the state of every run, for example “Processing” or “Ready” — other states occur too, including queuing and a generation failure. Ready documents are downloaded one by one or with the “Download ZIP” button. If the generation failed, the retry button does not appear for every error: when it is missing, tick the formats under “Documents to generate” and generate the documents again.",
            image: { id: "documents-history", caption: "The generation history and downloading" },
            expected: "Every document of the current result has been downloaded.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Documents are bound to the result revision. If the inventory is reopened, the documents generated earlier are invalidated and can no longer be downloaded. The task returns to work at the same time, so the documents can only be generated again after another close.",
          },
        ],
      },
      {
        id: "completion",
        heading: "7. Completion and reopening",
        blocks: [
          {
            kind: "step",
            title: "Complete the inventory",
            text: "Once the documents are downloaded and checked, tick “Final documents have been downloaded and checked” and press “Complete inventory”. After completion the task can no longer be changed.",
            image: { id: "completion", caption: "Completing the inventory" },
            expected: "The inventory is completed.",
          },
          {
            kind: "step",
            title: "Reopen only when it is truly necessary",
            text: "A closed inventory can be reopened with the “Reopen” button. The cabinet lists the consequences and asks for a “Confirm reopen”. Reopening increases the result revision and clears the close details; the final documents that were already generated are invalidated and can no longer be downloaded — after another close they have to be generated again; pending late events become available for processing again. Confirm only if you are ready to rebuild the result and the documents from scratch.",
            image: { id: "reopen", caption: "Confirming the inventory reopen" },
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
                term: "The close button does not work because of the terminals",
                detail:
                  "The operators are still in the task or a terminal has lost the connection. Ask them to leave the task and wait for the sync, then run the check again.",
              },
              {
                term: "There are more discrepancies than expected",
                detail:
                  "First wait until every event is synced: unsynced scans are not counted in the counters. The remaining discrepancies are resolved with corrections: a mistaken or foreign scan is cleared by “Void scan” — voided scans do not count as a discrepancy — and a production-date discrepancy is closed by “Change date” (see section 4).",
              },
              {
                term: "Completion is unavailable",
                detail:
                  "Completion opens up after the final documents are generated, downloaded and marked as checked, and the late events are resolved.",
              },
              {
                term: "The documents are marked as invalidated",
                detail:
                  "The inventory was reopened — the documents belong to the previous result revision and can no longer be downloaded. Close the task once more, then generate the documents again and download them.",
              },
              {
                term: "Made a mistake in a correction",
                detail:
                  "Corrections are immutable and stay in the audit trail. A voided scan is brought back by the “Restore scan” button and a date can be set again — the history keeps both actions. “Invalidate box” has no counterpart: the box stays invalidated, and the inventory can then only be closed as an emergency.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "If your problem is not listed above, contact Markiro support: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
