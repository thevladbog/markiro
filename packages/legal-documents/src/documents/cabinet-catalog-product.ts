import type { LegalDocumentSource } from "../types.js";

export const CABINET_CATALOG_PRODUCT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Офис: товары и карточка товара",
    summary:
      "Инструкция администратора и технолога Маркиро Автоном: список товаров, новая карточка, GTIN и его владелец, доведение черновика до состояния «Активен», фото, шаблоны и контрагент по умолчанию, архив.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает раздел «Товары» офиса Маркиро Автоном: как завести карточку товара, довести её до рабочего состояния и убрать товар из работы. Смену планируют только на активный товар — это описано в MKR-INS-08.",
          },
          {
            kind: "paragraph",
            text: "Заводить и менять товары могут обе роли офиса — администратор и технолог. Контрагентов и профиль организации, от которых зависит владелец GTIN, меняет только администратор.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационной площадке. Названия, GTIN и количества у вас будут другими.",
          },
        ],
      },
      {
        id: "list",
        heading: "2. Список товаров",
        blocks: [
          {
            kind: "step",
            title: "Откройте раздел «Товары»",
            text: "Раздел «Товары» — «Товары для смен: название, GTIN, название для печати и фото.» В таблице: фото и название с названием для печати, «GTIN», «Товарная группа», «В коробе, шт.» и «Состояние» — «Активен», «Черновик» или «В архиве». «Поиск» ищет по названию, названию для печати и GTIN, «Состояние» отбирает товары по состоянию.",
            image: { id: "products-list", caption: "Раздел «Товары»" },
          },
        ],
      },
      {
        id: "new",
        heading: "3. Новый товар",
        blocks: [
          {
            kind: "step",
            title: "Создайте карточку",
            text: "Нажмите «Добавить товар» — справа откроется «Новый товар». Введите «GTIN» — «8, 12, 13 или 14 цифр». Короткий GTIN офис дополнит нулями и покажет, как он сохранится: «Сохранится как …». Затем «Название» и, если нужно, «Название для печати» — «Необязательно: короткое название для этикетки». Нажмите «Добавить».",
            image: { id: "product-new", caption: "Новый товар: GTIN, владелец и названия" },
            expected: "Офис сообщил «Товар «…» добавлен.»",
          },
          {
            kind: "step",
            title: "Проверьте владельца GTIN",
            text: "Под GTIN офис пишет, чей это номер, по префиксам GS1: «Префикс GTIN — вашей организации.», «Префикс GTIN — контрагента «…».» или «Владелец GTIN не определён: префикс не совпал ни с организацией, ни с контрагентами.» Префиксы организации задаются в «Профиль» («Префиксы GS1»), префиксы контрагентов — в разделе «Контрагенты». Подсказка не запрещает сохранить товар: она помогает заметить чужой или ошибочный номер.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Один GTIN не может быть у двух товаров в работе: офис ответит «Этот GTIN уже у товара в работе». GTIN архивного товара не проверяется и номер не занимает.",
          },
        ],
      },
      {
        id: "active",
        heading: "4. Черновик и «Активен»",
        blocks: [
          {
            kind: "step",
            title: "Заполните поля, без которых товар остаётся черновиком",
            text: "Пока карточка не полна, под полями стоит «Товар остаётся черновиком, пока не указаны товарная группа, вместимость короба и число коробов на паллете.» Заполните «Товарная группа», «В коробе, шт.» и «Коробов на паллете» («Необязательно; число коробов, а не штук») и нажмите «Сохранить» — товар станет «Активен».",
            image: {
              id: "product-draft",
              caption: "Черновик: товарная группа и вместимости не заданы",
            },
            expected: "В списке у товара состояние «Активен».",
          },
          {
            kind: "paragraph",
            text: "«Срок годности, дней» необязателен; станция берёт его из карточки, когда печатает этикетки. Для товарной группы, где нужен код ЕГАИС, появляется поле «Код ЕГАИС» — «Печатается на этикетке короба и паллеты. Обычно 19 цифр.»",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Черновик нельзя выбрать в смене: его нет в списке формы «Новая смена». Если черновиком стал товар уже запланированной смены, в списке смен появится «Не откроется: товар — черновик».",
          },
        ],
      },
      {
        id: "card",
        heading: "5. Фото, шаблоны и контрагент",
        blocks: [
          {
            kind: "step",
            title: "Добавьте фото товара",
            text: "Карандаш в строке товара открывает карточку. Вверху — «Фото товара»: «Загрузить фото», у товара с фото — «Заменить фото» и «Удалить фото». «JPEG, PNG или WebP. Фото уменьшается до 640 × 640 точек и сжимается до 300 КБ; прозрачный фон PNG и WebP сохраняется.» У существующего товара «Фото сохраняется сразу, без кнопки «Сохранить», и печатается на бланке смены.»",
            image: { id: "product-card", caption: "Карточка товара с фото" },
          },
          {
            kind: "step",
            title: "Задайте значения по умолчанию",
            text: "Внизу карточки — «Шаблон короба» и «Шаблон паллеты» («Необязательно: станция возьмёт этот шаблон первым, пока он подходит товару»), «Лист А4 паллеты» и «Контрагент по умолчанию» — «Подставляется в смену этого товара, если контрагент не выбран». Эти значения подставляются в форму смены, и там их можно изменить (MKR-INS-08).",
            image: {
              id: "product-card-end",
              caption: "Шаблоны, лист А4 и контрагент по умолчанию",
            },
          },
          {
            kind: "paragraph",
            text: "Шаблон, не заданный в карточке, станция берёт из шаблонов по умолчанию — категории товара, затем организации. Они настраиваются в разделе «Шаблоны».",
          },
        ],
      },
      {
        id: "archive",
        heading: "6. Вывод товара из работы",
        blocks: [
          {
            kind: "step",
            title: "Уберите товар в архив",
            text: "Меню «…» в строке товара → «Убрать в архив» или отметка «В архиве» в карточке. Офис объясняет: товар «уйдёт в архив: его нельзя будет выбрать для новой смены. Товар, который был в производстве, удалить нельзя, поэтому он остаётся в истории смен и кодов.»",
            image: { id: "product-archive", caption: "Подтверждение архива" },
            expected: "У товара состояние «В архиве».",
          },
          {
            kind: "paragraph",
            text: "Удалить карточку нельзя — только убрать в архив. Если GTIN был введён с ошибкой, уберите товар в архив и заведите новую карточку с правильным GTIN. «Вернуть из архива» возвращает товар в работу; GTIN тогда проверится заново, и его не должно быть у другого товара в работе.",
          },
        ],
      },
      {
        id: "faq",
        heading: "7. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Товар не выбирается в смене",
                detail:
                  "Он черновик или в архиве. Заполните товарную группу и обе вместимости либо верните товар из архива.",
              },
              {
                term: "Владелец GTIN не определён",
                detail:
                  "Префикс GTIN не совпал ни с «Префиксы GS1» организации, ни с префиксами контрагентов. Проверьте GTIN и префиксы.",
              },
              {
                term: "Отметка «С паллетами» в смене недоступна",
                detail: "У товара не задано «Коробов на паллете». Укажите его в карточке.",
              },
              {
                term: "Фото не попало на бланк смены",
                detail:
                  "Новый товар сохраняет фото вместе с карточкой; если оно не загрузилось, офис скажет об этом — откройте товар и загрузите фото ещё раз.",
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
    title: "Office: products and the product card",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Guide for Markiro Autonom office administrators and technologists: the list of products, a new card, the GTIN and its owner, completing a draft until it is active, the photo, default templates and counterparty, and archiving.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers the «Товары» (Products) section of the Markiro Autonom office: creating a product card, completing it and taking a product out of use. Shifts are planned for active products only — see MKR-INS-08.",
          },
          {
            kind: "paragraph",
            text: "The application interface is in Russian only, so the screenshots show the Russian screens. Interface labels are quoted in Russian, followed by an English gloss in parentheses.",
          },
          {
            kind: "paragraph",
            text: "Both office roles — administrator and technologist — create and change products. Only the administrator changes the counterparties and the organization profile on which the GTIN owner depends.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots were taken on a demonstration site. Your names, GTINs and quantities will differ.",
          },
        ],
      },
      {
        id: "list",
        heading: "2. The list of products",
        blocks: [
          {
            kind: "step",
            title: "Open the «Товары» (Products) section",
            text: "The section lists the products for shifts: name, GTIN, print name and photo. The table shows the photo and the name with the print name, GTIN, «Товарная группа» (Product group), «В коробе, шт.» (Per box, pcs) and «Состояние» (State) — «Активен» (Active), «Черновик» (Draft) or «В архиве» (Archived). «Поиск» (Search) looks in the name, print name and GTIN; «Состояние» filters by state.",
            image: { id: "products-list", caption: "The «Товары» (Products) section" },
          },
        ],
      },
      {
        id: "new",
        heading: "3. A new product",
        blocks: [
          {
            kind: "step",
            title: "Create a card",
            text: "Click «Добавить товар» (Add product) — «Новый товар» (New product) opens on the right. Enter «GTIN» — 8, 12, 13 or 14 digits. The office pads a short GTIN with zeros and shows how it will be saved: «Сохранится как …» (Will be saved as …). Then «Название» (Name) and, if needed, «Название для печати» (Print name) — an optional short name for the label. Click «Добавить» (Add).",
            image: { id: "product-new", caption: "New product: GTIN, owner and names" },
            expected: "The office reports «Товар «…» добавлен.» (Product «…» added.)",
          },
          {
            kind: "step",
            title: "Check the GTIN owner",
            text: "Under the GTIN the office states whose number it is, by GS1 prefixes: the organization's, a counterparty's (named), or «Владелец GTIN не определён» (GTIN owner not determined) when the prefix matches neither. The organization's prefixes are set in «Профиль» (Profile), «Префиксы GS1» (GS1 prefixes); counterparties' prefixes in the «Контрагенты» (Counterparties) section. The note does not prevent saving: it helps to notice a foreign or mistyped number.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "One GTIN cannot belong to two products in use: the office answers «Этот GTIN уже у товара в работе» (This GTIN already belongs to a product in use). An archived product's GTIN is not checked and does not take the number.",
          },
        ],
      },
      {
        id: "active",
        heading: "4. Draft and active",
        blocks: [
          {
            kind: "step",
            title: "Fill in the fields without which a product stays a draft",
            text: "While the card is incomplete, a note says the product stays a draft until the product group, the box capacity and the boxes per pallet are set. Fill in «Товарная группа» (Product group), «В коробе, шт.» (Per box, pcs) and «Коробов на паллете» (Boxes per pallet; boxes, not units) and click «Сохранить» (Save) — the product becomes «Активен» (Active).",
            image: {
              id: "product-draft",
              caption: "A draft: product group and capacities not set",
            },
            expected: "The product's state in the list is «Активен» (Active).",
          },
          {
            kind: "paragraph",
            text: "«Срок годности, дней» (Shelf life, days) is optional; the station takes it from the card when it prints labels. For a product group that needs an EGAIS code, the «Код ЕГАИС» (EGAIS code) field appears; it is printed on box and pallet labels and usually has 19 digits.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "A draft cannot be chosen for a shift: it is not in the «Новая смена» (New shift) form's list. If the product of an already planned shift becomes a draft, the list of shifts shows «Не откроется: товар — черновик» (Will not open: the product is a draft).",
          },
        ],
      },
      {
        id: "card",
        heading: "5. Photo, templates and counterparty",
        blocks: [
          {
            kind: "step",
            title: "Add a product photo",
            text: "The pencil in a product's row opens its card. At the top is «Фото товара» (Product photo): «Загрузить фото» (Upload photo), and for a product with a photo «Заменить фото» (Replace photo) and «Удалить фото» (Delete photo). JPEG, PNG or WebP; the photo is reduced to 640 × 640 pixels and compressed to 300 KB, keeping a transparent PNG or WebP background. For an existing product the photo is saved at once, without «Сохранить» (Save), and is printed on the shift sheet.",
            image: { id: "product-card", caption: "Product card with a photo" },
          },
          {
            kind: "step",
            title: "Set the defaults",
            text: "At the bottom of the card are «Шаблон короба» (Box template) and «Шаблон паллеты» (Pallet template) — optional: the station takes this template first while it fits the product — «Лист А4 паллеты» (A4 pallet sheet) and «Контрагент по умолчанию» (Default counterparty), which is filled into this product's shift when no counterparty is chosen. These values are filled into the shift form and can be changed there (MKR-INS-08).",
            image: {
              id: "product-card-end",
              caption: "Templates, A4 sheet and default counterparty",
            },
          },
          {
            kind: "paragraph",
            text: "A template not set in the card is taken by the station from the default templates — the product category's, then the organization's. They are set in the «Шаблоны» (Templates) section.",
          },
        ],
      },
      {
        id: "archive",
        heading: "6. Taking a product out of use",
        blocks: [
          {
            kind: "step",
            title: "Archive the product",
            text: "«…» menu in a product's row → «Убрать в архив» (Archive), or the «В архиве» (Archived) checkbox in the card. The office explains that the product goes to the archive and can no longer be chosen for a new shift, and that a product that has been in production cannot be deleted, so it stays in the history of shifts and codes.",
            image: { id: "product-archive", caption: "Confirming the archive" },
            expected: "The product's state is «В архиве» (Archived).",
          },
          {
            kind: "paragraph",
            text: "A card cannot be deleted — only archived. If the GTIN was mistyped, archive the product and create a new card with the correct GTIN. «Вернуть из архива» (Restore from archive) puts the product back in use; its GTIN is then checked again and must not belong to another product in use.",
          },
        ],
      },
      {
        id: "faq",
        heading: "7. Frequently asked questions",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The product cannot be chosen for a shift",
                detail:
                  "It is a draft or archived. Fill in the product group and both capacities, or restore the product from the archive.",
              },
              {
                term: "The GTIN owner is not determined",
                detail:
                  "The GTIN's prefix matches neither the organization's «Префиксы GS1» (GS1 prefixes) nor the counterparties' prefixes. Check the GTIN and the prefixes.",
              },
              {
                term: "The «С паллетами» checkbox is unavailable in a shift",
                detail:
                  "The product has no «Коробов на паллете» (Boxes per pallet). Set it in the card.",
              },
              {
                term: "The photo is not on the shift sheet",
                detail:
                  "A new product saves its photo together with the card; if it did not upload, the office says so — open the product and upload the photo again.",
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
