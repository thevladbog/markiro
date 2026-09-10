import type { LegalDocumentSource } from "../types.js";

export const CABINET_INVENTORY_PREP_CONTENT = {
  ru: {
    locale: "ru",
    title: "Кабинет: подготовка и запуск инвентаризации",
    summary:
      "Инструкция менеджера: создание задания инвентаризации, выписки Честного Знака, фиксация снимка, доступ терминалов и запуск.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инвентаризация — сплошной пересчёт продукции. Менеджер готовит задание в кабинете: выбирает продукт и линию, загружает выписки Честного Знака, фиксирует снимок ожидаемых кодов и запускает задание. После запуска операторы выполняют пересчёт на терминалах — их работа описана в инструкции MKR-INS-05.",
          },
          {
            kind: "paragraph",
            text: "Подготовка проходит пять этапов: «Параметры», «Выписки ЧЗ», «Проверка снимка», «Терминалы», «Запуск». Кабинет ведёт по ним последовательно и не даёт запустить задание, пока предыдущие этапы не завершены.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия организации, продуктов и линий в вашем кабинете будут другими.",
          },
        ],
      },
      {
        id: "create",
        heading: "2. Создание задания",
        blocks: [
          {
            kind: "step",
            title: "Откройте раздел «Инвентаризации»",
            text: "В боковом меню кабинета выберите «Инвентаризации». В списке видны все задания с номером и статусом, продуктом и датами, линией и способом инвентаризации.",
            image: { id: "list", caption: "Список инвентаризаций" },
          },
          {
            kind: "step",
            title: "Задайте параметры",
            text: "Нажмите «Создать инвентаризацию» и заполните параметры задания: продукт (ровно один), «Способ инвентаризации» — «Без переупаковки» или «С переупаковкой», линию, «Шаблон этикетки короба» и период дат производства: «Дата производства с» и «Дата производства по». Период применяется включительно.",
            image: { id: "parameters", caption: "Параметры задания инвентаризации" },
            expected: "Кабинет сохранил параметры и перевёл к этапу «Выписки ЧЗ».",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Способ определяет работу операторов: «Без переупаковки» — только сканирование, «С переупаковкой» — продукцию перекладывают в новые короба и печатают этикетки. Шаблон этикетки нужен именно для второго способа.",
          },
        ],
      },
      {
        id: "exports",
        heading: "3. Выписки Честного Знака",
        blocks: [
          {
            kind: "paragraph",
            text: "Снимок ожидаемых кодов собирается из выписок Честного Знака: нужен отдельный результат по каждому из шести статусов — «Эмитирован», «В обороте», «Нанесён», «Выбыл», «Списан», «Расформирован». Пустая выгрузка с нулём строк считается успешной: значит, кодов в этом статусе нет.",
          },
          {
            kind: "step",
            title: "Закажите выписки из Честного Знака",
            text: "Нажмите «Заказать из Честного Знака» — кабинет закажет отчёты по всем шести статусам и сам загрузит готовые файлы. Пока заказ выполняется, рядом со статусом появляется отметка о его ходе; когда файл получен и загружен, карточка статуса показывает «Готово», а до этого — «Нет файла».",
            image: { id: "exports", caption: "Выписки по статусам кодов" },
          },
          {
            kind: "step",
            title: "Устраните блокировку заказа",
            text: "Если заказ недоступен, кабинет перечисляет одну или несколько возможных причин — их может быть сразу несколько: «Укажите ИНН организации в реквизитах», «Укажите группу продукции Честного Знака в карточке товара», «Подключите агент КЭП в разделе «Интеграции»», «Обновите токен True API в разделе «Интеграции»». На снимке показана только одна из них — у вас причина или их набор могут быть другими. Исправьте указанное и повторите заказ.",
            image: {
              id: "exports-blocked",
              caption: "Заказ выписок заблокирован: одна из возможных причин",
            },
          },
          {
            kind: "step",
            title: "Загрузите файл вручную, если Честный Знак отказал",
            text: "Для статуса, который не удалось заказать, перетащите файл выписки в его карточку или нажмите на неё и выберите файл. Максимальный размер — 64 МБ. Сообщение «Файл не прошёл проверку. Проверьте формат, статус и содержимое выписки.» означает, что файл относится к другому статусу или повреждён.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Все шесть статусов обязательны. Пока хотя бы по одному нет ни заказанного, ни загруженного результата, перейти к проверке снимка нельзя.",
          },
        ],
      },
      {
        id: "snapshot",
        heading: "4. Проверка снимка",
        blocks: [
          {
            kind: "step",
            title: "Сверьте шесть выписок и зафиксируйте снимок",
            text: "Нажмите «Проверить снимок» на предыдущем этапе — кабинет откроет сводку с тремя показателями: «INTRODUCED» — сколько кодов найдено в статусе «В обороте», «Выписки ЧЗ» показывает, сколько из шести загрузок выбрано, а «Ожидаемый остаток» до фиксации показывает «Рассчитается после фиксации». Когда «Выписки ЧЗ» показывает 6 из 6, нажмите «Зафиксировать снимок» — сервер посчитает итоговые количества и создаст неизменяемый снимок ожидаемых кодов.",
            image: { id: "snapshot", caption: "Проверка снимка перед фиксацией" },
            expected: "Снимок зафиксирован, кабинет показывает число ожидаемых кодов.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Зафиксированный снимок изменить нельзя — он определяет, какие коды считаются ожидаемыми во всей инвентаризации. Проверьте состав выписок до фиксации.",
          },
        ],
      },
      {
        id: "terminals",
        heading: "5. Терминалы и форма-задание",
        blocks: [
          {
            kind: "step",
            title: "Проверьте готовность терминалов",
            text: "На этапе «Терминалы» кабинет открывает карточку «Доступ терминалов»: там видно, сколько терминалов назначено линии и сколько из них сейчас в сети. Задание появится на терминалах назначенной линии после запуска.",
            image: { id: "terminals", caption: "Доступ терминалов" },
          },
          {
            kind: "step",
            title: "Распечатайте форму-задание",
            text: "Кнопка «Открыть форму-задание» находится на предыдущем этапе «Терминалы». Нажмите её — откроется лист A4 со штрихкодом, показанный на этом снимке; распечатайте его. Операторы сканируют этот штрихкод на терминале, и задание открывается автоматически — без поиска в списке.",
            image: { id: "task-form", caption: "Печатная форма-задание со штрихкодом" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Передайте распечатанную форму на линию до запуска. Работа операторов по ней описана в инструкции MKR-INS-05.",
          },
        ],
      },
      {
        id: "launch",
        heading: "6. Запуск",
        blocks: [
          {
            kind: "step",
            title: "Остановите складские движения и запустите",
            text: "На этапе «Запуск» кабинет показывает, сколько кодов ожидается по снимку, и требует подтвердить, что движения по складу остановлены. Отметьте подтверждение и нажмите «Запустить инвентаризацию».",
            image: { id: "launch", caption: "Запуск инвентаризации" },
            expected: "Задание запущено и появилось на терминалах линии.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Приёмка и отгрузка во время пересчёта дают расхождения, которые придётся разбирать вручную. Останавливайте движения до запуска, а не после.",
          },
          {
            kind: "paragraph",
            text: "Дальнейший контроль хода, исправления, закрытие инвентаризации и итоговые документы описаны в отдельной инструкции по контролю и закрытию.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "7. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Нужный продукт есть в списке, но недоступен для выбора",
                detail:
                  "Продукт со статусом «Черновик» виден в списке, но выбрать его нельзя: в карточке товара в каталоге не заполнены группа продукции Честного Знака, вместимость короба или вместимость поддона. Заполните недостающие поля — статус сменится на «Активен», и продукт станет доступен для выбора. Продукты «Не используется» при этом доступны для выбора без каких-либо действий: инвентаризация — единственное место в кабинете, где архивный продукт можно взять в задание, чтобы посчитать остаток товара, снятого с производства.",
              },
              {
                term: "Честный Знак отклонил заказ статуса",
                detail:
                  "Загрузите файл для этого статуса вручную — кабинет прямо предлагает такой путь в сообщении об ошибке.",
              },
              {
                term: "Файл выписки не проходит проверку",
                detail:
                  "Проверьте, что выгрузка сделана по нужному статусу и продукту и не была отредактирована. Максимальный размер файла — 64 МБ.",
              },
              {
                term: "Терминалы не в сети перед запуском",
                detail:
                  "Запустить задание можно, но операторы увидят его только после подключения терминалов. Проверьте связь на линии до начала работ.",
              },
              {
                term: "Ошиблись в параметрах после фиксации снимка",
                detail:
                  "Снимок неизменяем. Создайте новое задание с верными параметрами; ошибочное задание останется в списке со статусом «Готова к запуску» — не запускайте его.",
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
    title: "Cabinet: preparing and launching an inventory",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Manager's guide: creating an inventory task, ordering the Chestny ZNAK exports, fixing the snapshot, checking terminal access and launching the task.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "An inventory is a full recount of products. The manager prepares the task in the cabinet: picks a product and a line, loads the Chestny ZNAK exports, fixes a snapshot of the expected codes and launches the task. After the launch, operators perform the recount on the terminals — their work is covered by instruction MKR-INS-05.",
          },
          {
            kind: "paragraph",
            text: "Preparation runs through five steps: “Parameters”, “Chestny ZNAK exports”, “Snapshot review”, “Stations”, “Launch”. The cabinet walks you through them in order and does not let you launch the task until the previous steps are finished.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots use demo data. The organization, product and line names in your cabinet will differ.",
          },
        ],
      },
      {
        id: "create",
        heading: "2. Creating the task",
        blocks: [
          {
            kind: "step",
            title: "Open the “Inventories” section",
            text: "In the cabinet's side menu choose “Inventories”. The list shows every task with its number and status, product and dates, line and inventory mode.",
            image: { id: "list", caption: "The inventory list" },
          },
          {
            kind: "step",
            title: "Set the parameters",
            text: "Press “Create inventory” and fill in the task parameters: the product (exactly one), “Inventory mode” — “Without repacking” or “With repacking”, the line, the “Box label template” and the production date range: “Production date from” and “Production date to”. The period is applied inclusively.",
            image: { id: "parameters", caption: "Inventory task parameters" },
            expected:
              "The cabinet saved the parameters and moved on to the “Chestny ZNAK exports” step.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The mode defines the operators' work: “Without repacking” means scanning only, “With repacking” means products are moved into new boxes and labels are printed for them. The label template is needed exactly for the second mode.",
          },
        ],
      },
      {
        id: "exports",
        heading: "3. Chestny ZNAK exports",
        blocks: [
          {
            kind: "paragraph",
            text: "The snapshot of expected codes is assembled from Chestny ZNAK exports: a separate result is required for each of the six statuses — “Emitted”, “Introduced”, “Applied”, “Retired”, “Written off”, “Disaggregated”. An empty export with zero rows counts as successful: it means there are no codes in that status.",
          },
          {
            kind: "step",
            title: "Order the exports from Chestny ZNAK",
            text: "Press “Order from Chestny ZNAK” — the cabinet orders the reports for all six statuses and downloads the finished files itself. While the order is running, a progress marker appears next to the status; once the file has been received and imported, the status card shows “Ready”, and until then it shows “Missing”.",
            image: { id: "exports", caption: "Exports by code status" },
          },
          {
            kind: "step",
            title: "Clear whatever blocks the order",
            text: "If ordering is unavailable, the cabinet lists one or more possible reasons — there can be several at once: “Enter the organization's INN in company details”, “Set the Chestny ZNAK product group on the product card”, “Pair a signer agent under Integrations”, “Refresh the True API token under Integrations”. The screenshot shows only one of them — your reason, or your set of reasons, may be different. Fix what is listed and order again.",
            image: {
              id: "exports-blocked",
              caption: "Ordering the exports is blocked: one of the possible reasons",
            },
          },
          {
            kind: "step",
            title: "Upload a file by hand if Chestny ZNAK refuses",
            text: "For a status you could not order, drag the export file onto its card or click the card and pick a file. The maximum size is 64 MB. The message “The file did not pass validation. Check its format, status, and contents.” means the file belongs to another status or is damaged.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "All six statuses are required. While at least one of them has neither an ordered nor an uploaded result, you cannot move on to the snapshot review.",
          },
        ],
      },
      {
        id: "snapshot",
        heading: "4. Snapshot review",
        blocks: [
          {
            kind: "step",
            title: "Check the six exports and fix the snapshot",
            text: "Press “Review snapshot” on the previous step — the cabinet opens a summary with three tiles: “INTRODUCED” is how many codes were found in the “Introduced” status (the cabinet prints this tile heading as the raw Chestny ZNAK status code, in both languages), “Chestny ZNAK exports” shows how many of the six uploads are selected, and “Expected stock” reads “Calculated after fixation” until the snapshot is fixed. When “Chestny ZNAK exports” shows 6 / 6, press “Fix snapshot” — the server calculates the final counts and creates an immutable snapshot of the expected codes.",
            image: { id: "snapshot", caption: "The snapshot review before fixation" },
            expected: "The snapshot is fixed and the cabinet shows the number of expected codes.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "A fixed snapshot cannot be changed — it defines which codes count as expected for the whole inventory. Check the set of exports before you fix it.",
          },
        ],
      },
      {
        id: "terminals",
        heading: "5. Terminals and the task form",
        blocks: [
          {
            kind: "step",
            title: "Check that the terminals are ready",
            text: "On the “Stations” step the cabinet opens the “Station access” card — in English the cabinet calls the line terminals stations. The card shows how many terminals are assigned to the line and how many of them are online right now. The task appears on the terminals of the assigned line after the launch.",
            image: { id: "terminals", caption: "Terminal access on the line" },
          },
          {
            kind: "step",
            title: "Print the task form",
            text: "The “Open task form” button sits on the previous step, “Stations”. Press it — the A4 sheet with a barcode shown in this screenshot opens; print it. Operators scan this barcode on the terminal and the task opens automatically, with no searching in the list. The system issues this printed form in Russian only: the sheet is headed “Задание на инвентаризацию” (inventory task) whichever interface language you use, and there is no English print form yet.",
            image: { id: "task-form", caption: "The printed task form with a barcode" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Hand the printed form to the line before the launch. How operators work with it is covered by instruction MKR-INS-05.",
          },
        ],
      },
      {
        id: "launch",
        heading: "6. Launch",
        blocks: [
          {
            kind: "step",
            title: "Stop the warehouse movements and launch",
            text: "On the “Launch” step the cabinet shows how many codes the snapshot expects and requires you to confirm that warehouse movements are stopped. Tick “Warehouse movements are stopped” and press “Start inventory”.",
            image: { id: "launch", caption: "Launching the inventory" },
            expected: "The task is launched and has appeared on the terminals of the line.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Receiving and shipping during the recount create discrepancies that then have to be sorted out by hand. Stop the movements before the launch, not after it.",
          },
          {
            kind: "paragraph",
            text: "Watching the progress, making corrections, closing the inventory and the final documents are covered by a separate instruction on monitoring and closing.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "7. Common questions",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The product you need is in the list but cannot be selected",
                detail:
                  "A product with the “Draft” status is visible in the list but cannot be selected: its catalog card has no Chestny ZNAK product group, box capacity or pallet capacity. Fill in the missing fields — the status changes to “Active” and the product becomes selectable. Products marked “Not in use” are selectable as they are: the inventory is the only place in the cabinet where an archived product can be taken into a task, so that the stock of a discontinued product can be counted.",
              },
              {
                term: "Chestny ZNAK rejected the order for a status",
                detail:
                  "Upload the file for this status by hand — the cabinet offers exactly that route in the error message.",
              },
              {
                term: "The export file does not pass validation",
                detail:
                  "Check that the export was made for the right status and product and has not been edited. The maximum file size is 64 MB.",
              },
              {
                term: "The terminals are offline before the launch",
                detail:
                  "You can still launch the task, but operators will only see it once the terminals reconnect. Check the connection on the line before work starts.",
              },
              {
                term: "You got the parameters wrong after fixing the snapshot",
                detail:
                  "The snapshot is immutable. Create a new task with the correct parameters; the wrong task stays in the list with the “Ready to start” status — do not launch it.",
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
