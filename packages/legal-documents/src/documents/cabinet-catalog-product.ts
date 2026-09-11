import type { LegalDocumentSource } from "../types.js";

export const CABINET_CATALOG_PRODUCT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Кабинет: каталог продукции и карточка товара",
    summary:
      "Инструкция менеджера: как завести товар в каталоге, довести карточку до статуса «Активен», добавить фотографию и вывести товар из оборота.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Каталог продукции — справочник товаров организации. Карточка товара определяет, что печатается на этикетке и что можно выбрать при планировании смены: пока карточка не заполнена до конца, товар остаётся черновиком и смену по нему запустить нельзя. Инструкция предназначена для менеджера кабинета; загрузка товаров из Национального каталога описана в отдельной инструкции.",
          },
          {
            kind: "unordered-list",
            items: [
              "Группа продукции нужна станции и подбору шаблона этикетки.",
              "Вместимости короба и поддона задают, сколько единиц уходит в упаковку при агрегации.",
              "«Наименование для печати» — короткое имя, которое попадает на этикетку вместо длинного полного названия.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия товаров, ГТИН и контрагенты в вашем кабинете будут отличаться.",
          },
        ],
      },
      {
        id: "list",
        heading: "2. Список товаров",
        blocks: [
          {
            kind: "step",
            title: "Откройте раздел «Каталог»",
            text: "В боковом меню кабинета выберите «Каталог» в группе «Справочники». Таблица показывает ГТИН, фото, название, группу, вместимость короба, статус карточки и сведения Честного знака; в столбце «Действия» — кнопки «Изменить» и «Удалить».",
            image: {
              id: "catalog-list",
              caption: "Каталог продукции: три товара в разных статусах",
            },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Активен",
                detail:
                  "Карточка заполнена: товар можно выбрать при планировании смены и в инвентаризации.",
              },
              {
                term: "Черновик",
                detail:
                  "В карточке не хватает группы продукции или вместимостей. Товар виден в каталоге, но в смене недоступен.",
              },
              {
                term: "Не используется",
                detail: "Товар выведен из оборота вручную галочкой «Не использовать» (раздел 7).",
              },
            ],
          },
          {
            kind: "step",
            title: "Найдите нужный товар",
            text: "Поле «Поиск» принимает название или ГТИН. Список «Статус» отбирает товары по статусу карточки, «Статус ЧЗ» — по состоянию карточки в Честном знаке, «На странице» задаёт размер страницы. Под фильтрами указано, сколько товаров нашлось.",
            image: {
              id: "catalog-filters",
              caption: "Фильтр «Статус»: в списке остались только черновики",
            },
            expected: "В таблице остались только товары выбранного статуса.",
          },
        ],
      },
      {
        id: "create",
        heading: "3. Новый товар: основное",
        blocks: [
          {
            kind: "step",
            title: "Создайте карточку",
            text: "Нажмите «Добавить продукт». Откроется панель «Новый продукт» с четырьмя разделами: «Основное», «Агрегация и цена», «Фотография» и «Значения по умолчанию».",
            image: { id: "product-new", caption: "Новая карточка товара: раздел «Основное»" },
          },
          {
            kind: "step",
            title: "Введите ГТИН и названия",
            text: "«ГТИН» — код товара; кабинет сразу проверяет контрольную цифру и при ошибке пишет «Неверный ГТИН (проверьте контрольную цифру)». «Название» — полное наименование для кабинета и отчётов. «Наименование для печати» заполняйте, если полное название слишком длинное для этикетки: «Короткое имя для станции и этикетки. Пусто — используется полное наименование.»",
          },
          {
            kind: "step",
            title: "Проверьте владельца ГТИН",
            text: "Для верного ГТИН кабинет показывает, за кем он зарегистрирован: «Владелец ГТИН — …». Если это контрагент (например, вы разливаете под чужой маркой), кнопка «Подставить контрагента» сразу запишет его в значения по умолчанию. Предупреждение «Владелец ГТИН не определён — проверьте код перед сохранением.» означает, что код не нашёлся ни за вами, ни за известными контрагентами.",
            image: {
              id: "product-gtin-owner",
              caption: "ГТИН зарегистрирован за контрагентом",
            },
          },
        ],
      },
      {
        id: "activate",
        heading: "4. Доведение до статуса «Активен»",
        blocks: [
          {
            kind: "paragraph",
            text: "Статус карточки кабинет вычисляет сам, вручную его не выставляют. Пока не заданы группа продукции и обе вместимости, карточка остаётся черновиком.",
          },
          {
            kind: "step",
            title: "Заполните недостающие поля",
            text: "В черновике наверху карточки видна плашка «Черновик — заполните группу и вместимости, чтобы запускать смены». Выберите «Группа продукции» из справочника Честного знака и укажите «Вместимость короба, шт» и «Вместимость поддона, шт» — целыми числами больше нуля.",
            image: {
              id: "product-draft-banner",
              caption: "Черновик: группа и вместимости не заполнены",
            },
          },
          {
            kind: "step",
            title: "Сохраните карточку",
            text: "Нажмите «Сохранить». Остальные поля раздела «Агрегация и цена» — «Цена за шт., ₽», «Код ЕГАИС» и «Срок годности, дней» — необязательны и на статус не влияют.",
            image: {
              id: "product-active",
              caption: "Заполненная карточка: группа и обе вместимости на месте",
            },
            expected:
              "В списке товар получил статус «Активен» и стал доступен при планировании смены.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Если товар не находится в форме смены, проверьте его статус в каталоге: черновик и товар с галочкой «Не использовать» в выборе продукта недоступны.",
          },
        ],
      },
      {
        id: "image",
        heading: "5. Фотография",
        blocks: [
          {
            kind: "step",
            title: "Добавьте фотографию товара",
            text: "В разделе «Фотография» перетащите файл в область «Перетащите файл или нажмите» или выберите его вручную. Ограничения указаны рядом: «JPEG, PNG или WebP, до 5 МБ». Загруженный снимок виден в списке каталога и помогает оператору не перепутать товар; кнопка «Удалить фотографию» убирает его.",
            image: { id: "product-image", caption: "Раздел «Фотография» с загруженным снимком" },
            expected: "Миниатюра появилась в столбце «Фото» списка каталога.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Пока снимка нет, карточка показывает «Фотография не добавлена», а в списке в столбце «Фото» стоит прочерк. На статус карточки фотография не влияет.",
          },
        ],
      },
      {
        id: "defaults",
        heading: "6. Значения по умолчанию",
        blocks: [
          {
            kind: "step",
            title: "Укажите контрагента по умолчанию",
            text: "«Контрагент по умолчанию» подставляется в смену, когда товар разливается для другой организации. Поле необязательное: если товар всегда ваш собственный, оставьте «Не выбран».",
            image: {
              id: "product-defaults",
              caption: "Значения по умолчанию: контрагент подставлен",
            },
          },
        ],
      },
      {
        id: "retire",
        heading: "7. Вывод товара из оборота",
        blocks: [
          {
            kind: "paragraph",
            text: "Товар, который больше не выпускается, выводят из оборота галочкой, а не удалением: история смен и инвентаризаций должна остаться.",
          },
          {
            kind: "step",
            title: "Поставьте галочку «Не использовать»",
            text: "Откройте карточку и отметьте «Не использовать» в разделе «Основное». Подсказка под галочкой описывает последствия: «Товар нельзя будет выбрать на киоске, в сменах и интеграциях. Он останется доступен для инвентаризации и в истории, а его GTIN можно будет использовать в новой карточке.»",
            image: {
              id: "product-archived",
              caption: "Карточка выведенного из оборота товара",
            },
            expected: "В списке у товара появился статус «Не используется».",
          },
          {
            kind: "step",
            title: "Удаляйте только ошибочные карточки",
            text: "Кнопка «Удалить» в строке списка спрашивает подтверждение: «Удалить продукт?» и предупреждает, что продукт «будет удалён без возможности восстановления». Удаляйте лишь карточку, заведённую по ошибке и ещё не участвовавшую в работе.",
            image: { id: "catalog-delete", caption: "Подтверждение удаления товара" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Удаление необратимо. Если по товару уже шли смены или инвентаризации, используйте «Не использовать» — иначе документы останутся без товара.",
          },
        ],
      },
      {
        id: "external",
        heading: "8. Товары из внешних источников",
        blocks: [
          {
            kind: "paragraph",
            text: "Кроме ручного заведения товар попадает в каталог двумя путями, и у каждого своя точка входа.",
          },
          {
            kind: "step",
            title: "Обмен с 1С",
            text: "Когда из обмена приходят товары, которые ещё не сопоставлены с каталогом, над списком появляется плашка «В обмене появились новые товары (…) — загляните в очередь несопоставленных.». Ссылка «Перейти в очередь» открывает раздел «Интеграции», где кандидата связывают с карточкой каталога. Плашка и связывание доступны сотрудникам с правами на интеграции.",
            image: {
              id: "candidates-plaque",
              caption: "Плашка несопоставленных товаров из обмена",
            },
          },
          {
            kind: "paragraph",
            text: "Кнопка «Добавить из Национального каталога» в шапке раздела создаёт карточки по данным Честного знака — этот путь описан в отдельной инструкции по загрузке из Национального каталога.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "9. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Кабинет не принимает ГТИН",
                detail:
                  "Сообщение «Неверный ГТИН (проверьте контрольную цифру)» означает ошибку в самом коде, а не в правах: сверьте цифры с упаковкой или документами поставщика.",
              },
              {
                term: "Товара нет в списке при планировании смены",
                detail:
                  "Проверьте статус в каталоге: черновик недоступен, пока не заполнены группа и вместимости; товар с галочкой «Не использовать» скрыт из выбора намеренно.",
              },
              {
                term: "Владелец ГТИН не определён",
                detail:
                  "Код не найден ни за вашей организацией, ни за контрагентами. Проверьте его перед сохранением: чужой ГТИН в карточке приведёт к отбраковке кодов на линии.",
              },
              {
                term: "Нужно снова использовать ГТИН выведенного товара",
                detail:
                  "После галочки «Не использовать» этот ГТИН можно указать в новой карточке — старая останется в истории.",
              },
              {
                term: "В столбце «Честный знак» нет сведений",
                detail:
                  "Карточка не связана с Национальным каталогом или сведения ещё не получены. Связывание описано в инструкции по загрузке из Национального каталога.",
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
    title: "Cabinet: the product catalog and the product card",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Manager's guide: adding a product to the catalog, completing its card so it reaches the active status, adding a photo, and retiring a product.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "The product catalog is the organization's product directory. A product card decides what is printed on the label and what can be picked when a shift is planned: until the card is complete the product stays a draft and no shift can run on it. This instruction is for a cabinet manager; importing products from the National Catalog is covered by a separate instruction.",
          },
          {
            kind: "unordered-list",
            items: [
              "The product group is needed by the station and by label-template selection.",
              "Box and pallet capacities decide how many units go into a package during aggregation.",
              "“Print name” is the short name that goes on the label instead of a long full name.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots were taken on demonstration data. Product names, GTINs and counterparties will differ in your cabinet.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The Chestny Znak product-group directory is maintained in Russian and the cabinet shows its names as received, so group names stay Russian on an English screen. Everything else on these screens follows the interface language.",
          },
        ],
      },
      {
        id: "list",
        heading: "2. Product list",
        blocks: [
          {
            kind: "step",
            title: "Open the “Catalog” section",
            text: "In the cabinet side menu pick “Catalog” under “Reference data”. The table shows GTIN, photo, name, group, per-box capacity, the card status and Chestny Znak information; the “Actions” column holds “Edit” and “Delete”.",
            image: {
              id: "catalog-list",
              caption: "Product catalog: three products in different statuses",
            },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Active",
                detail:
                  "The card is complete: the product can be picked when planning a shift and during a stock count.",
              },
              {
                term: "Draft",
                detail:
                  "The card is missing the product group or a capacity. The product is visible in the catalog but unavailable in a shift.",
              },
              {
                term: "Not in use",
                detail:
                  "The product was retired by hand with the “Do not use” checkbox (section 7).",
              },
            ],
          },
          {
            kind: "step",
            title: "Find the product you need",
            text: "The “Search” field takes a name or a GTIN. The “Status” list filters by card status, “CHZ status” by the state of the card in Chestny Znak, and “Per page” sets the page size. The number of products found is printed under the filters.",
            image: {
              id: "catalog-filters",
              caption: "The “Status” filter: only drafts are left in the list",
            },
            expected: "Only products with the chosen status remain in the table.",
          },
        ],
      },
      {
        id: "create",
        heading: "3. A new product: the basics",
        blocks: [
          {
            kind: "step",
            title: "Create the card",
            text: "Press “Add product”. The “New product” panel opens with four sections: “Basic”, “Aggregation and price”, “Product photo” and “Defaults”.",
            image: { id: "product-new", caption: "A new product card: the “Basic” section" },
          },
          {
            kind: "step",
            title: "Enter the GTIN and the names",
            text: "“GTIN” is the product code; the cabinet checks its check digit immediately and answers a wrong one with “Invalid GTIN (check digit mismatch)”. “Name” is the full name used in the cabinet and in reports. Fill in “Print name” when the full name is too long for a label: “Short name for the station and label. Blank — the full name is used.”",
          },
          {
            kind: "step",
            title: "Check who owns the GTIN",
            text: "For a valid GTIN the cabinet shows who it is registered to: “GTIN owner — …”. If that is a counterparty — for example when you bottle under someone else's brand — the “Apply counterparty” button writes it straight into the defaults. The warning “GTIN owner could not be determined — double check the code before saving.” means the code was found neither behind you nor behind a known counterparty.",
            image: {
              id: "product-gtin-owner",
              caption: "The GTIN is registered to a counterparty",
            },
          },
        ],
      },
      {
        id: "activate",
        heading: "4. Reaching the active status",
        blocks: [
          {
            kind: "paragraph",
            text: "The cabinet computes the card status itself; it is never set by hand. Until the product group and both capacities are filled in, the card stays a draft.",
          },
          {
            kind: "step",
            title: "Fill in what is missing",
            text: "A draft carries the banner “Draft — fill in the group and capacities to run shifts” at the top of the card. Pick “Product group” from the Chestny Znak directory and set “Box capacity, units” and “Pallet capacity, units” as whole numbers above zero.",
            image: {
              id: "product-draft-banner",
              caption: "A draft: the group and the capacities are empty",
            },
          },
          {
            kind: "step",
            title: "Save the card",
            text: "Press “Save”. The remaining fields of “Aggregation and price” — “Price per unit, ₽”, “EGAIS code” and “Shelf life, days” — are optional and do not affect the status.",
            image: {
              id: "product-active",
              caption: "A complete card: the group and both capacities are in place",
            },
            expected:
              "The product reached the “Active” status in the list and became available when planning a shift.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "If a product cannot be found in the shift form, check its status in the catalog: a draft and a product marked “Do not use” are both unavailable in the product picker.",
          },
        ],
      },
      {
        id: "image",
        heading: "5. Photo",
        blocks: [
          {
            kind: "step",
            title: "Add a product photo",
            text: "In the “Product photo” section drag a file onto “Drop a file or click” or pick it by hand. The limits are printed beside it: “JPEG, PNG, or WebP up to 5 MB”. The uploaded picture is visible in the catalog list and helps an operator not to confuse products; “Remove photo” takes it away.",
            image: { id: "product-image", caption: "The “Product photo” section with an upload" },
            expected: "A thumbnail appeared in the “Photo” column of the catalog list.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Until a picture is uploaded the card shows “No photo added” and the list prints a dash in the “Photo” column. A photo does not affect the card status.",
          },
        ],
      },
      {
        id: "defaults",
        heading: "6. Default values",
        blocks: [
          {
            kind: "step",
            title: "Name the default counterparty",
            text: "“Default counterparty” is substituted into a shift when the product is bottled for another organization. The field is optional: leave “None selected” when the product is always your own.",
            image: { id: "product-defaults", caption: "Defaults: a counterparty is filled in" },
          },
        ],
      },
      {
        id: "retire",
        heading: "7. Retiring a product",
        blocks: [
          {
            kind: "paragraph",
            text: "A product that is no longer made is retired with a checkbox rather than deleted: the history of shifts and stock counts has to stay.",
          },
          {
            kind: "step",
            title: "Tick “Do not use”",
            text: "Open the card and tick “Do not use” in the “Basic” section. The hint under the checkbox spells out the consequences: “The product cannot be selected on kiosks, in shifts, or in integrations. It stays available for inventory and in history, and its GTIN can be reused in a new card.”",
            image: { id: "product-archived", caption: "The card of a retired product" },
            expected: "The product got the “Not in use” status in the list.",
          },
          {
            kind: "step",
            title: "Delete only cards created by mistake",
            text: "The “Delete” button in a list row asks for confirmation: “Delete product?”, warning that the product “will be permanently deleted”. Delete only a card that was created by mistake and has not been used in production yet.",
            image: { id: "catalog-delete", caption: "Confirming a product deletion" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Deletion cannot be undone. If shifts or stock counts already ran on the product, use “Do not use” instead — otherwise the documents are left without their product.",
          },
        ],
      },
      {
        id: "external",
        heading: "8. Products from external sources",
        blocks: [
          {
            kind: "paragraph",
            text: "Besides being entered by hand, a product reaches the catalog along two other paths, each with its own entry point.",
          },
          {
            kind: "step",
            title: "The 1C exchange",
            text: "When the exchange delivers products that are not matched to the catalog yet, a plaque appears above the list: “New items arrived in the exchange (…) — check the unmatched queue.” The “Go to the queue” link opens the “Integrations” section, where a candidate is linked to a catalog card. The plaque and the linking are available to employees with integration rights.",
            image: {
              id: "candidates-plaque",
              caption: "The plaque for unmatched products from the exchange",
            },
          },
          {
            kind: "paragraph",
            text: "The “Add from National Catalog” button in the section header creates cards from Chestny Znak data — that path is covered by the separate instruction on importing from the National Catalog.",
          },
        ],
      },
      {
        id: "troubleshooting",
        heading: "9. Common questions",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The cabinet rejects the GTIN",
                detail:
                  "The message “Invalid GTIN (check digit mismatch)” points at the code itself, not at your rights: check the digits against the packaging or the supplier's documents.",
              },
              {
                term: "The product is missing when planning a shift",
                detail:
                  "Check its status in the catalog: a draft stays unavailable until the group and the capacities are filled in, and a product marked “Do not use” is hidden from the picker on purpose.",
              },
              {
                term: "The GTIN owner could not be determined",
                detail:
                  "The code was found neither behind your organization nor behind a counterparty. Check it before saving: someone else's GTIN in a card leads to codes being rejected on the line.",
              },
              {
                term: "The GTIN of a retired product is needed again",
                detail:
                  "After “Do not use” that GTIN can be entered in a new card — the old one stays in history.",
              },
              {
                term: "The “Chestny ZNAK” column is empty",
                detail:
                  "The card is not linked to the National Catalog, or the information has not arrived yet. Linking is covered by the instruction on importing from the National Catalog.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "If your problem is not described above, contact your organization's administrator or Markiro support: hello@v-b.tech.",
          },
        ],
      },
    ],
  },
} as const satisfies LegalDocumentSource["content"];
