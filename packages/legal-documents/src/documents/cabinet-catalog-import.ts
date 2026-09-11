import type { LegalDocumentSource } from "../types.js";

export const CABINET_CATALOG_IMPORT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Кабинет: загрузка товаров из Национального каталога",
    summary:
      "Инструкция менеджера: как загрузить карточки товаров из Национального каталога Честного знака, проверить поля и фотографию перед добавлением и управлять связью товара с карточкой ЧЗ.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Загрузка из Национального каталога — второй способ завести товар в каталоге: вместо ручного заполнения кабинет берёт данные из карточки Честного знака. Инструкция предназначена для менеджера кабинета с правом на изменение операций; ручное ведение карточки описано в отдельной инструкции по каталогу продукции.",
          },
          {
            kind: "unordered-list",
            items: [
              "Название, наименование для печати и группа продукции переносятся из карточки ЧЗ — вручную их набирать не нужно.",
              "Фотография товара берётся из карточки ЧЗ, если она там есть и её штрихкод совпадает с ГТИН товара.",
              "Между товаром и карточкой ЧЗ остаётся связь: по ней кабинет показывает статус карточки и позволяет сверять её с товаром.",
            ],
          },
          {
            kind: "paragraph",
            text: "Панель загрузки открывается кнопкой «Добавить из Национального каталога» в шапке раздела «Каталог» и работает в три этапа: выбор товаров, проверка товаров, результат. Этапы видны в верхней части панели и переключаются по мере готовности данных.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Названия товаров, ГТИН, идентификаторы карточек и даты в вашем кабинете будут отличаться.",
          },
        ],
      },
      {
        id: "prerequisites",
        heading: "2. Перед началом",
        blocks: [
          {
            kind: "paragraph",
            text: "Загрузка работает только тогда, когда организация подключена к Честному знаку, а у сотрудника есть право на изменение операций. Подключение настраивает администратор в разделе интеграций; из этой панели его включить нельзя.",
          },
          {
            kind: "step",
            title: "Проверьте, что подключение настроено",
            text: "Если подключения нет, панель открывается, но оба способа загрузки заблокированы: наверху стоит подсказка «Подключите Честный ЗНАК в настройках интеграций.», а под каждой кнопкой — «Этот способ добавления сейчас недоступен. Обратитесь к администратору.». В этом состоянии дальше идти некуда — обратитесь к администратору организации.",
            image: {
              id: "import-unavailable",
              caption: "Панель загрузки без подключения к Честному знаку",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Кабинет видит не весь Национальный каталог: «Доступны только ваши карточки и карточки с предоставленным доступом.» Чужая карточка без выданного доступа не найдётся ни списком, ни по ГТИН.",
          },
          {
            kind: "paragraph",
            text: "Сотруднику без права на изменение панель показывает сохранённые сессии и результаты, но кнопки добавления недоступны.",
          },
        ],
      },
      {
        id: "modes",
        heading: "3. Два способа загрузки",
        blocks: [
          {
            kind: "step",
            title: "Выберите способ",
            text: "«Загрузить мои товары» забирает из Честного знака весь доступный каталог организации — так удобно заводить товары в первый раз. Поле «Список GTIN» — точечная загрузка: «Вставьте коды через пробел, запятую или новую строку. Ошибки будут показаны отдельно для каждой строки.», после чего нажимают «Найти по GTIN».",
            image: {
              id: "import-start",
              caption: "Два способа загрузки: весь каталог или список GTIN",
            },
            expected: "Панель перешла к этапу «Выбор товаров» и начала наполнять список.",
          },
          {
            kind: "paragraph",
            text: "Способы включаются независимо друг от друга: возможности зависят от подключения и его настроек, поэтому один из них может быть доступен, а второй — нет. Заблокированный способ всегда сопровождается пояснением под кнопкой.",
          },
        ],
      },
      {
        id: "selection",
        heading: "4. Выбор товаров",
        blocks: [
          {
            kind: "step",
            title: "Дождитесь загрузки списка",
            text: "Над списком кабинет пишет, сколько строк уже загружено и когда началась загрузка. Список наполняется постепенно: уже загруженные товары можно выбирать, не дожидаясь конца. Поле «Поиск по загруженным товарам» и список «Статус карточки» сужают выборку, кнопки «Предыдущая страница» и «Следующая страница» листают её.",
            image: {
              id: "import-selection",
              caption: "Этап «Выбор товаров»: загруженная карточка и её сопоставление",
            },
          },
          {
            kind: "paragraph",
            text: "Столбец «Сопоставление» показывает, что кабинет уже знает про каждую карточку. От этого значения зависит, что произойдёт при добавлении.",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Новый товар",
                detail: "Товара с таким ГТИН в каталоге нет — будет создана новая карточка.",
              },
              {
                term: "GTIN уже есть: проверьте поля и добавьте связь",
                detail:
                  "Товар в каталоге есть, но он не связан с карточкой ЧЗ. Кабинет предложит добавить связь и, если нужно, обновить поля.",
              },
              {
                term: "Связь уже есть",
                detail: "Товар и карточка уже связаны; повторно добавлять связь не требуется.",
              },
              {
                term: "Товар связан с другой карточкой",
                detail:
                  "У товара есть связь с иной карточкой ЧЗ. Замену придётся подтвердить на этапе проверки.",
              },
              {
                term: "Архивный товар в каталоге",
                detail: "Товар выведен из оборота галочкой «Не использовать» в карточке каталога.",
              },
              {
                term: "Несколько совпадений: уточните выбор",
                detail: "По этому ГТИН в каталоге нашлось больше одного товара — выберите вручную.",
              },
              {
                term: "Нет доступа к карточке",
                detail:
                  "Карточка существует, но организации не выдан доступ к ней в Национальном каталоге.",
              },
            ],
          },
          {
            kind: "step",
            title: "Отметьте товары и перейдите к проверке",
            text: "Счётчик «Выбрано: 0 из 100» показывает предел одной операции — больше ста позиций за раз добавить нельзя. Галочка «Выбрать все на странице (1)» отмечает всю видимую страницу. Когда выбор готов, нажмите «Проверить выбранные товары».",
            expected:
              "Панель перешла к этапу «Проверка товаров» и подготовила данные по каждой позиции.",
          },
        ],
      },
      {
        id: "review",
        heading: "5. Проверка перед применением",
        blocks: [
          {
            kind: "paragraph",
            text: "Этап проверки — единственное место, где видно, что именно изменится. Подсказка наверху формулирует правило: «Проверьте связь, поля и фото каждого товара. Изменятся только выбранные поля.»",
          },
          {
            kind: "step",
            title: "Сравните текущее и предлагаемое",
            text: "Позиции разложены по вкладкам: счётчик «Товар 1 из 1» и кнопки «Предыдущий товар» и «Следующий товар» переключают их. Поля показаны парами: слева — то, что сейчас в каталоге, справа — «Предлагаемое значение» с пометкой «Из Честного знака». Галочка на карточке значения означает, что оно будет применено; «Не добавлять» в левой колонке значит, что поле в каталоге пока пустое. Флажок «Отображать только сопоставимые поля» убирает из списка то, что перенести нельзя.",
            image: {
              id: "import-review",
              caption: "Проверка товара: три поля и фотография из карточки ЧЗ",
            },
          },
          {
            kind: "step",
            title: "Задайте название вручную, если его нет",
            text: "Поле «Название вручную» перекрывает название из карточки: «До 200 символов. Пустое поле использует название карточки; если его нет, введите название.» Для товара, который уже есть в каталоге, появляется флажок добавить только связь, не трогая поля, а для товара со связью с другой карточкой — отдельное подтверждение замены связи.",
          },
          {
            kind: "step",
            title: "Сверьте итог и примените",
            text: "Внизу панель считает итог: «Создать товаров: 1 · Добавить связей: 1 · Заменить связей: 0 · Изменить товаров: 0 · Загрузить фото: 1». Кнопка «Обновить данные для проверки» перечитывает данные из Честного знака, «Применить выбранное» запускает добавление.",
            expected: "Панель перешла к этапу «Результат».",
          },
          {
            kind: "step",
            title: "Разберитесь с позицией, которую применить нельзя",
            text: "Если позицию применить нельзя, её вкладка помечена «Недоступен», а причина написана и над формой, и рядом с проблемным полем. В примере ниже это «Категории ЧЗ указывают на несколько групп или противоречат друг другу. Выберите группу в карточке товара.»: значение группы в правой колонке — «Не заполнено», кнопка «Применить выбранное» заблокирована, а внизу стоит «Завершите выбор и обновите данные для проверки, чтобы увидеть итог добавления.».",
            image: {
              id: "import-review-blocked",
              caption: "Позиция с неоднозначной группой продукции: применение заблокировано",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Подготовленные данные живут ограниченное время. Если между проверкой и применением прошло много времени, кабинет попросит обновить данные для проверки — это защита от применения устаревшего сравнения.",
          },
        ],
      },
      {
        id: "photo",
        heading: "6. Фотография",
        blocks: [
          {
            kind: "step",
            title: "Выберите снимок из карточки ЧЗ",
            text: "Блок «Фото» устроен как остальные поля: слева — то, что сейчас у товара, справа — снимок «Из Честного знака» с кнопкой «Выбрать это фото». Если фотографии у товара ещё нет, слева стоит «Без фото».",
            image: { id: "import-photo", caption: "Блок «Фото»: снимок из карточки ЧЗ выбран" },
            expected: "Снимок отмечен галочкой и войдёт в итог как загружаемое фото.",
          },
          {
            kind: "paragraph",
            text: "Снимок не появляется в карточке мгновенно: кабинет сначала готовит его. Пока подготовка идёт, у кандидата стоит «Фото готовится», а неудачная подготовка помечается как «Фото не загружено».",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "GTIN фотографии отличается от GTIN товара",
                detail:
                  "Снимок привязан к другому коду. Выбирайте его только после проверки — иначе на этикетке окажется чужой товар.",
              },
              {
                term: "У фото некорректный GTIN",
                detail: "Код на снимке не проходит проверку, поэтому кабинет его не предлагает.",
              },
              {
                term: "Подготовка новых фото сейчас недоступна",
                detail:
                  "Можно сохранить текущее фото товара или добавить товар без фото; на остальные поля это не влияет.",
              },
            ],
          },
        ],
      },
      {
        id: "result",
        heading: "7. Результат",
        blocks: [
          {
            kind: "step",
            title: "Прочитайте итог по каждой позиции",
            text: "Наверху этапа стоит состояние всей операции — например «Обработка завершена». Для каждой позиции отдельно указан итог по товару и по фотографии: «Товар: Добавлен», «Фото: Ошибка загрузки». Неудача сопровождается объяснением и кнопкой повтора: «Не удалось загрузить фото. Товар можно добавить отдельно.», «Товар добавлен. Фото не загрузилось.», «Повторить загрузку фото».",
            image: {
              id: "import-result",
              caption: "Результат: товар добавлен, фотография не загрузилась",
            },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Добавлен",
                detail: "Товар создан или обновлён, связь с карточкой записана.",
              },
              {
                term: "Конфликт данных",
                detail:
                  "Данные изменились между проверкой и применением. Обновите данные для проверки и повторите.",
              },
              { term: "Ошибка", detail: "Позиция не добавлена; кнопка повтора рядом с ней." },
              {
                term: "Остановлено",
                detail:
                  "Дальнейшее добавление прервано кнопкой остановки, уже добавленное сохранено.",
              },
            ],
          },
          {
            kind: "step",
            title: "Дождитесь сохранения фотографии",
            text: "Пока операция идёт, состояние читается как «Добавление продолжается», а фотография стоит в очереди: «Фото: Ожидает». Кнопка «Открыть товар в каталоге» в это время заблокирована, и рядом написано почему: «Сохраняем фото. После завершения можно открыть карточку товара.» Кнопка «Остановить дальнейшее добавление» прекращает обработку оставшихся позиций.",
            image: {
              id: "import-result-photo",
              caption: "Товар добавлен, фотография ещё сохраняется",
            },
            expected:
              "После сохранения фотографии кнопка «Открыть товар в каталоге» становится доступна.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Результат операции сохраняется: панель можно закрыть и вернуться к нему позже, а повтор неудавшихся позиций не создаёт дубликатов уже добавленных товаров.",
          },
        ],
      },
      {
        id: "chz-link",
        heading: "8. Связь с Честным знаком",
        blocks: [
          {
            kind: "paragraph",
            text: "После добавления у товара появляется связь с карточкой ЧЗ. В каталоге за неё отвечает отдельный столбец: он показывает состояние карточки в Честном знаке, а по ссылке открывается панель «Связь с Честным знаком».",
          },
          {
            kind: "step",
            title: "Посмотрите сведения о связи",
            text: "Панель показывает статус карточки — например «Опубликовано» — и сохранённые сведения: «Карточка», «Среда» («Промышленная» или тестовая), «GTIN связи», «Связь подтверждена». Ссылка «Подробнее» раскрывает даты «Успешная проверка» и «Последняя попытка».",
            image: { id: "chz-link", caption: "Панель связи товара с карточкой Честного знака" },
          },
          {
            kind: "unordered-list",
            items: [
              "«Обновить статус» перечитывает состояние карточки в Честном знаке.",
              "«Сравнить карточку» открывает ту же проверку полей, что и при загрузке, — по уже связанной карточке.",
              "«Удалить связь» убирает только связь: товар, принятые значения, фотография и история остаются в каталоге.",
              "«Перечитать сведения» перезапрашивает саму панель, если данные не отобразились.",
            ],
          },
          {
            kind: "step",
            title: "Прочитайте, если проверка не удалась",
            text: "Неудачная проверка не стирает сохранённые сведения: кабинет помечает её строкой «Последняя проверка не удалась. Показаны сохранённые сведения.», а причину прячет под «Подробнее» — в примере ниже это «Связанная карточка недоступна в ЧЗ.». Статус карточки при этом остаётся прежним, с даты последней успешной проверки.",
            image: {
              id: "chz-refresh-error",
              caption: "Проверка не удалась: сохранённые сведения и причина",
            },
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
                term: "Кабинет не смог определить группу продукции",
                detail:
                  "Категории карточки в ЧЗ не дают однозначной группы или её ещё нет в справочнике Маркиро. Товар всё равно можно добавить, а группу выбрать вручную в карточке товара.",
              },
              {
                term: "Товар уже связан с другой карточкой",
                detail:
                  "Замена связи требует явного подтверждения на этапе проверки. Прежде чем подтверждать, убедитесь, что новая карточка описывает тот же товар.",
              },
              {
                term: "Данные проверки устарели",
                detail:
                  "Между подготовкой и применением прошло слишком много времени. Нажмите «Обновить данные для проверки» и сверьте значения заново.",
              },
              {
                term: "Фотография не загрузилась",
                detail:
                  "Товар при этом добавлен. Повторите загрузку фото кнопкой в результате или добавьте снимок вручную в карточке товара.",
              },
              {
                term: "Загрузка списка прервалась",
                detail:
                  "Уже загруженные товары остаются доступными для выбора; продолжите загрузку списка или начните её заново.",
              },
              {
                term: "Ответ на предыдущий запрос не получен",
                detail:
                  "Кабинет хранит незавершённый запрос и предлагает восстановить его результат. Сделайте это до нового добавления — иначе можно повторить уже принятую операцию.",
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
    title: "Cabinet: importing products from the National Catalog",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Manager's guide: importing product cards from the Chestny Znak National Catalog, reviewing fields and photos before applying, and managing the product's link to its Chestny Znak card.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "Importing from the National Catalog is the second way to add a product to the catalog: instead of typing everything, the cabinet takes the data from a Chestny Znak card. This instruction is for a cabinet manager with the right to change operations; filling a card by hand is covered by the separate product-catalog instruction.",
          },
          {
            kind: "unordered-list",
            items: [
              "The name, the print name and the product group are carried over from the Chestny Znak card — there is nothing to type.",
              "The product photo is taken from the Chestny Znak card when it has one and its barcode matches the product GTIN.",
              "A link remains between the product and its Chestny Znak card: through it the cabinet shows the card status and lets you compare the two.",
            ],
          },
          {
            kind: "paragraph",
            text: "The import panel opens from the “Add from National Catalog” button in the header of the “Catalog” section and works in three steps: select products, review products, result. The steps are shown at the top of the panel and switch as the data becomes ready.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots were taken on demonstration data. Product names, GTINs, card identifiers and dates will differ in your cabinet.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The Chestny Znak product-group directory is maintained in Russian and the cabinet shows its names as received, so a group name stays Russian on an English screen — as it does on the review screen below.",
          },
        ],
      },
      {
        id: "prerequisites",
        heading: "2. Before you start",
        blocks: [
          {
            kind: "paragraph",
            text: "Importing works only when the organization is connected to Chestny Znak and the employee may change operations. An administrator sets the connection up in the integrations section; it cannot be enabled from this panel.",
          },
          {
            kind: "step",
            title: "Check that the connection is configured",
            text: "Without a connection the panel still opens, but both import methods are blocked: the hint “Connect Chestny ZNAK in integration settings.” sits at the top and “This import method is currently unavailable. Contact your administrator.” sits under each button. There is nowhere to go from this state — ask your organization's administrator.",
            image: {
              id: "import-unavailable",
              caption: "The import panel without a Chestny Znak connection",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "The cabinet does not see the whole National Catalog: “Only your own cards and cards with delegated access are available.” Someone else's card without delegated access will be found neither by list nor by GTIN.",
          },
          {
            kind: "paragraph",
            text: "An employee without the right to change operations is shown saved sessions and results, but the buttons that add products stay unavailable.",
          },
        ],
      },
      {
        id: "modes",
        heading: "3. Two ways to import",
        blocks: [
          {
            kind: "step",
            title: "Pick a method",
            text: "“Load my products” takes the whole catalog the organization can reach in Chestny Znak — convenient when adding products for the first time. The “GTIN list” field is the targeted import: “Separate codes with spaces, commas or new lines. Errors are shown for each row.”, after which you press “Find by GTIN”.",
            image: {
              id: "import-start",
              caption: "Two ways to import: the whole catalog or a GTIN list",
            },
            expected: "The panel moved to the “Select products” step and began filling the list.",
          },
          {
            kind: "paragraph",
            text: "The two methods are enabled independently: what is available depends on the connection and its settings, so one of them may work while the other does not. A blocked method always carries an explanation under its button.",
          },
        ],
      },
      {
        id: "selection",
        heading: "4. Selecting products",
        blocks: [
          {
            kind: "step",
            title: "Wait for the list to load",
            text: "Above the list the cabinet prints how many rows are loaded and when loading started. The list fills up gradually: products already loaded can be selected without waiting for the end. The “Search loaded products” field and the “Card status” list narrow the selection, and “Previous page” and “Next page” page through it.",
            image: {
              id: "import-selection",
              caption: "The “Select products” step: a loaded card and its match",
            },
          },
          {
            kind: "paragraph",
            text: "The “Match” column shows what the cabinet already knows about each card. What happens when the import is applied depends on that value.",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "New product",
                detail:
                  "No product with this GTIN exists in the catalog — a new card will be created.",
              },
              {
                term: "GTIN exists: review fields and add a link",
                detail:
                  "The product is in the catalog but not linked to a Chestny Znak card. The cabinet will offer to add the link and, if needed, update the fields.",
              },
              {
                term: "Already linked",
                detail: "The product and the card are linked; there is no link left to add.",
              },
              {
                term: "Linked to another card",
                detail:
                  "The product is linked to a different Chestny Znak card. Replacing it has to be confirmed during the review step.",
              },
              {
                term: "Archived local product",
                detail:
                  "The product was retired with the “Do not use” checkbox in its catalog card.",
              },
              {
                term: "Multiple matches: review selection",
                detail: "More than one catalog product carries this GTIN — pick one by hand.",
              },
              {
                term: "No card access",
                detail:
                  "The card exists, but the organization was not granted access to it in the National Catalog.",
              },
            ],
          },
          {
            kind: "step",
            title: "Tick the products and move to the review",
            text: "The counter “Selected: 0 of 100” shows the limit of one operation — no more than a hundred positions at a time. The “Select all on this page (1)” checkbox ticks the whole visible page. When the selection is ready, press “Review selected products”.",
            expected:
              "The panel moved to the “Review products” step and prepared the data for every position.",
          },
        ],
      },
      {
        id: "review",
        heading: "5. Reviewing before applying",
        blocks: [
          {
            kind: "paragraph",
            text: "The review step is the only place that shows exactly what will change. The hint at the top states the rule: “Review each product’s link, fields and photo. Only selected fields will change.”",
          },
          {
            kind: "step",
            title: "Compare the current and the proposed value",
            text: "Positions are laid out in tabs: the counter “Product 1 of 1” and the “Previous product” and “Next product” buttons switch between them. Fields are shown in pairs: “Currently in Markiro” on the left and “Proposed value”, marked “From Chestny ZNAK”, on the right. A tick on a value card means it will be applied; “Do not add” on the left means the catalog field is still empty. The “Show only mapped fields” checkbox hides everything that cannot be carried over.",
            image: {
              id: "import-review",
              caption: "Reviewing a product: three fields and a photo from the Chestny Znak card",
            },
          },
          {
            kind: "step",
            title: "Set the name by hand when the card has none",
            text: "The “Manual name” field overrides the name from the card: “Up to 200 characters. Leave blank to use the card name; enter a name if the card has none.” For a product already in the catalog a checkbox appears that adds only the link without touching the fields, and for a product linked to another card there is a separate confirmation of the replacement.",
          },
          {
            kind: "step",
            title: "Check the totals and apply",
            text: "The panel counts the totals at the bottom: “Create products: 1 · Add links: 1 · Replace links: 0 · Change products: 0 · Upload photos: 1”. “Refresh review” re-reads the data from Chestny Znak and “Apply selected” starts adding.",
            expected: "The panel moved to the “Result” step.",
          },
          {
            kind: "step",
            title: "Deal with a position that cannot be applied",
            text: "When a position cannot be applied, its tab is marked “Unavailable” and the reason is printed both above the form and next to the offending field. In the frame below it reads “The ChZ categories indicate multiple or conflicting groups. Select the group in the product form.” The group on the right then reads “Not set”, “Apply selected” is disabled, and the bottom line says “Complete your choices and update the review to see the totals.”",
            image: {
              id: "import-review-blocked",
              caption: "A position with an ambiguous product group: applying is blocked",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Prepared data lives for a limited time. If a long while passes between the review and applying it, the cabinet asks you to refresh the review — a guard against applying a stale comparison.",
          },
        ],
      },
      {
        id: "photo",
        heading: "6. Photo",
        blocks: [
          {
            kind: "step",
            title: "Pick a photo from the Chestny Znak card",
            text: "The “Photo” block is built like the other fields: what the product has now on the left, the picture “From Chestny ZNAK” with the “Choose this photo” button on the right. When the product has no photo yet, the left side reads “No photo”.",
            image: {
              id: "import-photo",
              caption: "The “Photo” block: the Chestny Znak picture is selected",
            },
            expected: "The picture is ticked and joins the totals as an upload.",
          },
          {
            kind: "paragraph",
            text: "The picture does not reach the card instantly: the cabinet prepares it first. While that runs the candidate reads “Preparing photo”, and a failed preparation is marked “Photo not loaded”.",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "The photo GTIN differs from this product",
                detail:
                  "The picture belongs to another code. Select it only after checking — otherwise the wrong product ends up on the label.",
              },
              {
                term: "This photo has an invalid GTIN",
                detail:
                  "The code on the picture fails validation, so the cabinet does not offer it.",
              },
              {
                term: "New photos cannot be prepared right now",
                detail:
                  "Keep the product's current photo or add the product without one; the other fields are unaffected.",
              },
            ],
          },
        ],
      },
      {
        id: "result",
        heading: "7. Result",
        blocks: [
          {
            kind: "step",
            title: "Read the outcome for each position",
            text: "The state of the whole operation is printed at the top of the step — for example “Processing completed”. For every position the outcome is given separately for the product and for the photo: “Product: Added”, “Photo: Failed”. A failure comes with an explanation and a retry button: “Photo download failed. The product can be added separately.”, “Product added. Photo failed to load.”, “Retry photo upload”.",
            image: {
              id: "import-result",
              caption: "The result: the product was added, the photo failed",
            },
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Added",
                detail: "The product was created or updated and the link was saved.",
              },
              {
                term: "Data conflict",
                detail:
                  "The data changed between the review and applying it. Refresh the review and try again.",
              },
              {
                term: "Failed",
                detail: "The position was not added; its retry button sits beside it.",
              },
              {
                term: "Stopped",
                detail:
                  "Adding the remaining positions was interrupted with the stop button; what was already added is kept.",
              },
            ],
          },
          {
            kind: "step",
            title: "Wait for the photo to be saved",
            text: "While the operation runs the state reads “Adding products” and the photo is queued: “Photo: Pending”. “Open catalog product” stays disabled meanwhile, with the reason beside it: “Saving the photo. You can open the product when it is ready.” The “Stop adding remaining products” button ends the processing of the positions still queued.",
            image: {
              id: "import-result-photo",
              caption: "The product was added, the photo is still saving",
            },
            expected: "Once the photo is saved, “Open catalog product” becomes available.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The result of an operation is kept: the panel can be closed and revisited later, and retrying failed positions does not duplicate the products that were already added.",
          },
        ],
      },
      {
        id: "chz-link",
        heading: "8. The Chestny Znak link",
        blocks: [
          {
            kind: "paragraph",
            text: "Once a product is added it carries a link to its Chestny Znak card. A dedicated catalog column stands for it: the column shows the state of the card in Chestny Znak, and its link opens the “Chestny ZNAK link” panel.",
          },
          {
            kind: "step",
            title: "Read the link details",
            text: "The panel shows the card status — “Published”, for instance — and the saved details: “Card”, “Environment” (“Production” or the sandbox), “Linked GTIN” and “Link confirmed”. The “Details” toggle reveals the “Last successful check” and “Last attempt” timestamps.",
            image: {
              id: "chz-link",
              caption: "The link panel of a product and its Chestny Znak card",
            },
          },
          {
            kind: "unordered-list",
            items: [
              "“Refresh status” re-reads the state of the card in Chestny Znak.",
              "“Compare card” opens the same field review as the import does, for a card that is already linked.",
              "“Remove link” removes only the link: the product, the accepted values, the photo and the history stay in the catalog.",
              "“Reload details” re-requests the panel itself when the data did not appear.",
            ],
          },
          {
            kind: "step",
            title: "Read what a failed check means",
            text: "A failed check does not erase the saved details: the cabinet marks it with the line “The latest check failed. Saved information is shown.” and hides the reason behind “Details” — in the frame below it is “The linked card is unavailable in CHZ.” The card status stays as it was, from the moment of the last successful check.",
            image: {
              id: "chz-refresh-error",
              caption: "The check failed: the saved details and the reason",
            },
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
                term: "The cabinet could not identify the product group",
                detail:
                  "The categories of the Chestny Znak card do not give an unambiguous group, or the group is not in the Markiro reference list yet. The product can still be added and the group picked by hand in the product card.",
              },
              {
                term: "The product is already linked to another card",
                detail:
                  "Replacing a link needs an explicit confirmation during the review. Before confirming, make sure the new card describes the same product.",
              },
              {
                term: "The review data has expired",
                detail:
                  "Too much time passed between preparing the review and applying it. Press “Refresh review” and check the values again.",
              },
              {
                term: "The photo failed to load",
                detail:
                  "The product itself was added. Retry the upload from the result step, or add a picture by hand in the product card.",
              },
              {
                term: "Loading the list was interrupted",
                detail:
                  "Products already loaded stay available for selection; continue loading the list or start it again.",
              },
              {
                term: "The previous request has no confirmed response",
                detail:
                  "The cabinet keeps the unfinished request and offers to recover its result. Do that before adding anything new — otherwise an operation that was already accepted may be repeated.",
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
