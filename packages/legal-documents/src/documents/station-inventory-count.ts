import type { LegalDocumentSource } from "../types.js";

export const STATION_INVENTORY_COUNT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция сканирования: инвентаризация на терминале",
    summary:
      "Инструкция оператора для инвентаризации: открытие задания, проверка продукции и вердикты сканирования, переупаковка коробов с печатью этикеток, выход из задания.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инвентаризация — сплошной пересчёт продукции на складе или линии. Задание готовит и запускает менеджер в кабинете, а оператор выполняет пересчёт на терминале: сканирует продукцию, а при необходимости перекладывает её в новые короба. Инструкция описывает работу оператора; вход на станцию — в инструкции MKR-INS-01.",
          },
          {
            kind: "paragraph",
            text: "Задание бывает двух способов: «Без переупаковки» — продукцию только сканируют, короба остаются прежними; «С переупаковкой» — проверенную продукцию перекладывают в новые короба и печатают на них этикетки. Способ выбирает менеджер при создании задания, оператор его не меняет.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Номера заданий, коробов и продукты на вашем терминале будут отличаться.",
          },
        ],
      },
      {
        id: "open-task",
        heading: "2. Открытие задания",
        blocks: [
          {
            kind: "step",
            title: "Откройте складские операции",
            text: "На экране выбора смены переключитесь на «Складские операции». Терминал покажет задания инвентаризации своей линии и предложит отсканировать штрихкод формы-задания.",
            image: {
              id: "task-selection",
              caption: "Складские операции: задания инвентаризации линии",
            },
          },
          {
            kind: "step",
            title: "Отсканируйте штрихкод формы-задания",
            text: "Возьмите распечатанную форму-задание, которую подготовил менеджер, и отсканируйте её штрихкод — задание откроется автоматически. Если формы нет, выберите задание в списке кнопкой «Продолжить».",
            expected:
              "Терминал открыл экран «Проверка продукции» — задание загружено и работает без сети.",
          },
          {
            kind: "step",
            title: "Подтвердите задание другой линии",
            text: "Если штрихкод относится к заданию другой линии, терминал запросит подтверждение. Открывайте такое задание только по указанию мастера: инвентаризацию считают по назначенной линии.",
            image: { id: "other-line", caption: "Подтверждение задания другой линии" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "После сохранения снимка терминал работает автономно: пересчёт продолжается без сети, а результаты уходят на сервер при восстановлении связи.",
          },
        ],
      },
      {
        id: "verdicts",
        heading: "3. Проверка продукции и вердикты",
        blocks: [
          {
            kind: "paragraph",
            text: "На экране «Проверка продукции» сканируйте бутылку или короб. Скан короба отмечает проверенным всё известное содержимое — это быстрее, чем сканировать бутылки по одной. Счётчики показывают «Проверено», «Расхождения» и «Защищено от учёта».",
          },
          {
            kind: "step",
            title: "«Код принят» и «Короб принят»",
            text: "Зелёный вердикт означает, что позиция учтена. При скане короба терминал сообщает «Короб принят: N кодов» — отдельно сканировать его содержимое не нужно.",
            image: { id: "box-accepted", caption: "Короб принят целиком" },
          },
          {
            kind: "step",
            title: "«Код отсутствует в исходном снимке» — расхождение",
            text: "Продукция есть на складе, но её нет в снимке задания. Скан сохраняется как расхождение — отложите такую продукцию отдельно и продолжайте пересчёт. Разбираться с расхождениями будет менеджер.",
            image: { id: "not-in-snapshot", caption: "Расхождение: кода нет в снимке задания" },
          },
          {
            kind: "step",
            title: "«Код не учтён: уже в отгрузке»",
            text: "Код защищён от учёта: продукция уже отгружена или выведена из оборота. Терминал её не засчитывает — уберите такую продукцию из пересчитываемой партии.",
            image: { id: "protected", caption: "Защищённый код: продукция уже в отгрузке" },
          },
          {
            kind: "step",
            title: "«Код не участвует в инвентаризации»",
            text: "Продукция не подходит под параметры задания: другой продукт или дата производства вне заданного периода. В пересчёт она не идёт — отложите её и продолжайте.",
            image: { id: "ineligible", caption: "Код не участвует в этом задании" },
          },
          {
            kind: "step",
            title: "«ДУБЛЬ» — код уже проверен",
            text: "«Код уже проверен на этом терминале» или «Код уже проверен на другом терминале» означает, что позицию посчитали раньше. Повторно её не сканируйте и не перекладывайте: она уже учтена.",
            image: { id: "duplicate", caption: "Дубль: код уже проверен на другом терминале" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "«Код не распознан» — отсканирован не код маркировки: расправьте упаковку и повторите скан. «Скан не сохранён — повторите сканирование» означает, что терминал не записал результат: повторите скан этой же позиции.",
          },
        ],
      },
      {
        id: "production-date",
        heading: "4. Дата производства",
        blocks: [
          {
            kind: "paragraph",
            text: "Терминал приписывает сканы к активной дате производства и берёт её из самой продукции: дата розлива каждого кода известна из снимка задания. Выставлять дату вручную перед началом работы не нужно — следите за подсказками терминала.",
          },
          {
            kind: "step",
            title: "Просто начните сканировать",
            text: "Первый скан на терминале сам задаёт активную дату по дате отсканированного кода — подтверждать ничего не требуется. До первого скана в поле «Дата производства» стоит начало периода задания; первый же скан заменяет его настоящей датой продукции.",
          },
          {
            kind: "step",
            title: "Дата кода не совпала с активной",
            text: "Если дата отсканированного кода расходится с активной, терминал не засчитывает скан и показывает «Дата в коде отличается от активной». Нажмите «Установить ДД.ММ.ГГГГ и зачесть», чтобы переключить активную дату на дату кода и сразу зачесть эту бутылку, — так переходят к продукции другой даты. Кнопка «Пропустить код» ничего не записывает: отложите бутылку и продолжайте. Пока окно открыто, сканер придержан — следующие сканы не пройдут, пока вы не ответите.",
            image: {
              id: "source-date-mismatch",
              caption: "Дата кода не совпадает с активной датой",
            },
            expected: "Скан не записан ни в одном из вариантов, пока вы не выбрали действие.",
          },
          {
            kind: "step",
            title: "В коробе несколько дат розлива",
            text: "Если в отсканированном коробе лежит продукция разных дат, подставить одну дату нельзя — терминал показывает «В коробе несколько дат розлива». «Зачесть как есть» учитывает короб целиком с текущей активной датой, а расхождения по датам разберёт менеджер. «Пропустить код» оставляет короб неучтённым — тогда разберите его и отсканируйте бутылки по одной.",
            image: { id: "mixed-box", caption: "Короб содержит несколько дат розлива" },
          },
          {
            kind: "step",
            title: "Дата при переупаковке",
            text: "При переупаковке дата нового короба берётся из содержимого старого: если вся продукция в нём одной даты, новый короб откроется сразу с ней. Когда дата бутылки расходится с датой короба, терминал показывает «Дата кода отличается от даты короба». Пока новый короб пуст, доступна кнопка «Установить ДД.ММ.ГГГГ и зачесть» — она задаёт дату короба по бутылке. Если в коробе уже есть бутылки, смешивать даты нельзя: терминал сообщит «В коробе уже есть бутылки другой даты. Закройте или очистите короб.» — остаются «Пропустить код» и кнопка «Исправления».",
            image: {
              id: "repack-source-date",
              caption: "Переупаковка: дата бутылки не совпадает с датой короба",
            },
          },
          {
            kind: "step",
            title: "Переключите дату вручную",
            text: "Ручное переключение нужно, только когда терминал дату не подставил. Нажмите «Изменить» рядом с датой, выберите нужную и подтвердите кнопкой «Применить дату». Новая дата действует со следующего принятого скана — уже сделанные сканы не меняются.",
            image: { id: "date-change", caption: "Смена даты производства" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если под сообщением о расхождении терминал добавил «Дата кода вне диапазона задания», кнопка «Установить ДД.ММ.ГГГГ и зачесть» не появится: такая продукция в это задание не входит. Отложите её и нажмите «Пропустить код».",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "При переупаковке кнопка «Применить дату» недоступна, пока в открытом коробе есть бутылки, — терминал покажет «Сначала закройте неполный короб или очистите его». Закройте короб или очистите его через панель «Исправления», а затем меняйте дату.",
          },
        ],
      },
      {
        id: "repack",
        heading: "5. Способ «С переупаковкой»",
        blocks: [
          {
            kind: "step",
            title: "Отсканируйте старый короб",
            text: "Переупаковка идёт коробами: сначала отсканируйте этикетку старого короба, из которого перекладываете продукцию.",
            image: {
              id: "repack-old-box",
              caption: "Переупаковка: терминал ждёт скан старого короба",
            },
            expected: "Терминал показал «Старый короб выбран» и открыл новый короб.",
          },
          {
            kind: "step",
            title: "Сканируйте каждую бутылку в новый короб",
            text: "Перекладывайте продукцию по одной, сканируя каждую единицу: терминал показывает занятые и свободные места в открытом коробе. «Бутылка добавлена в новый короб» — позиция уложена; «Скан сохранён, но бутылка не добавлена» — позиция учтена как расхождение и в новый короб не идёт.",
            image: { id: "repack-scanning", caption: "Наполнение нового короба" },
          },
          {
            kind: "step",
            title: "Короб закрывается автоматически",
            text: "Когда короб набран, терминал закрывает его автоматически и отправляет этикетку на печать. Закрыть неполный короб вручную нельзя — при необходимости откройте панель «Исправления»: кнопкой «Убрать последнюю бутылку» уберите ошибочно добавленную позицию, а кнопкой «Очистить открытый короб» — весь набор.",
            image: { id: "repack-box-ready", caption: "Короб закрыт — печатаем этикетку" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "«Короб заблокирован из-за конфликта» — короб уже обработан другим терминалом; очистите конфликт и продолжайте с другим коробом. «Короб аннулирован администратором» — работу по нему прекратите и сообщите мастеру.",
          },
        ],
      },
      {
        id: "printing",
        heading: "6. Печать этикетки нового короба",
        blocks: [
          {
            kind: "step",
            title: "Наклейте напечатанную этикетку",
            text: "После закрытия короба терминал печатает этикетку с новым номером SSCC. Наклейте её на этот короб сразу — короб без этикетки нельзя опознать на складе.",
            expected: "Терминал показал «Этикетка напечатана».",
          },
          {
            kind: "step",
            title: "Если этикетка не напечатана",
            text: "Терминал сообщит причину: «В задании нет шаблона этикетки», «Принтер не настроен», «Не удалось подготовить этикетку» или «Принтер не подтвердил печать». Устраните причину (лента, кабель, замятие) и нажмите «Повторить печать»; кнопка «Настроить принтер» открывает настройку рабочего места.",
            image: { id: "print-recovery", caption: "Этикетка не напечатана: повтор печати" },
          },
          {
            kind: "step",
            title: "Перепечатайте потерянную этикетку",
            text: "Откройте панель «Исправления» — в разделе «Перепечатать этикетку короба» введите не менее четырёх цифр номера SSCC — подходящие короба появятся сами. Выберите нужный и нажмите «Перепечатать». Старую этикетку, если она нашлась, уничтожьте: на коробе должна остаться одна.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "«Результат печати не сохранился. Повторите с тем же SSCC» — не создавайте новый короб: повторите печать для того же номера, иначе на складе появятся два короба с одинаковым содержимым.",
          },
        ],
      },
      {
        id: "leave",
        heading: "7. Выход из задания",
        blocks: [
          {
            kind: "step",
            title: "Завершите работу кнопкой «Выйти из задания»",
            text: "Терминал дошлёт накопленные события на сервер и вернётся к списку заданий. Счётчик «Неотправленных событий» показывает очередь — дождитесь её отправки, если сеть доступна.",
          },
          {
            kind: "step",
            title: "Если выйти не удалось",
            text: "Терминал показал «Не удалось выйти. Задание и неотправленные сканы сохранены.» — задание и все сканы остаются на терминале, ничего не потеряно. При переупаковке перед повтором закройте открытый короб или очистите его через панель «Исправления» (на снимке короб открыт: 4 из 20) — иначе уложенная продукция останется без этикетки и учёта. Затем нажмите «Выйти из задания» ещё раз.",
            image: {
              id: "leave-open-box",
              caption: "Выход не удался: задание и сканы сохранены на терминале",
            },
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
                term: "Штрихкод формы-задания не читается",
                detail:
                  "Выберите задание из списка на экране складских операций кнопкой «Продолжить» — форма нужна только для быстрого открытия.",
              },
              {
                term: "Для линии нет заданий инвентаризации",
                detail:
                  "Задание ещё не запущено менеджером или назначено другой линии. Уточните у мастера; производственные смены при этом остаются доступны.",
              },
              {
                term: "Много расхождений подряд",
                detail:
                  "Похоже, пересчитывается не та партия или не тот продукт. Остановитесь и сверьтесь с мастером — расхождения останутся в результате инвентаризации.",
              },
              {
                term: "Терминал не в сети во время пересчёта",
                detail:
                  "Работайте дальше: снимок задания сохранён локально, сканы уйдут на сервер при восстановлении связи.",
              },
              {
                term: "Закрыл короб, а этикетки нет",
                detail:
                  "Перепечатайте её по номеру SSCC (раздел 6). Перепечатать можно только короб, напечатанный этим терминалом, — если его печатал другой терминал, обратитесь к мастеру. Пока этикетки нет, короб нельзя отправлять на склад.",
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
    title: "Scanning station: inventory on the terminal",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Operator's guide for inventory: opening a task, checking products and scan verdicts, repacking boxes with label printing, leaving the task.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "An inventory is a full recount of the products in a warehouse or on a line. A manager prepares and starts the task in the cabinet, and the operator performs the recount on the terminal: scans the products and, when required, moves them into new boxes. This instruction covers the operator's work; signing in is covered by instruction MKR-INS-01.",
          },
          {
            kind: "paragraph",
            text: "A task comes in two methods: “Without repacking” — products are only scanned, the boxes stay as they are; “With repacking” — verified products are moved into new boxes and labels are printed for them. The manager picks the method when creating the task; the operator does not change it.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots use demo data. Task numbers, boxes and products on your terminal will differ.",
          },
        ],
      },
      {
        id: "open-task",
        heading: "2. Opening a task",
        blocks: [
          {
            kind: "step",
            title: "Open the warehouse operations",
            text: "On the shift selection screen switch to “Warehouse operations”. The terminal shows the inventory tasks of its line and offers to scan the task-form barcode.",
            image: {
              id: "task-selection",
              caption: "Warehouse operations: the line's inventory tasks",
            },
          },
          {
            kind: "step",
            title: "Scan the task-form barcode",
            text: "Take the printed task form prepared by the manager and scan its barcode — the task opens automatically. If there is no form, pick the task in the list with the “Continue” button.",
            expected:
              "The terminal opened the “Product check” screen — the task is loaded and works offline.",
          },
          {
            kind: "step",
            title: "Confirm a task of another line",
            text: "If the barcode belongs to a task of another line, the terminal asks for confirmation. Open such a task only when your supervisor says so: the inventory is counted per assigned line.",
            image: { id: "other-line", caption: "Confirming a task of another line" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "Once the snapshot is saved, the terminal works autonomously: the recount continues offline, and the results go to the server when the connection is back.",
          },
        ],
      },
      {
        id: "verdicts",
        heading: "3. Product check and verdicts",
        blocks: [
          {
            kind: "paragraph",
            text: "On the “Product check” screen, scan a bottle or a box. Scanning a box marks all of its known contents as verified — this is faster than scanning bottles one by one. The counters show “Verified”, “Discrepancies” and “Protected from counting”.",
          },
          {
            kind: "step",
            title: "“Code accepted” and “Box accepted”",
            text: "A green verdict means the item is counted. When a box is scanned, the terminal reports “Box accepted: N codes” — its contents do not need to be scanned separately.",
            image: { id: "box-accepted", caption: "The box is accepted whole" },
          },
          {
            kind: "step",
            title: "“Code is absent from the source snapshot” — a discrepancy",
            text: "The product is in the warehouse, but it is not in the task's snapshot. The scan is saved as a discrepancy — set such products aside and continue the recount. The manager will sort the discrepancies out.",
            image: { id: "not-in-snapshot", caption: "A discrepancy: the code is not in the task's snapshot" },
          },
          {
            kind: "step",
            title: "“Code not counted: already in shipment”",
            text: "The code is protected from counting: the product has already been shipped or withdrawn from circulation. The terminal does not count it — remove such products from the batch being recounted.",
            image: { id: "protected", caption: "A protected code: the product is already in shipment" },
          },
          {
            kind: "step",
            title: "“Code is not part of this inventory”",
            text: "The product does not match the task's parameters: a different product or a production date outside the set period. It does not go into the recount — set it aside and continue.",
            image: { id: "ineligible", caption: "The code is not part of this task" },
          },
          {
            kind: "step",
            title: "“DUPLICATE” — the code is already checked",
            text: "“Code was already checked on this terminal” or “Code was already checked on another terminal” means the item was counted earlier. Do not rescan it and do not repack it: it is already counted.",
            image: { id: "duplicate", caption: "A duplicate: the code was already checked on another terminal" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "“Code not recognized” — the scan was not a marking code: flatten the packaging and scan again. “Scan was not saved — scan again” means the terminal did not record the result: scan the same item again.",
          },
        ],
      },
      {
        id: "production-date",
        heading: "4. The production date",
        blocks: [
          {
            kind: "paragraph",
            text: "The terminal attributes scans to the active production date and takes it from the product itself: the bottling date of every code is known from the task's snapshot. There is no need to set the date manually before starting — follow the terminal's prompts.",
          },
          {
            kind: "step",
            title: "Just start scanning",
            text: "The first scan on the terminal sets the active date by the scanned code's date on its own — nothing needs to be confirmed. Before the first scan, the “Production date” field holds the start of the task's period; the very first scan replaces it with the product's real date.",
          },
          {
            kind: "step",
            title: "The code's date does not match the active one",
            text: "If the scanned code's date diverges from the active one, the terminal does not count the scan and shows “The code's date differs from the active one”. Tap “Set MM/DD/YYYY and count” to switch the active date to the code's date and count this bottle right away — this is how you move on to products of another date. The “Skip the code” button records nothing: set the bottle aside and continue. While the dialog is open, the scanner is held — further scans will not pass until you answer.",
            image: {
              id: "source-date-mismatch",
              caption: "The code's date does not match the active date",
            },
            expected: "The scan is not recorded in either case until you pick an action.",
          },
          {
            kind: "step",
            title: "A box holds several bottling dates",
            text: "If the scanned box holds products of different dates, no single date can be applied — the terminal shows “The box holds several production dates”. “Count as is” counts the box whole under the current active date, and the manager will sort the date discrepancies out. “Skip the code” leaves the box uncounted — then break it up and scan the bottles one by one.",
            image: { id: "mixed-box", caption: "The box contains several bottling dates" },
          },
          {
            kind: "step",
            title: "The date during repacking",
            text: "During repacking, the new box takes its date from the source box's contents: if everything in it has one date, the new box opens with it right away. When a bottle's date diverges from the box date, the terminal shows “This code's date is different from the box date”. While the new box is empty, the “Set MM/DD/YYYY and count” button is available — it sets the box date by the bottle. If the box already holds bottles, dates must not be mixed: the terminal reports “The box already holds bottles of another date. Close or clear it.” — leaving “Skip the code” and the “Corrections” button.",
            image: {
              id: "repack-source-date",
              caption: "Repacking: the bottle's date does not match the box date",
            },
          },
          {
            kind: "step",
            title: "Switch the date manually",
            text: "Manual switching is needed only when the terminal did not set the date itself. Tap “Change” next to the date, pick the right one and confirm with the “Apply date” button. The new date applies from the next accepted scan — scans already made do not change.",
            image: { id: "date-change", caption: "Changing the production date" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If the terminal added “The code's date is outside the task range” under the mismatch message, the “Set MM/DD/YYYY and count” button will not appear: such products are not part of this task. Set them aside and tap “Skip the code”.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "During repacking the “Apply date” button is unavailable while the open box holds bottles — the terminal shows “Close the incomplete box or clear it first”. Close the box or clear it through the “Corrections” panel, then change the date.",
          },
        ],
      },
      {
        id: "repack",
        heading: "5. The “With repacking” method",
        blocks: [
          {
            kind: "step",
            title: "Scan the source box",
            text: "Repacking goes box by box: first scan the label of the source box you are moving products out of.",
            image: {
              id: "repack-old-box",
              caption: "Repacking: the terminal is waiting for the source box scan",
            },
            expected: "The terminal showed “Source box selected” and opened a new box.",
          },
          {
            kind: "step",
            title: "Scan every bottle into the new box",
            text: "Move products one by one, scanning each unit: the terminal shows the taken and free slots in the open box. “Bottle added to the new box” — the item is placed; “Scan saved, but the bottle was not added” — the item is counted as a discrepancy and does not go into the new box.",
            image: { id: "repack-scanning", caption: "Filling the new box" },
          },
          {
            kind: "step",
            title: "The box closes automatically",
            text: "When the box is full, the terminal closes it automatically and sends the label to print. A partial box cannot be closed manually — if needed, open the “Corrections” panel: the “Remove last bottle” button removes a mistakenly added item, and “Clear open box” removes the whole set.",
            image: { id: "repack-box-ready", caption: "The box is closed — printing the label" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "“Box blocked by an ownership conflict” — the box was already processed by another terminal; clear the conflict and continue with another box. “Box invalidated by an administrator” — stop working on it and tell your supervisor.",
          },
        ],
      },
      {
        id: "printing",
        heading: "6. Printing the new box label",
        blocks: [
          {
            kind: "step",
            title: "Stick the printed label on",
            text: "After the box is closed, the terminal prints a label with the new SSCC number. Stick it onto this box right away — a box without a label cannot be identified in the warehouse.",
            expected: "The terminal showed “Label printed”.",
          },
          {
            kind: "step",
            title: "If the label was not printed",
            text: "The terminal reports the cause: “The task has no label template”, “Printer is not configured”, “Could not prepare the label” or “The printer did not confirm printing”. Fix the cause (ribbon, cable, jam) and tap “Retry printing”; the “Configure printer” button opens the workstation setup.",
            image: { id: "print-recovery", caption: "The label was not printed: retrying the print" },
          },
          {
            kind: "step",
            title: "Reprint a lost label",
            text: "Open the “Corrections” panel — in the “Reprint a box label” section enter at least four digits of the SSCC number, and the matching boxes appear by themselves. Pick the right one and tap “Reprint”. Destroy the old label if it turns up: only one may remain on the box.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "“The print result was not saved. Retry with the same SSCC” — do not create a new box: repeat the print for the same number, otherwise the warehouse ends up with two boxes holding the same contents.",
          },
        ],
      },
      {
        id: "leave",
        heading: "7. Leaving the task",
        blocks: [
          {
            kind: "step",
            title: "Finish with the “Leave task” button",
            text: "The terminal sends the accumulated events to the server and returns to the task list. The “Pending events” counter shows the queue — wait for it to be sent if the network is up.",
          },
          {
            kind: "step",
            title: "If leaving failed",
            text: "The terminal showed “Could not leave. The task and pending scans are preserved.” — the task and all scans stay on the terminal, nothing is lost. With repacking, close the open box or clear it through the “Corrections” panel before retrying (in the screenshot the box is open: 4 of 20) — otherwise the packed products remain without a label or a record. Then tap “Leave task” again.",
            image: {
              id: "leave-open-box",
              caption: "Leaving failed: the task and the scans are preserved on the terminal",
            },
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
                term: "The task-form barcode cannot be read",
                detail:
                  "Pick the task from the list on the warehouse operations screen with the “Continue” button — the form is only needed for quick opening.",
              },
              {
                term: "The line has no inventory tasks",
                detail:
                  "The task has not been started by the manager yet or is assigned to another line. Check with your supervisor; production shifts remain available meanwhile.",
              },
              {
                term: "Many discrepancies in a row",
                detail:
                  "The wrong batch or the wrong product is probably being recounted. Stop and check with your supervisor — the discrepancies stay in the inventory result.",
              },
              {
                term: "The terminal is offline during the recount",
                detail:
                  "Keep working: the task's snapshot is stored locally, and the scans go to the server when the connection is back.",
              },
              {
                term: "Closed a box but there is no label",
                detail:
                  "Reprint it by the SSCC number (section 6). Only a box printed by this terminal can be reprinted — if another terminal printed it, ask your supervisor. Until there is a label, the box must not go to the warehouse.",
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
