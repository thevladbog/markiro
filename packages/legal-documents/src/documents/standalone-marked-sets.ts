import type { LegalDocumentSource } from "../types.js";

export const STANDALONE_MARKED_SETS_CONTENT = {
  ru: {
    locale: "ru",
    title: "Наборы: сборка и выгрузки",
    summary:
      "Состав набора в каталоге, смена сборки, сканирование вложений и внешней упаковки, выгрузки состава и расформирование в офисе.",
    sections: [
      {
        id: "recipe",
        heading: "1. Создайте карточку набора",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция для технолога, оператора и сотрудника офиса. Для сборки нужен Маркиро Автоном 1.7.0 или новее на хосте и станции. Если работаете с ТСД, используйте версию ТСД 1.11.0 или новее и сначала обновите хост. Подготовьте маркированные вложения и этикетки с Data Matrix для внешних упаковок.",
          },
          {
            kind: "step",
            title: "Сохраните состав в каталоге",
            text: "В офисе откройте «Товары» → «Добавить набор». Введите «Название набора» и собственный «GTIN набора». В разделе «Состав набора» выберите активный товар из каталога, нажмите «Добавить в состав» и задайте количество. Повторите для остальных позиций и нажмите «Сохранить». Поддерживается группа «Косметика, бытовая химия и товары личной гигиены», до 1000 единиц вложений на один набор.",
            image: {
              id: "office-set-recipe",
              caption: "Карточка набора с количеством по каждой позиции",
            },
          },
        ],
      },
      {
        id: "assembly",
        heading: "2. Откройте смену и соберите набор",
        blocks: [
          {
            kind: "step",
            title: "Выберите набор для смены",
            text: "В офисе откройте «Смены» → «Запланировать смену» и выберите карточку набора. Появится режим «Сборка наборов». Укажите линию, даты и при необходимости «План, наборов». Оператор открывает запланированную смену на своей линии. Если создаёте смену на станции или ТСД, откройте «Новая смена» и выберите набор из списка или отсканируйте его EAN или Data Matrix. Этот первый скан выбирает карточку. Проверьте состав и нажмите «Начать сборку» на станции или «Создать и открыть» на ТСД. Смена использует состав, зафиксированный при открытии.",
          },
          {
            kind: "step",
            title: "Сканируйте марки вложений",
            text: "Сканируйте Data Matrix каждой вложенной единицы в любом порядке. По счётчикам в «Состав набора» проверьте количество каждого товара. Повторный код, лишняя единица и товар вне состава вызовут сообщение об ошибке. На станции кнопка «Отменить последний скан» убирает последнее принятое вложение до завершения набора.",
          },
          {
            kind: "step",
            title: "Сканируйте Data Matrix внешней упаковки последним",
            text: "Когда все позиции собраны, станция покажет «Сканируйте марку набора», а ТСД — «Отсканируйте код набора». Наклейте подготовленную этикетку на внешнюю упаковку и отсканируйте её. Станция покажет «Набор собран», а ТСД — «Набор сохранён». Так устройство подтверждает сохранение состава. Повторите для следующего экземпляра. После синхронизации в офисе откройте карточку смены → «Наборы» и проверьте принятые записи и вложения. При конфликте сообщите технологу и сверьте фактический состав перед выгрузкой.",
            image: {
              id: "station-package-scan",
              caption: "Станция ждёт марку набора после трёх вложений",
            },
          },
          {
            kind: "paragraph",
            text: "На станции «На паузу» сохраняет незавершённый набор. Для закрытия смены завершите сборку или отмените сканы текущих вложений и подтвердите закрытие. Для выгрузки дождитесь приёма записей хостом и статуса смены «Закрыта».",
          },
        ],
      },
      {
        id: "exports",
        heading: "3. Выгрузки",
        blocks: [
          {
            kind: "step",
            title: "Выберите формат выгрузки",
            text: "Откройте карточку закрытой смены и нажмите «Выгрузка». Выберите формат и нажмите «Сформировать и сохранить». В файл входят действующие наборы, принятые хостом. Конфликт блокирует формирование файла. Расформированные наборы исключаются из новой выгрузки.",
            image: {
              id: "office-set-export-options",
              caption: "Форматы выгрузки закрытой смены сборки",
            },
          },
          {
            kind: "unordered-list",
            items: [
              "«[ЧЗ][xlsx] Реестр наборов» — таблица для сверки и заполнения состава в личном кабинете Честного знака.",
              "«[1C][csv] Выгрузка Наборы - Коды» — файл для 1С. Каждая строка связывает код вложения с кодом набора в колонке «Код упаковки». При открытии в Excel выберите разделитель «точка с запятой» и задайте обеим колонкам тип «Текст», чтобы сохранить коды и ведущие нули.",
            ],
          },
          {
            kind: "step",
            title: "Откройте сохранённый файл",
            text: "В окне результата откройте папку выгрузки или скачайте файл из вкладки «Выгрузки» в карточке смены.",
          },
          {
            kind: "paragraph",
            text: "В окне выгрузки также доступны «Печатная форма состава наборов» и «Копирование для Честного знака». Подачу сведений сотрудник офиса выполняет в личном кабинете Честного знака.",
          },
        ],
      },
      {
        id: "disaggregation",
        heading: "4. Расформируйте набор в офисе",
        blocks: [
          {
            kind: "step",
            title: "Проведите документ после закрытия смены",
            text: "В разделе «Дезагрегация» нажмите «Создать документ», выберите причину и добавьте Data Matrix или КИ набора в поле «SSCC или КИ набора». Вводите один код набора на строку. Сверьте уровень «Набор», смену и число кодов, затем нажмите «Провести» и подтвердите. После проведения и синхронизации марки вложений можно использовать повторно. Марка внешней упаковки остаётся занятой.",
            image: {
              id: "office-set-disaggregation",
              caption: "Проведённый документ со строкой расформированного набора",
            },
          },
          {
            kind: "paragraph",
            text: "Если при сборке вложение взято из закрытого короба закрытой смены Автонома, хост при приёме набора расформирует исходный короб целиком и сохранит документ с причиной «Сборка набора». Открытый короб или незакрытая исходная смена блокируют приём. Если короб зарегистрирован в Честном знаке, оформите его расформирование там до подачи сведений о формировании набора.",
          },
        ],
      },
    ],
  },
  en: {
    locale: "en",
    title: "Sets: assembly and exports",
    summary:
      "This is an informational translation. The Russian edition is authoritative. Configure a marked set, assemble it on a station or handheld, export its contents and disassemble it in the office.",
    sections: [
      {
        id: "recipe",
        heading: "1. Create the set in the catalogue",
        blocks: [
          {
            kind: "paragraph",
            text: "For technologists, operators and office staff. Set assembly requires Markiro Autonom 1.7.0 or later on the host and station. For handheld assembly, use the handheld app 1.11.0 or later and update the host first. Prepare the marked items and the Data Matrix labels for the outer packages.",
          },
          {
            kind: "step",
            title: "Save the recipe",
            text: "In the office, open «Товары» (Products) → «Добавить набор» (Add set). Enter «Название набора» (Set name) and its own «GTIN набора» (Set GTIN). In «Состав набора» (Set contents), choose an active catalogue item, click «Добавить в состав» (Add to contents), and set the quantity. Repeat for each item and click «Сохранить» (Save). The supported product group is cosmetics, household chemicals and personal care products. A set can contain up to 1,000 individual items.",
            image: { id: "office-set-recipe", caption: "Set card with the quantity for each item" },
          },
        ],
      },
      {
        id: "assembly",
        heading: "2. Open the shift and assemble a set",
        blocks: [
          {
            kind: "step",
            title: "Select the set for the shift",
            text: "In the office, open «Смены» (Shifts) → «Запланировать смену» (Plan shift) and select the set. The mode shows «Сборка наборов» (Set assembly). Set the line, dates and optional «План, наборов» (Planned set count). The operator opens the planned shift on the assigned line. To create the shift on a station or handheld, open «Новая смена» (New shift) and select the set or scan its EAN or Data Matrix. This first scan selects the catalogue entry. Check the recipe and click «Начать сборку» (Start assembly) on the station or «Создать и открыть» (Create and open) on the handheld. The shift uses the recipe recorded when it opens.",
          },
          {
            kind: "step",
            title: "Scan the items",
            text: "Scan each item's Data Matrix in any order. Check the quantity for each item under «Состав набора» (Set contents). The device reports a duplicate mark, a quantity above the recipe or an item outside the recipe. On the station, «Отменить последний скан» (Undo last scan) removes the last accepted item until the set is complete.",
          },
          {
            kind: "step",
            title: "Scan the outer package Data Matrix last",
            text: "When all items have been scanned, the station shows «Сканируйте марку набора» (Scan the set mark) and the handheld shows «Отсканируйте код набора» (Scan the set code). Apply the prepared label to the outer package and scan it. The station shows «Набор собран» (Set assembled) and the handheld shows «Набор сохранён» (Set saved) after saving the recipe for that package. Repeat for the next set. After sync, open the shift card in the office and check the accepted entries and components under «Наборы» (Sets). If there is a conflict, inform the technologist and check the physical contents before exporting.",
            image: {
              id: "station-package-scan",
              caption: "The station waits for the set mark after three items",
            },
          },
          {
            kind: "paragraph",
            text: "On the station, «На паузу» (Pause) saves an unfinished set. To close the shift, finish the set or undo its item scans, then confirm the shift closure. Before exporting, wait for the host to accept the records and for the shift status to show «Закрыта» (Closed).",
          },
        ],
      },
      {
        id: "exports",
        heading: "3. Exports",
        blocks: [
          {
            kind: "step",
            title: "Choose an export format",
            text: "Open the closed shift card and click «Выгрузка» (Export). Choose a format and click «Сформировать и сохранить» (Generate and save). The file contains active sets accepted by the host. A conflict blocks export. New exports exclude disassembled sets.",
            image: {
              id: "office-set-export-options",
              caption: "Export formats for a closed set assembly shift",
            },
          },
          {
            kind: "unordered-list",
            items: [
              "«[ЧЗ][xlsx] Реестр наборов» (Set register) is a spreadsheet for checking and entering set contents in the Chestny ZNAK account.",
              "«[1C][csv] Выгрузка Наборы - Коды» (Sets and item codes) is a CSV file for 1C. Each row links an item code to the set code in the «Код упаковки» (Package code) column. When opening it in Excel, select the semicolon delimiter and set both columns to Text to preserve the codes and leading zeros.",
            ],
          },
          {
            kind: "step",
            title: "Open the saved file",
            text: "Open the export folder from the result dialog or download the file from the «Выгрузки» (Exports) tab on the shift card.",
          },
          {
            kind: "paragraph",
            text: "The export dialog also offers «Печатная форма состава наборов» (Printable set contents) and «Копирование для Честного знака» (Copy for Chestny ZNAK). Office staff submit the information in the Chestny ZNAK account.",
          },
        ],
      },
      {
        id: "disaggregation",
        heading: "4. Disassemble a set in the office",
        blocks: [
          {
            kind: "step",
            title: "Post the document after the shift closes",
            text: "In «Дезагрегация» (Disaggregation), click «Создать документ» (Create document), select a reason and add the set's Data Matrix or identification code to «SSCC или КИ набора» (SSCC or set identification code). Enter one set code per line. Check the «Набор» (Set) level, shift and code count, then click «Провести» (Post) and confirm. After posting and syncing, the item marks can be reused. The outer package mark stays claimed.",
            image: {
              id: "office-set-disaggregation",
              caption: "Posted document with a disassembled set entry",
            },
          },
          {
            kind: "paragraph",
            text: "If an item comes from a closed box in a closed Autonom shift, accepting the set causes the host to disassemble the whole source box and save a document with the reason «Сборка набора» (Set assembly). An open box or an open source shift blocks acceptance. If the box is registered in Chestny ZNAK, record its disassembly there before reporting set formation.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
