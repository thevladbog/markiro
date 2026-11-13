import type { LegalDocumentSource } from "../types.js";

export const STANDALONE_WAREHOUSE_CONTENT = {
  ru: {
    locale: "ru",
    title: "Станция: сборка складских палет",
    summary:
      "Инструкция для оператора, администратора и технолога Маркиро Автоном. Как собрать палету из закрытых коробов, проверить этикетку и сверить состав в офисе.",
    sections: [
      {
        id: "prepare",
        heading: "1. Подготовьте два поста",
        blocks: [
          {
            kind: "paragraph",
            text: "На первом посту оператор в производственной смене сканирует продукцию и закрывает короба. На втором посту оператор собирает из этих коробов складскую палету. При планировании смены в офисе оставьте опцию «С палетами» выключенной. При создании смены на станции выберите «Без паллет». Тогда закрытые короба останутся свободными для склада. Можно использовать свободные короба из разных смен, в том числе из смены, которая ещё идёт.",
          },
          {
            kind: "unordered-list",
            items: [
              "У каждого короба есть этикетка с SSCC. Станция первого поста передала закрытие короба на хост.",
              "Станция второго поста подключена к хосту, в лицензии есть сборка палет, а оператор может войти на станции.",
              "В «Рабочее место» → «Принтеры» назначен термопринтер для «Этикетка паллеты». Проверьте принтер и сканер по MKR-INS-04. Если шаблон не подбирается, назначьте в офисе подходящий шаблон термоэтикетки палеты для товара.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "Скриншоты сделаны в Маркиро Автоном с демонстрационными данными. Для сборки на ТСД используйте MKR-INS-14.",
          },
        ],
      },
      {
        id: "assembly",
        heading: "2. Добавьте короба",
        blocks: [
          {
            kind: "step",
            title: "Откройте складские операции",
            text: "Войдите как оператор. На экране «Смены линии» нажмите «Складские операции», затем «Открыть режим» на карточке «Короба в палеты». При первом входе дождитесь загрузки реестра коробов. Если реестр ещё не загружен, проверьте связь с хостом и нажмите «Обновить реестр».",
            image: {
              id: "warehouse-menu",
              caption: "Складские операции на станции",
            },
          },
          {
            kind: "step",
            title: "Сканируйте этикетки закрытых коробов",
            text: "Первый короб задаёт товар палеты. После сообщения «Короб добавлен» поставьте короб на палету и сканируйте следующий. Подойдёт закрытый короб того же товара, если он свободен. Повторный скан уже добавленного короба не увеличивает счётчик. Если сканер не читает этикетку, нажмите «Ввести SSCC», введите 18 цифр с этикетки короба и нажмите «Добавить короб».",
            image: {
              id: "pallet-boxes",
              caption: "Состав текущей палеты после сканирования коробов",
            },
          },
          {
            kind: "step",
            title: "Сверьте состав",
            text: "Нажмите «Весь состав» и сравните список с коробами на палете. Чтобы исправить ошибку, нажмите «Убрать» у нужного SSCC, подтвердите и снимите этот короб с палеты. Если после выхода или перезапуска станция покажет «Открытая палета сохранена», сначала сверьте физический состав, затем нажмите «Продолжить сборку».",
          },
        ],
      },
      {
        id: "close-and-print",
        heading: "3. Закройте палету и проверьте этикетку",
        blocks: [
          {
            kind: "step",
            title: "Подтвердите закрытие",
            text: "При достижении вместимости станция закрывает палету и отправляет этикетку на печать. Для досрочного закрытия нажмите «Закрыть и печатать». Проверьте товар, количество коробов и имя принтера, затем снова нажмите «Закрыть и печатать». Станция присвоит палете SSCC и отправит этикетку на принтер.",
            image: {
              id: "pallet-close",
              caption: "Подтверждение досрочного закрытия складской палеты",
            },
          },
          {
            kind: "step",
            title: "Наклейте этикетку на эту палету",
            text: "Дождитесь этикетки и сверьте её SSCC с экраном. Нажмите «Проверить сканером» и отсканируйте SSCC наклеенной этикетки или нажмите «Этикетка наклеена» после ручной сверки. Затем нажмите «Следующая палета».",
            image: {
              id: "pallet-label",
              caption: "Отправленная на принтер этикетка и SSCC закрытой палеты",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Сообщение «Этикетка передана на принтер» означает отправку задания. Если этикетки нет или результат неизвестен, сначала проверьте принтер и очередь печати Windows, если используется драйвер. Повторите печать только после проверки, что первая этикетка не вышла и задание больше не ждёт печати. «Отложить печать» сохраняет этикетку под тем же SSCC. Найти её можно в разделе «Очередь печати».",
          },
        ],
      },
      {
        id: "offline",
        heading: "4. Продолжайте работу при потере связи",
        blocks: [
          {
            kind: "paragraph",
            text: "Без связи с хостом можно добавлять короба, которые есть в загруженном реестре станции. Если короб не найден, дождитесь восстановления связи и повторите скан. Станция обновит реестр при поиске нового короба. Если закончился запас SSCC, оставьте палету открытой и пополните запас при восстановлении связи.",
          },
          {
            kind: "paragraph",
            text: "После закрытия станция может показать «Ожидает отправки». При восстановлении связи она передаст накопленные записи. Статус «Состав подтверждён сервером» означает, что хост принял закрытие с этим составом. Если станция показывает «Требуется сверка состава», передайте SSCC и причину в офис.",
          },
        ],
      },
      {
        id: "office",
        heading: "5. Проверьте палету в офисе",
        blocks: [
          {
            kind: "step",
            title: "Откройте карточку палеты",
            text: "В офисе откройте «Поиск кодов» → «Палеты». В разделе «Складские палеты» найдите строку по SSCC и откройте карточку. В ней видны товар, источник и короба с их исходными сменами.",
            image: {
              id: "office-pallet",
              caption: "Карточка складской палеты в офисе",
            },
          },
          {
            kind: "step",
            title: "Сверьте состав, если хост отклонил закрытие",
            text: "На станции откройте «Сверка состава», запишите SSCC, причину и номер сверки, если он указан. Передайте сведения администратору или технологу. Кнопка «Подтвердить проверку» фиксирует, что оператор увидел случай. Решение принимается в офисе в разделе «Сверка складских палет».",
          },
          {
            kind: "paragraph",
            text: "Если доступно «Сверить состав», сравните оставшиеся на палете короба со списком в офисе. Только после физической сверки отметьте «Физический состав совпадает со списком» и нажмите «Разрешить закрытие». Станция повторно закроет палету и предложит заменить этикетку с тем же SSCC. Если вместо этого палету нужно переоформить, администратор снимает старую этикетку и подтверждает «Аннулировать этикетку». Свободные короба после этого можно собрать заново.",
          },
        ],
      },
    ],
  },
  en: {
    locale: "en",
    title: "Station: building warehouse pallets",
    summary:
      "This is an informational translation. The Russian edition is authoritative. For Markiro Autonom operators, administrators and technologists. Build a pallet from closed boxes, check its label and reconcile its contents in the office.",
    sections: [
      {
        id: "prepare",
        heading: "1. Prepare the two workstations",
        blocks: [
          {
            kind: "paragraph",
            text: "At the first workstation, the operator scans products and closes boxes in a production shift. At the second workstation, the operator builds a warehouse pallet from those boxes. When planning the shift in the office, leave “С палетами” (With pallets) off. When creating a shift at the station, select “Без паллет” (Without pallets). This leaves the closed boxes available for the warehouse. You can use available boxes from different shifts, including shifts still in progress.",
          },
          {
            kind: "unordered-list",
            items: [
              "Each box has an SSCC label. The first station has sent the box closing record to the host.",
              "The second station is paired with the host, the license includes pallet assembly, and the operator can sign in.",
              "In “Рабочее место” (Workstation) → “Принтеры” (Printers), assign a thermal printer to “Этикетка паллеты” (Pallet label). Check the printer and scanner as described in MKR-INS-04. If no template is found, assign a compatible thermal pallet label template to the product in the office.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots show Markiro Autonom with demo data. For pallet assembly on an Android handheld, see MKR-INS-14.",
          },
        ],
      },
      {
        id: "assembly",
        heading: "2. Add the boxes",
        blocks: [
          {
            kind: "step",
            title: "Open warehouse operations",
            text: "Sign in as an operator. On “Смены линии” (Line shifts), select “Складские операции” (Warehouse operations), then “Открыть режим” (Open mode) on the “Короба в палеты” (Boxes to pallets) card. On first use, wait for the box registry to load. If the registry has not loaded, check the host connection and select “Обновить реестр” (Refresh registry).",
            image: {
              id: "warehouse-menu",
              caption: "Warehouse operations at the station",
            },
          },
          {
            kind: "step",
            title: "Scan the labels on the closed boxes",
            text: "The first box determines the product on the pallet. When you see “Короб добавлен” (Box added), put the box on the pallet and scan the next box. It must be a closed, available box of the same product. Scanning a box again leaves the count unchanged. If the scanner cannot read a label, select “Ввести SSCC” (Enter SSCC), enter the 18 digits from the box label and select “Добавить короб” (Add box).",
            image: {
              id: "pallet-boxes",
              caption: "Current pallet contents after scanning boxes",
            },
          },
          {
            kind: "step",
            title: "Check the contents",
            text: "Select “Весь состав” (Full contents) and compare the list with the boxes on the pallet. To correct a mistake, select “Убрать” (Remove) next to the SSCC, confirm and take that box off the pallet. If “Открытая палета сохранена” (Open pallet saved) appears after exiting or restarting, check the physical contents before selecting “Продолжить сборку” (Resume assembly).",
          },
        ],
      },
      {
        id: "close-and-print",
        heading: "3. Close the pallet and check its label",
        blocks: [
          {
            kind: "step",
            title: "Confirm closing",
            text: "At capacity, the station closes the pallet and sends the label to the printer. To close a pallet early, select “Закрыть и печатать” (Close and print). Check the product, box count and printer name, then select “Закрыть и печатать” (Close and print) again. The station assigns an SSCC and sends the label to the printer.",
            image: {
              id: "pallet-close",
              caption: "Confirming early closing of a warehouse pallet",
            },
          },
          {
            kind: "step",
            title: "Attach the label to this pallet",
            text: "Wait for the label and compare its SSCC with the screen. Select “Проверить сканером” (Check with scanner) and scan the SSCC on the attached label, or select “Этикетка наклеена” (Label attached) after checking it manually. Then select “Следующая палета” (Next pallet).",
            image: {
              id: "pallet-label",
              caption: "Label sent to the printer and the SSCC of the closed pallet",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "“Этикетка передана на принтер” (Label sent to printer) means the station has sent the job. If the label is missing or the outcome is unknown, first check the printer and the Windows print queue if a driver is in use. Retry after checking that the first label did not print and its job is no longer pending. “Отложить печать” (Defer printing) keeps the label in “Очередь печати” (Print queue) under the same SSCC.",
          },
        ],
      },
      {
        id: "offline",
        heading: "4. Keep working if the host connection drops",
        blocks: [
          {
            kind: "paragraph",
            text: "While the host is unreachable, you can add boxes in the registry already loaded on the station. If a box is missing, wait for the connection to return and scan again. The station refreshes the registry when looking for an unknown box. If the station runs out of SSCCs, leave the pallet open and replenish the supply after reconnecting.",
          },
          {
            kind: "paragraph",
            text: "After closing, the station may show “Ожидает отправки” (Waiting to send). It sends the pending records when the connection returns. “Состав подтверждён сервером” (Contents confirmed by server) means the host accepted the pallet with those contents. If the station shows “Требуется сверка состава” (Contents need reconciliation), give the office the SSCC and reason.",
          },
        ],
      },
      {
        id: "office",
        heading: "5. Check the pallet in the office",
        blocks: [
          {
            kind: "step",
            title: "Open the pallet card",
            text: "In the office, open “Поиск кодов” (Code search) → “Палеты” (Pallets). Under “Складские палеты” (Warehouse pallets), find the SSCC and open its card. It shows the product, source and boxes with their original shifts.",
            image: {
              id: "office-pallet",
              caption: "Warehouse pallet card in the office",
            },
          },
          {
            kind: "step",
            title: "Reconcile the contents if the host rejected closing",
            text: "At the station, open “Сверка состава” (Reconcile contents). Record the SSCC, reason and reconciliation number, if shown, and pass them to the administrator or technologist. “Подтвердить проверку” (Acknowledge check) records that the operator saw the case. Resolve it in “Сверка складских палет” (Warehouse pallet reconciliation) in the office.",
          },
          {
            kind: "paragraph",
            text: "If “Сверить состав” (Review contents) is available, compare the boxes still on the physical pallet with the office list. After checking, select “Физический состав совпадает со списком” (Physical contents match the list) and “Разрешить закрытие” (Allow closing). The station closes the pallet again and prompts you to replace the label with the same SSCC. If the pallet must be rebuilt, the administrator removes the old label and confirms “Аннулировать этикетку” (Cancel label). Available boxes can then be assembled again.",
          },
        ],
      },
    ],
  },
} satisfies LegalDocumentSource["content"];
