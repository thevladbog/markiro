import type { LegalDocumentSource } from "../types.js";

export const CABINET_CATALOG_PRODUCT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Кабинет: каталог продукции и карточка товара",
    summary:
      "Инструкция менеджера: как завести товар в каталоге, довести карточку до статуса «Активен», проверить готовность к операциям, подтвердить категорию Национального каталога и заполнить характеристики, добавить фотографию и вывести товар из оборота.",
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
              "Вместимость короба и число коробов на паллете задают, сколько уходит в упаковку при агрегации.",
              "«Наименование для печати» — короткое имя, которое попадает на этикетку вместо длинного полного названия.",
              "Категория Национального каталога и её характеристики нужны не для смены, а для заказа кодов и ввода товара в оборот.",
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
            text: "В боковом меню кабинета выберите «Каталог» в группе «Справочники». Таблица показывает ГТИН, фото, название, группу, вместимость короба, статус карточки и сведения Честного знака; в столбце «Действия» — кнопки «Изменить» и «Удалить». Название товара — ссылка: щелчок по нему открывает карточку так же, как кнопка «Изменить».",
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
                detail: "Товар выведен из оборота вручную галочкой «Не использовать» (раздел 9).",
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
            text: "Нажмите «Добавить продукт». Откроется панель «Новый продукт» с четырьмя разделами: «Основное», «Агрегация и цена», «Фотография» и «Значения по умолчанию». Вкладок в форме нового товара нет: всё, что касается Национального каталога, появляется только у сохранённой карточки.",
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
            text: "В черновике наверху карточки видна плашка «Черновик — заполните группу и вместимости, чтобы запускать смены». Выберите «Группа продукции» из справочника Честного знака и укажите «Вместимость короба, шт» и «Коробов на паллете» — целыми числами больше нуля. Второе поле считает короба, а не единицы товара, о чём кабинет напоминает подсказкой «Количество коробов, а не единиц товара.».",
            image: {
              id: "product-draft-banner",
              caption: "Черновик: группа и вместимости не заполнены",
            },
          },
          {
            kind: "step",
            title: "Сохраните карточку",
            text: "Нажмите «Сохранить». Остальные поля раздела «Агрегация и цена» — «Цена за шт., ₽», «Срок годности, дней», а у товарной группы, продукция которой учитывается в ЕГАИС, ещё и «Код ЕГАИС» (см. раздел 6), — необязательны и на статус не влияют. У сохранённой карточки над полями появляются две вкладки — «Основное» и «Честный знак»: готовность, категория и характеристики живут на второй (разделы 5 и 6).",
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
        id: "readiness",
        heading: "5. Готовность к операциям",
        blocks: [
          {
            kind: "paragraph",
            text: "Статус карточки и готовность к операциям — разные проверки. Статус («Активен» или «Черновик») отвечает только за то, можно ли выбрать товар при планировании смены и в инвентаризации; к операциям Национального каталога он отношения не имеет. Готовность кабинет считает отдельно для каждой из четырёх операций и проверяет её по сохранённым данным карточки, а не по тому, что набрано в открытой форме. Поэтому товар со статусом «Активен» вполне может быть не готов к заказу кодов или к вводу в оборот.",
          },
          {
            kind: "step",
            title: "Откройте вкладку «Честный знак»",
            text: "Откройте товар из списка. У сохранённой карточки с правом редактирования над полями две вкладки: «Основное» — поля самого товара, «Честный знак» — всё, что связано с Национальным каталогом. Готовность, категория, характеристики и коды ЕГАИС находятся только на второй вкладке, под основными полями их нет. При доступе только на просмотр кабинет открывает карточку без вкладок: те же блоки показаны один за другим на одном экране.",
          },
          {
            kind: "step",
            title: "Прочитайте четыре измерения",
            text: "Блок «Готовность» показывает четыре измерения — «Производство», «Заказ кодов», «Ввод в оборот» и «ЕГАИС» — и состояние каждого: «Готово», «Не готово», «Нужна актуализация» или «Не применяется». Под измерением перечислено, чего не хватает; бледные строки ниже — рекомендации: они операцию не блокируют. «Не применяется» означает, что операция к этой товарной группе не относится — так подписан «ЕГАИС» у безалкогольного товара.",
            image: {
              id: "product-readiness",
              caption:
                "Готовность по операциям: производство и заказ кодов готовы, ввод в оборот ждёт характеристику",
            },
            expected: "Видно, какая операция уже доступна, а какая ждёт данных.",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Не выбрана товарная группа",
                detail:
                  "Строка «Выберите товарную группу ЧЗ.» — без группы не готово «Производство», а значит, и смену запустить нельзя.",
              },
              {
                term: "Не указано количество в коробе или на паллете",
                detail:
                  "Строки «Укажите количество в коробе.» и «Укажите количество на паллете.» относятся к полям раздела «Агрегация и цена» на вкладке «Основное».",
              },
              {
                term: "Не подтверждена категория",
                detail:
                  "Строка «Подтвердите категорию Национального каталога.» — пока категория не закреплена, «Заказ кодов» и «Ввод в оборот» остаются в состоянии «Не готово» (раздел 6).",
              },
              {
                term: "Доступна новая схема категории",
                detail:
                  "Строка «Доступна новая схема категории. Проверьте смену категории и перенос значений.» — карточка закреплена за устаревшей версией схемы, и операция переходит в «Нужна актуализация», пока вы не пройдёте смену категории.",
              },
              {
                term: "Не заполнены характеристики",
                detail:
                  "Строки вида «Заполните: Состав.» перечисляют обязательные характеристики категории; строки вида «Рекомендуется заполнить: Упаковка.» — рекомендованные, их отсутствие операцию не блокирует.",
              },
              {
                term: "Не хватает кодов ЕГАИС",
                detail:
                  "Строки «Добавьте код АП ЕГАИС.» и «Выберите основной код АП ЕГАИС.» появляются только у товарной группы, продукция которой учитывается в ЕГАИС (раздел 6).",
              },
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "Готовность считается по сохранённым данным. Пока вы не нажали «Сохранить», правки, набранные в форме, на неё не влияют.",
          },
        ],
      },
      {
        id: "category",
        heading: "6. Категория и характеристики",
        blocks: [
          {
            kind: "paragraph",
            text: "Товарная группа Честного знака задаёт вид товара крупно, а категория Национального каталога уточняет её и приносит набор характеристик, которые Честный знак ждёт при заказе кодов и вводе в оборот. Категория, характеристики и коды ЕГАИС находятся на вкладке «Честный знак» и сохраняются отдельно от основных полей товара, каждый блок своей кнопкой.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Если в форме есть несохранённые правки «ГТИН» или «Группа продукции», кабинет блокирует эти блоки и показывает подсказку «Сначала сохраните основные данные товара, затем изменяйте категорию и характеристики.». Замок работает и в обратную сторону: пока в блоке категории, характеристик или кодов ЕГАИС остались несохранённые правки, кабинет показывает «Сначала сохраните или отмените правки категории и характеристик.», поля вкладки «Основное» заблокированы, а кнопка «Сохранить» недоступна. Отдельная кнопка у каждого блока не делает блоки независимыми: незакрытая правка в одном из них останавливает работу в другом.",
          },
          {
            kind: "step",
            title: "Проверьте закреплённую категорию",
            text: "Блок «Категория и классификация» показывает, за какой категорией закреплён товар: «Категория Национального каталога», коды «ТН ВЭД» и «ОКПД2», а также «Источник» — откуда значения попали в карточку. У карточки, принятой из Честного знака, источником указан «Национальный каталог». Кнопка «Сменить категорию» открывает мастер смены.",
            image: {
              id: "product-category",
              caption: "Категория и классификация закреплённой карточки",
            },
          },
          {
            kind: "paragraph",
            text: "У карточки без категории на том же месте стоит кнопка «Выбрать категорию», а вместо кодов — объяснение, что категорию можно перенести из карточки Честного знака или выбрать вручную. Если для товарной группы категории ещё не настроены, кабинет говорит об этом отдельным сообщением: основные поля товара при этом сохранить можно.",
          },
          {
            kind: "step",
            title: "Смените категорию через перенос значений",
            text: "Нажмите «Сменить категорию» (на пустой карточке — «Выбрать категорию»), выберите категорию в списке и при необходимости поправьте «ТН ВЭД» и «ОКПД2». Если выбранная категория не сопоставлена с товарной группой однозначно, кабинет просит подтвердить выбор флажком «Подтверждаю, что категория подходит выбранной товарной группе ЧЗ.». Кнопка «Проверить изменения» ничего не применяет: она открывает экран «Проверьте перенос значений».",
          },
          {
            kind: "unordered-list",
            items: [
              "«Совместимо с новой категорией» — значение переносится как есть.",
              "«Будет преобразовано в формат новой категории» — значение переносится с приведением формата или единицы измерения.",
              "«Не применяется в новой категории; останется в истории» — такой характеристики в новой схеме нет.",
              "«Требует ручного заполнения в новой категории; текущее значение останется в истории» — характеристика есть, но значение автоматически не переносится.",
              "«Коды ЕГАИС сохраняются» — список кодов смена категории не трогает.",
            ],
          },
          {
            kind: "paragraph",
            text: "У пунктов «Совместимо с новой категорией» и «Будет преобразовано в формат новой категории» флажок кабинет уже проставил сам — снимите те, что переносить не нужно. У пунктов «Не применяется в новой категории; останется в истории» и «Требует ручного заполнения в новой категории; текущее значение останется в истории» флажка нет вовсе: эти значения переносом не затрагиваются. Кабинет предупреждает об этом строкой «Отмеченные значения перейдут в новую категорию. Остальные сохранятся в истории и перестанут участвовать в текущей готовности.». Смену применяет кнопка «Подтвердить категорию», и только после неё готовность пересчитывается по новой схеме.",
          },
          {
            kind: "step",
            title: "Заполните характеристики категории",
            text: "Блок «Характеристики категории» группирует поля по тому, зачем они нужны: сначала обязательные, затем рекомендованные и дополнительные. Пустой список выбора показывает «Не указано». У части характеристик единицу измерения выбирают рядом со значением; единицы приходят из справочника Национального каталога и не переводятся, поэтому на английском экране объём остаётся подписан по-русски. Под полем кабинет показывает уже принятое значение и его источник — например «Национальный каталог». Заполнив поля, нажмите «Сохранить характеристики».",
            image: {
              id: "product-attributes",
              caption: "Характеристики категории, сгруппированные по требованию",
            },
            expected:
              "После сохранения закрытые характеристики уходят из причин в блоке готовности.",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Обязательно для заказа кодов",
                detail:
                  "Без такой характеристики измерение «Заказ кодов» остаётся в состоянии «Не готово».",
              },
              {
                term: "Обязательно для ввода в оборот",
                detail:
                  "То же самое для «Ввод в оборот»: заказать коды можно, а ввести товар в оборот — нет.",
              },
              {
                term: "Рекомендуется",
                detail:
                  "Характеристика попадает в бледный список рекомендаций под измерением и операцию не блокирует.",
              },
              {
                term: "Дополнительно",
                detail:
                  "Характеристика на готовность не влияет; заполняйте её, если значение известно.",
              },
            ],
          },
          {
            kind: "step",
            title: "Добавьте коды АП ЕГАИС",
            text: "Блок «Коды АП ЕГАИС» кабинет показывает только для товарной группы, продукция которой учитывается в ЕГАИС, и только после того, как категория закреплена; у остальных групп измерение «ЕГАИС» в готовности подписано «Не применяется». Кнопка «Добавить код АП ЕГАИС» добавляет строку: каждый код — девятнадцать цифр, повторы в списке запрещены. Как только в списке появляется хотя бы один код, кабинет требует выбрать «Основной код АП ЕГАИС» и без этого не сохранит список. Список сохраняется кнопкой «Сохранить коды ЕГАИС», отдельно от характеристик.",
          },
          {
            kind: "paragraph",
            text: "Пока категория у такого товара не закреплена, в разделе «Агрегация и цена» остаётся одно поле «Код ЕГАИС» — прежний способ хранить единственный код. После подтверждения категории поле уходит из формы, и готовность считается по списку «Коды АП ЕГАИС»; пока список пуст, учитывается сохранённое значение старого поля.",
          },
          {
            kind: "paragraph",
            text: "Внизу вкладки «Честный знак» есть раздел «Национальный каталог» со ссылкой «Открыть данные ЧЗ»: там видно, что прислал Честный знак, и предложения по обновлению карточки. Эта часть работы описана в отдельной инструкции по загрузке из Национального каталога.",
          },
        ],
      },
      {
        id: "image",
        heading: "7. Фотография",
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
            text: "Пока снимка нет, карточка показывает «Фотография не добавлена», а в списке в столбце «Фото» стоит прочерк. На статус карточки и на готовность фотография не влияет.",
          },
        ],
      },
      {
        id: "defaults",
        heading: "8. Значения по умолчанию",
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
        heading: "9. Вывод товара из оборота",
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
        heading: "10. Товары из внешних источников",
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
        heading: "11. Частые вопросы",
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
                term: "Товар активен, но коды заказать нельзя",
                detail:
                  "Статус карточки и готовность — разные проверки. Откройте вкладку «Честный знак» и прочитайте блок «Готовность»: чаще всего не подтверждена категория или не заполнены обязательные характеристики (разделы 5 и 6).",
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
                  "Карточка не связана с Национальным каталогом или сведения ещё не получены. Связь с карточкой Честного знака и готовность к операциям — разные вещи: товар может быть связан и не готов, а категорию для готовности можно выбрать и вручную. Связывание описано в инструкции по загрузке из Национального каталога.",
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
      "This is an informational translation. The matching Russian revision is authoritative. Manager's guide: adding a product to the catalog, completing its card so it reaches the active status, checking readiness per operation, confirming the National Catalog category and filling in its attributes, adding a photo, and retiring a product.",
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
              "The box capacity and the number of boxes per pallet decide what goes into a package during aggregation.",
              "“Print name” is the short name that goes on the label instead of a long full name.",
              "The National Catalog category and its attributes are needed not for a shift but for ordering codes and putting the product into circulation.",
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
            text: "The Chestny Znak product-group directory is maintained in Russian and the cabinet shows its names as received, so group names stay Russian on an English screen. National Catalog units of measure behave the same way. Everything else on these screens follows the interface language.",
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
            text: "In the cabinet side menu pick “Catalog” under “Reference data”. The table shows GTIN, photo, name, group, per-box capacity, the card status and Chestny Znak information; the “Actions” column holds “Edit” and “Delete”. The product name is a link: clicking it opens the card just as “Edit” does.",
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
                  "The product was retired by hand with the “Do not use” checkbox (section 9).",
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
            text: "Press “Add product”. The “New product” panel opens with four sections: “Basic”, “Aggregation and price”, “Product photo” and “Defaults”. The new-product form has no tabs: everything that concerns the National Catalog appears only on a saved card.",
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
            text: "A draft carries the banner “Draft — fill in the group and capacities to run shifts” at the top of the card. Pick “Product group” from the Chestny Znak directory and set “Box capacity, units” and “Boxes per pallet” as whole numbers above zero. The second field counts boxes rather than product units, which the cabinet repeats in the hint “A count of boxes, not of product units.”.",
            image: {
              id: "product-draft-banner",
              caption: "A draft: the group and the capacities are empty",
            },
          },
          {
            kind: "step",
            title: "Save the card",
            text: "Press “Save”. The remaining fields of “Aggregation and price” — “Price per unit, ₽”, “Shelf life, days”, and for the product group whose goods are tracked in EGAIS also “EGAIS code” (see section 6) — are optional and do not affect the status. A saved card gains two tabs above the fields, “Basic” and “Chestny ZNAK”: readiness, the category and the attributes live on the second one (sections 5 and 6).",
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
        id: "readiness",
        heading: "5. Readiness per operation",
        blocks: [
          {
            kind: "paragraph",
            text: "The card status and readiness are two different checks. The status — “Active” or “Draft” — answers only whether the product can be picked when planning a shift or during a stock count; it says nothing about National Catalog operations. Readiness is computed separately for each of four operations and against the saved card rather than against what is typed into an open form. So a product with the “Active” status can still be unready for ordering codes or for circulation.",
          },
          {
            kind: "step",
            title: "Open the “Chestny ZNAK” tab",
            text: "Open a product from the list. A saved card with write access carries two tabs above the fields: “Basic” for the product's own fields and “Chestny ZNAK” for everything tied to the National Catalog. Readiness, the category, the attributes and the EGAIS codes live on the second tab only; they are not below the basic fields. With read-only access the cabinet opens the card without tabs: the same blocks appear one after another on a single screen.",
          },
          {
            kind: "step",
            title: "Read the four dimensions",
            text: "The “Readiness” block shows four dimensions — “Production”, “Code ordering”, “Putting into circulation” and “EGAIS” — and the state of each: “Ready”, “Not ready”, “Update required” or “Not applicable”. Under a dimension the cabinet lists what is missing; the paler lines below are recommendations and do not block the operation. “Not applicable” means the operation does not concern this product group — that is how “EGAIS” is marked for a non-alcoholic product.",
            image: {
              id: "product-readiness",
              caption:
                "Readiness per operation: production and code ordering are ready, putting into circulation waits for an attribute",
            },
            expected:
              "It is visible which operation is already available and which waits for data.",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "The product group is not selected",
                detail:
                  "The line “Select a Chestny ZNAK product group.” — without a group “Production” is not ready, so no shift can run either.",
              },
              {
                term: "The box or pallet count is missing",
                detail:
                  "The lines “Enter the box capacity.” and “Enter the pallet capacity.” point at the fields of “Aggregation and price” on the “Basic” tab.",
              },
              {
                term: "The category is not confirmed",
                detail:
                  "The line “Confirm the National Catalog category.” — until a category is pinned, “Code ordering” and “Putting into circulation” stay “Not ready” (section 6).",
              },
              {
                term: "A newer category schema is available",
                detail:
                  "The line “A newer category schema is available. Review the category change and value transfer.” — the card is pinned to an outdated schema version, and the operation turns to “Update required” until you go through the category change.",
              },
              {
                term: "Category attributes are incomplete",
                detail:
                  "Lines such as “Complete: Composition.” list the mandatory category attributes; lines such as “Recommended: Package.” list the recommended ones, whose absence does not block the operation.",
              },
              {
                term: "EGAIS codes are missing",
                detail:
                  "The lines “Add an EGAIS AP code.” and “Select the primary EGAIS AP code.” appear only for the product group whose goods are tracked in EGAIS (section 6).",
              },
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "Readiness is computed from saved data. Until you press “Save”, edits typed into the form do not change it.",
          },
        ],
      },
      {
        id: "category",
        heading: "6. The category and its attributes",
        blocks: [
          {
            kind: "paragraph",
            text: "The Chestny Znak product group describes the kind of product coarsely; the National Catalog category refines it and brings the set of attributes Chestny Znak expects when codes are ordered and when the product is put into circulation. The category, the attributes and the EGAIS codes sit on the “Chestny ZNAK” tab and are saved separately from the basic product fields, each block with its own button.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "While the form holds unsaved edits to “GTIN” or “Product group”, the cabinet locks these blocks and shows the hint “Save the main product details before editing its category and attributes.”. The lock works the other way round too: while the category, the attributes or the EGAIS codes hold unsaved edits, the cabinet shows “Save or discard category and attribute edits first.”, the fields of the “Basic” tab stay locked and the card's “Save” button is unavailable. A button of its own per block does not make the blocks independent: an unfinished edit in one of them stops the work in another.",
          },
          {
            kind: "step",
            title: "Check the pinned category",
            text: "The “Category and classification” block shows which category the product is pinned to: “National Catalog category”, the “TN VED” and “OKPD2” codes, and “Source” — where the values came from. A card accepted from Chestny Znak names “National Catalog” as its source. The “Change category” button opens the change wizard.",
            image: {
              id: "product-category",
              caption: "Category and classification of a pinned card",
            },
          },
          {
            kind: "paragraph",
            text: "A card without a category carries a “Select category” button in the same place, and instead of the codes an explanation that the category can be taken from the Chestny Znak card or picked by hand. If no categories are configured for the product group yet, the cabinet says so in a separate message; the basic product fields can still be saved.",
          },
          {
            kind: "step",
            title: "Change the category through value transfer",
            text: "Press “Change category” — on an empty card, “Select category” — pick a category from the list and correct “TN VED” and “OKPD2” if needed. When the chosen category is not matched to the product group unambiguously, the cabinet asks you to confirm the choice with the “I confirm this category matches the selected Chestny ZNAK product group.” checkbox. The “Review changes” button applies nothing: it opens the “Review value transfer” screen.",
          },
          {
            kind: "unordered-list",
            items: [
              "“Compatible with the new category” — the value transfers as it is.",
              "“Will be converted to the new category format” — the value transfers with its format or unit converted.",
              "“Not applicable to the new category; kept in history” — the new schema has no such attribute.",
              "“Requires manual entry in the new category; current value kept in history” — the attribute exists, but the value does not transfer automatically.",
              "“EGAIS codes are preserved” — a category change does not touch the code list.",
            ],
          },
          {
            kind: "paragraph",
            text: "The checkboxes for “Compatible with the new category” and “Will be converted to the new category format” start ticked — clear the ones you do not want transferred. “Not applicable to the new category; kept in history” and “Requires manual entry in the new category; current value kept in history” have no checkbox at all: those values are not affected by the transfer. The cabinet states this in the line “Selected values will transfer to the new category. Others will remain in history and no longer count towards current readiness.”. The “Confirm category” button applies the change, and only then is readiness recomputed against the new schema.",
          },
          {
            kind: "step",
            title: "Fill in the category attributes",
            text: "The “Category attributes” block groups the fields by what they are needed for: the mandatory ones first, then the recommended and the additional ones. An empty picker reads “Not specified”. Some attributes carry a unit chosen next to the value; units come from the National Catalog registry and are not translated, so the volume unit still reads л on an English screen. Under a field the cabinet prints the value already accepted and its source — for example “National Catalog”. When the fields are filled in, press “Save attributes”.",
            image: {
              id: "product-attributes",
              caption: "Category attributes grouped by their requirement",
            },
            expected:
              "After the save the closed attributes disappear from the reasons in the readiness block.",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Required for code ordering",
                detail:
                  "Without such an attribute the “Code ordering” dimension stays “Not ready”.",
              },
              {
                term: "Required for circulation",
                detail:
                  "The same for “Putting into circulation”: codes can be ordered, but the product cannot enter circulation.",
              },
              {
                term: "Recommended",
                detail:
                  "The attribute goes into the pale list of recommendations under the dimension and does not block the operation.",
              },
              {
                term: "Additional",
                detail:
                  "The attribute does not affect readiness; fill it in when the value is known.",
              },
            ],
          },
          {
            kind: "step",
            title: "Add the EGAIS AP codes",
            text: "The cabinet shows the “EGAIS AP codes” block only for the product group whose goods are tracked in EGAIS, and only once a category is pinned; for the other groups the “EGAIS” dimension is marked “Not applicable”. The “Add EGAIS AP code” button adds a row: every code is nineteen digits and repeats are rejected. As soon as the list holds at least one code, the cabinet requires a “Primary EGAIS AP code” and will not save the list without one. The list is saved by “Save EGAIS codes”, separately from the attributes.",
          },
          {
            kind: "paragraph",
            text: "While such a product has no pinned category, “Aggregation and price” keeps a single “EGAIS code” field — the former way of storing one code. Once the category is confirmed the field leaves the form and readiness is computed from the “EGAIS AP codes” list; while that list is empty, the saved value of the old field is used.",
          },
          {
            kind: "paragraph",
            text: "At the bottom of the “Chestny ZNAK” tab there is a “National Catalog” section with an “Open Chestny ZNAK data” link: it shows what Chestny Znak sent and the proposed card updates. That part of the work is covered by the separate instruction on importing from the National Catalog.",
          },
        ],
      },
      {
        id: "image",
        heading: "7. Photo",
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
            text: "Until a picture is uploaded the card shows “No photo added” and the list prints a dash in the “Photo” column. A photo affects neither the card status nor readiness.",
          },
        ],
      },
      {
        id: "defaults",
        heading: "8. Default values",
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
        heading: "9. Retiring a product",
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
        heading: "10. Products from external sources",
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
        heading: "11. Common questions",
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
                term: "The product is active but codes cannot be ordered",
                detail:
                  "The card status and readiness are different checks. Open the “Chestny ZNAK” tab and read the “Readiness” block: most often the category is not confirmed or the mandatory attributes are incomplete (sections 5 and 6).",
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
                  "The card is not linked to the National Catalog, or the information has not arrived yet. The link to a Chestny Znak card and readiness are different things: a product can be linked and still unready, and a category can also be picked by hand. Linking is covered by the instruction on importing from the National Catalog.",
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
