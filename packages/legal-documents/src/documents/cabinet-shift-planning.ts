import type { LegalDocumentSource } from "../types.js";

export const CABINET_SHIFT_PLANNING_CONTENT = {
  ru: {
    locale: "ru",
    title: "Кабинет: линия, планирование и запуск смены",
    summary:
      "Инструкция менеджера по подготовке производственной смены: производственная линия, станции на линии, требования к продукту, планирование смены, режимы и агрегация, изменение и удаление запланированной смены.",
    sections: [
      {
        id: "purpose",
        heading: "1. Назначение",
        blocks: [
          {
            kind: "paragraph",
            text: "Инструкция описывает работу менеджера кабинета до начала выпуска: как завести производственную линию, назначить ей станции, проверить продукт в каталоге и запланировать смену. Открывает смену оператор на станции — это описано в инструкции MKR-INS-01. Ход смены, её закрытие и отчёты для ГИС МТ в этот документ не входят.",
          },
          {
            kind: "paragraph",
            text: "Смена проходит три состояния: «Запланирована» — задание готово, но выпуск не начат; «Активна» — смену открыли на станции и идёт выпуск; «Закрыта» — выпуск окончен. Всё, что описано ниже, менеджер делает в первом состоянии, до того как смену откроют.",
          },
          {
            kind: "ordered-list",
            items: [
              "Заведите производственную линию и назначьте ей станции.",
              "Убедитесь, что продукт есть в каталоге и доступен для выбора.",
              "Запланируйте смену: продукт, режим, объём, даты, линия и — для агрегации — шаблон этикетки и вместимости.",
              "Передайте станцию оператору: дальше он открывает смену сам.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "Снимки экранов сделаны на демонстрационных данных. Номера, количества и названия в вашем кабинете будут другими.",
          },
        ],
      },
      {
        id: "line",
        heading: "2. Производственная линия",
        blocks: [
          {
            kind: "paragraph",
            text: "Линия — это рабочее место в цехе. Кабинет объясняет её назначение так: производственная линия группирует смены и задаёт стационарному терминалу рабочее место по умолчанию. Без линии смену запланировать можно, но станция не получит рабочее место по умолчанию, а смены не будут сгруппированы.",
          },
          {
            kind: "step",
            title: "Создайте линию",
            text: "Откройте «Производственные линии» и нажмите «Создать линию». Единственное обязательное поле — «Название линии»; давайте имя так, как линию называют в цехе, чтобы оператор узнал её на станции.",
            image: { id: "line-form", caption: "Создание производственной линии" },
            expected: "Линия появилась в списке.",
          },
          {
            kind: "step",
            title: "Проверьте состояние линии",
            text: "В колонке «Состояние линии» кабинет показывает, как линия видна прямо сейчас: «Онлайн · 2 из 3 станций» — часть станций на связи; «Офлайн» — станции назначены, но ни одна не на связи; «Станции не назначены» — за линией не закреплено ни одной станции, и открыть на ней смену будет некому.",
            image: { id: "lines-list", caption: "Список линий и их состояние" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Удаление линии необратимо и срабатывает не всегда. Если линия уже используется, кабинет отказывает: «Линия используется в сменах или назначена одной или нескольким станциям. Снимите назначения и повторите удаление.» Сначала снимите линию со станций и убедитесь, что на неё не ссылаются смены.",
          },
          {
            kind: "step",
            title: "Не удаляйте линию, пока она используется",
            text: "Кнопка «Удалить» открывает подтверждение «Удалить линию?» с названием линии. Если линия занята, отказ появится прямо в этом окне — закройте его и снимите назначения.",
            image: { id: "line-delete-blocked", caption: "Отказ при удалении используемой линии" },
          },
          {
            kind: "paragraph",
            text: "Число линий ограничено подпиской. Если лимит исчерпан, кабинет сообщит об этом при создании — освободите неиспользуемую линию или увеличьте лимит.",
          },
        ],
      },
      {
        id: "stations",
        heading: "3. Станции на линии",
        blocks: [
          {
            kind: "paragraph",
            text: "Линия без станций бесполезна: открывать на ней смену будет негде. Станции закрепляются за линией в разделе «Устройства».",
          },
          {
            kind: "step",
            title: "Посмотрите, за какой линией закреплена станция",
            text: "В списке устройств линия показана в колонке «Место» — отдельной колонки «Линия» в списке нет. Здесь же видно тип устройства и его текущий статус.",
            image: { id: "device-list", caption: "Список устройств: линия в колонке «Место»" },
          },
          {
            kind: "step",
            title: "Назначьте линию станции",
            text: "Линия выбирается в карточке устройства полем «Линия»; значение по умолчанию — «Без линии». Кабинет поясняет выбор так: «Выбранная линия задаёт для станции рабочее место по умолчанию и группирует её смены.» Ссылка «Управлять линиями» ведёт в раздел линий, если нужной ещё нет.",
            image: { id: "device-line", caption: "Выбор линии в карточке устройства" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Добавление станции и выбор её линии требуют прав администратора кабинета. Менеджеру производства этот раздел доступен только на чтение: он видит колонку «Место», но не может изменить назначение. Снимок сделан под администратором — в кабинете менеджера боковое меню короче.",
          },
        ],
      },
      {
        id: "catalog",
        heading: "4. Что нужно от каталога",
        blocks: [
          {
            kind: "paragraph",
            text: "Смена планируется на продукт из каталога, и не любой продукт годится. В списке выбора кабинет показывает все продукты, но недоступные — подписывает и не даёт выбрать.",
          },
          {
            kind: "step",
            title: "Проверьте, что продукт доступен для выбора",
            text: "Раскройте «Выберите продукт». Продукт-черновик подписан «черновик — недоступно», продукт, помеченный как не используемый, — «не используется». Оба показаны бледным и не выбираются: сначала доведите продукт в каталоге до рабочего состояния или снимите отметку «Не использовать».",
            image: { id: "shift-product-options", caption: "Недоступные продукты в списке выбора" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "В инвентаризации правило другое: там продукт с отметкой «Не использовать» выбрать можно — пересчитывать остатки такого товара нужно. В смене его выбрать нельзя. Если вы работали с инвентаризацией, не переносите привычку сюда.",
          },
        ],
      },
      {
        id: "plan",
        heading: "5. Планирование смены",
        blocks: [
          {
            kind: "step",
            title: "Откройте раздел «Смены»",
            text: "В списке видно все задания и их состояние. Фильтры сверху отбирают смены по статусу и по двум периодам сразу — по дате смены и по дате производства, — поэтому смену, спланированную заранее, проще искать по производству. Под названием продукта кабинет показывает фактический выпуск: для агрегации — сколько единиц уложено и сколько коробов закрыто, для проверки — сколько кодов принято. Единственная кнопка в строке — «Подробнее»: она открывает панель смены, где собраны и её данные, и все действия над ней.",
            image: { id: "shifts-list", caption: "Список смен и фильтры" },
          },
          {
            kind: "step",
            title: "Откройте форму смены",
            text: "Нажмите «Запланировать смену» — откроется «Новая смена». Форма разбита на разделы «Продукт и режим», «Планирование», «Назначение производства», «Шаблоны» и — только для агрегации — «Агрегация». Если для смены включена печать дубликата, раздел «Шаблоны» заменяется разделом «Печать дубликата» (раздел 8).",
            image: { id: "shift-filled", caption: "Форма смены после выбора продукта" },
          },
          {
            kind: "paragraph",
            text: "Выбор продукта подставляет значения из его карточки: контрагента в «Для контрагента (толлинг)» и вместимости короба и паллеты. Это не ошибка и не случайность — так кабинет экономит ввод. Подставленные значения можно изменить: важно то, что сохранено в смене, а не то, что записано в продукте.",
          },
          {
            kind: "unordered-list",
            items: [
              "«Плановое количество, шт» — сколько единиц планируется выпустить. Целое положительное число.",
              "«Дата смены» — день, к которому относится задание.",
              "«Дата производства (для отчётов)» — дата, которая попадёт в этикетки и отчёты. Кабинет предупреждает: «Если не указана, этикетки и отчёты используют прежнее правило.»",
              "«Линия» — рабочее место, на котором пойдёт выпуск. По умолчанию «Не выбрана».",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "Две даты не дублируют друг друга. «Дата смены» — про планирование работы, «Дата производства (для отчётов)» — про то, что будет напечатано и сдано. Если производство идёт в ночь и формально относится к другому дню, укажите обе.",
          },
        ],
      },
      {
        id: "assignment",
        heading: "6. Толлинг и эмитент группового кода",
        blocks: [
          {
            kind: "paragraph",
            text: "В разделе «Назначение производства» два поля легко перепутать, и кабинет предупреждает об этом прямо на форме.",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Для кого выпускается товар",
                detail:
                  "Поле «Для контрагента (толлинг)». Подставляется из продукта, если у него задан контрагент по умолчанию; значение по умолчанию — «Не выбран».",
              },
              {
                term: "Чьи номера будут на коробах",
                detail:
                  "Поле «Эмитент группового кода», по умолчанию «Наша организация». Подсказка формы: «Определяет, чьи номера будут на коробах — это не то же самое, что контрагент, для которого предназначен товар.»",
              },
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Ошибка в эмитенте видна не сразу: смена спланируется, выпуск пойдёт, а неверные номера окажутся уже на напечатанных этикетках коробов. Сверяйте это поле до того, как смену откроют на станции.",
          },
        ],
      },
      {
        id: "aggregation",
        heading: "7. Режим и агрегация",
        blocks: [
          {
            kind: "paragraph",
            text: "Режим задаётся полем «Режим» и определяет, что делает оператор на станции. «Валидация» — коды только проверяются. «Агрегация» — коды дополнительно укладываются в короба, а короба получают этикетки. Новая форма открывается в режиме «Валидация».",
          },
          {
            kind: "step",
            title: "Заполните параметры агрегации",
            text: "Выберите «Агрегация» — в форме появится одноимённый раздел. «Вместимость короба, шт» подставляется из продукта. Отметка «Использовать паллеты» добавляет поле «Вместимость паллеты, шт»: пока отметка снята, этого поля нет. В разделе «Шаблоны» выберите «Шаблон этикетки короба» — для агрегации он обязателен, и без него смена не сохранится.",
            image: { id: "shift-aggregation", caption: "Разделы «Шаблоны» и «Агрегация»" },
            expected: "Раздел «Агрегация» показан, вместимость короба заполнена.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Раздела «Агрегация» нет, пока выбран режим «Валидация», — это не сбой отображения. Если вы не находите вместимости коробов, проверьте сначала режим.",
          },
          {
            kind: "step",
            title: "Сохраните задание",
            text: "Нажмите «Запланировать». Смена появится в списке со статусом «Запланирована». Действий в самой строке нет: откройте «Подробнее» — в панели, в разделе «Действия со сменой», лежат «Изменить» и «Удалить». У активной смены там же вместо удаления появляется «Закрыть смену» — это уже следующий этап работы.",
            image: { id: "shift-planned", caption: "Смена запланирована" },
            expected: "В списке появилась строка со статусом «Запланирована».",
          },
        ],
      },
      {
        id: "duplicate",
        heading: "8. Печать дубликата Data Matrix",
        blocks: [
          {
            kind: "paragraph",
            text: "Иногда код маркировки на самой продукции недоступен для сканирования дальше по цепочке — например, он оказывается под этикеткой или на дне. Тогда смену в режиме «Валидация» переводят в печать дубликата: станция печатает этикетку с тем же кодом, и её наклеивают на внешнюю упаковку.",
          },
          {
            kind: "step",
            title: "Включите дубликат в форме смены",
            text: "В разделе «Продукт и режим» выберите «Валидация» — под режимом появится переключатель «Печать этикетки» с вариантами «Без печати» и «Дублировать Data Matrix». Вторая опция доступна не всегда: если оборудование или протокол смены её не поддерживают, она остаётся заблокированной.",
            image: {
              id: "shift-duplicate-print",
              caption: "Смена с включённой печатью дубликата",
            },
          },
          {
            kind: "step",
            title: "Выберите шаблон и режим проверки",
            text: "Включённый дубликат заменяет раздел «Шаблоны» на «Печать дубликата». Выберите «Шаблон этикетки продукции» — в списке видны размеры и разрешение каждого шаблона. Отметка «Обязательная проверка этикетки» требует от оператора отсканировать напечатанную этикетку: «Оператор должен отсканировать новую этикетку перед следующей единицей.» Без отметки станция позволяет продолжать сразу после отправки на принтер.",
            expected: "В разделе выбран шаблон, режим проверки задан.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "Дубликат не меняет учёт: «На внешнюю упаковку переносится полный код с продукции. Количество продукции не меняется.» Если для продукта нет подходящего шаблона, кабинет об этом скажет — добавьте или включите шаблон в разделе «Этикетки».",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Параметры печати фиксируются в момент открытия смены: у активной смены кабинет прямо пишет, что шаблон и проверка зафиксированы при открытии. Менять их на ходу нельзя — планируйте печать дубликата до запуска.",
          },
        ],
      },
      {
        id: "after",
        heading: "9. Изменение и удаление",
        blocks: [
          {
            kind: "paragraph",
            text: "Пока смена запланирована, её можно менять свободно и удалить целиком. Как только смену открыли на станции, правила меняются.",
          },
          {
            kind: "step",
            title: "Изменение активной смены ограничено",
            text: "В открытой смене форма называется «Изменить смену» и показывает номер смены. Продукт, режим, линия, контрагент, эмитент, шаблон и вместимости заблокированы — изменить можно только плановое количество и даты.",
            image: {
              id: "shift-active-locked",
              caption: "Активная смена: большинство полей заблокировано",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Любое сохранение изменений активной смены кабинет считает критическим и переспрашивает: «Изменения затрагивают работающие станции. Чтобы применить их, завершите работу со сменой, выйдите из неё и войдите повторно на всех работающих с ней станциях. До повторного входа станции продолжат использовать прежние настройки.» Пока операторы не перезайдут в смену, станции работают по старым параметрам — предупредите линию заранее.",
          },
          {
            kind: "step",
            title: "Подтвердите критическое изменение",
            text: "В окне «Критическое изменение активной смены» выберите «Сохранить изменения», если готовы просить линию перезайти, или «Продолжить редактирование», чтобы вернуться к форме.",
            image: { id: "shift-active-edit", caption: "Подтверждение критического изменения" },
          },
          {
            kind: "step",
            title: "Удаление доступно только до запуска",
            text: "Откройте смену кнопкой «Подробнее» и в разделе «Действия со сменой» нажмите «Удалить» — кабинет спросит «Удалить смену?» и покажет продукт. Восстановить удалённую смену нельзя. У активной смены этой кнопки нет, а у закрытой раздела «Действия со сменой» нет вовсе.",
            image: { id: "shift-delete", caption: "Подтверждение удаления смены" },
          },
        ],
      },
      {
        id: "faq",
        heading: "10. Частые вопросы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Продукт не выбирается",
                detail:
                  "Он либо черновик — подпись «черновик — недоступно», — либо помечен как не используемый: подпись «не используется». Доведите карточку продукта в каталоге до рабочего состояния или снимите отметку «Не использовать».",
              },
              {
                term: "Не вижу вместимости коробов и паллет",
                detail:
                  "Раздел «Агрегация» показывается только в режиме «Агрегация». Поле «Вместимость паллеты, шт» появляется после отметки «Использовать паллеты».",
              },
              {
                term: "Смена не сохраняется в режиме агрегации",
                detail:
                  "Для агрегации обязателен «Шаблон этикетки короба». Выберите шаблон в разделе «Шаблоны» — либо конкретный, либо настройку организации.",
              },
              {
                term: "Контрагент подставился сам",
                detail:
                  "Он взят из карточки выбранного продукта. Значение можно изменить прямо в форме: в смене сохранится то, что вы оставили здесь.",
              },
              {
                term: "Линия не удаляется",
                detail:
                  "Она используется в сменах или назначена станциям. Снимите линию со станций в разделе «Устройства» и повторите удаление.",
              },
              {
                term: "Не могу назначить линию станции",
                detail:
                  "Раздел устройств доступен менеджеру только на чтение. Назначение линии выполняет администратор кабинета.",
              },
              {
                term: "Изменил активную смену, а станция работает по-старому",
                detail:
                  "Так и задумано: станция подхватит новые параметры только после выхода из смены и повторного входа. До этого она использует прежние настройки.",
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
    title: "Cabinet: the line, planning and starting a shift",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. Manager's guide to preparing a production shift: the production line, stations on the line, product requirements, shift planning, modes and aggregation, editing and deleting a planned shift.",
    sections: [
      {
        id: "purpose",
        heading: "1. Purpose",
        blocks: [
          {
            kind: "paragraph",
            text: "This instruction covers what a cabinet manager does before production starts: how to create a production line, assign stations to it, check the product in the catalog and plan a shift. The shift itself is opened by the operator at the station — that is covered by instruction MKR-INS-01. Running the shift, closing it and the GIS MT reports are outside this document.",
          },
          {
            kind: "paragraph",
            text: "A shift goes through three states: “Planned” — the task is ready but production has not started; “Active” — the shift was opened at a station and production is running; “Closed” — production is over. Everything described below is done by the manager in the first state, before the shift is opened.",
          },
          {
            kind: "ordered-list",
            items: [
              "Create a production line and assign stations to it.",
              "Make sure the product exists in the catalog and can be selected.",
              "Plan the shift: product, mode, quantity, dates, line and — for aggregation — the label template and the capacities.",
              "Hand the station over to the operator: opening the shift is their job.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "The screenshots use demo data. Numbers, quantities and names in your cabinet will differ.",
          },
        ],
      },
      {
        id: "line",
        heading: "2. The production line",
        blocks: [
          {
            kind: "paragraph",
            text: "A line is a workplace on the shop floor. The cabinet states its purpose like this: “A production line groups shifts and sets a stationary terminal's default workplace.” Without a line you can still plan a shift, but the station will not get a default workplace and the shifts will not be grouped.",
          },
          {
            kind: "step",
            title: "Create the line",
            text: "Open “Production lines” and press “Create line”. The only required field is “Line name”; give the line the name the shop floor uses, so that the operator recognizes it at the station.",
            image: { id: "line-form", caption: "Creating a production line" },
            expected: "The line appeared in the list.",
          },
          {
            kind: "step",
            title: "Check the line status",
            text: "The “Line status” column shows how the line looks right now: “Online · 2 of 3 stations” — some of its stations are connected; “Offline” — stations are assigned but none of them is connected; “No stations assigned” — no station is attached to the line, so there will be nobody to open a shift on it.",
            image: { id: "lines-list", caption: "The list of lines and their status" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Deleting a line is irreversible, and it does not always go through. If the line is already in use, the cabinet refuses: “This line is used by shifts or assigned to one or more stations. Remove those references and try again.” Detach the line from the stations first and make sure no shift refers to it.",
          },
          {
            kind: "step",
            title: "Do not delete a line while it is in use",
            text: "The “Delete” button opens the “Delete line?” confirmation with the line name. If the line is busy, the refusal appears right in that dialog — close it and remove the assignments.",
            image: {
              id: "line-delete-blocked",
              caption: "The refusal when deleting a line that is in use",
            },
          },
          {
            kind: "paragraph",
            text: "The number of lines is capped by the subscription. If the limit is used up, the cabinet says so when you create a line — free up an unused line or raise the limit.",
          },
        ],
      },
      {
        id: "stations",
        heading: "3. Stations on the line",
        blocks: [
          {
            kind: "paragraph",
            text: "A line with no stations is useless: there will be nowhere to open a shift on it. Stations are attached to a line in the “Devices” section.",
          },
          {
            kind: "step",
            title: "See which line a station belongs to",
            text: "In the device list the line is shown in the “Place” column — there is no separate “Line” column in the list. The same row shows the device type and its current status.",
            image: {
              id: "device-list",
              caption: "The device list: the line in the “Place” column",
            },
          },
          {
            kind: "step",
            title: "Assign a line to a station",
            text: "The line is picked in the device card with the “Line” field; the default value is “No line”. The cabinet explains the choice like this: “The selected line becomes the station's default workplace and groups its shifts.” The “Manage lines” link leads to the lines section if the line you need does not exist yet.",
            image: { id: "device-line", caption: "Choosing the line in the device card" },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "Adding a station and choosing its line require cabinet administrator rights. For a production manager this section is read-only: they see the “Place” column but cannot change the assignment. The screenshot was taken as an administrator — in a manager's cabinet the side menu is shorter.",
          },
        ],
      },
      {
        id: "catalog",
        heading: "4. What the catalog has to provide",
        blocks: [
          {
            kind: "paragraph",
            text: "A shift is planned against a product from the catalog, and not every product will do. The picker lists every product, but the unavailable ones are labeled and cannot be chosen.",
          },
          {
            kind: "step",
            title: "Check that the product can be selected",
            text: "Open “Select a product”. A draft product is labeled “draft -- unavailable”, and a product marked as not in use is labeled “not in use”. Both are shown dimmed and cannot be picked: first bring the product in the catalog to a working state, or clear the “Do not use” checkbox on its card.",
            image: { id: "shift-product-options", caption: "Unavailable products in the picker" },
          },
          {
            kind: "callout",
            tone: "info",
            text: "The rule is different in an inventory: there a product marked “Do not use” can be selected — the stock of such a product still has to be counted. In a shift it cannot be selected. If you have worked with inventories, do not carry that habit over.",
          },
        ],
      },
      {
        id: "plan",
        heading: "5. Planning a shift",
        blocks: [
          {
            kind: "step",
            title: "Open the “Shifts” section",
            text: "The list shows every task and its state. The filters at the top select shifts by status and by two periods at once — by shift date and by production date — so a shift planned in advance is easier to find by production. Under the product name the cabinet shows the actual output: for aggregation, how many units were packed and how many boxes were closed; for validation, how many codes were accepted. The only button in the row is “Details”: it opens the shift panel, which holds both the shift data and every action on it.",
            image: { id: "shifts-list", caption: "The shift list and its filters" },
          },
          {
            kind: "step",
            title: "Open the shift form",
            text: "Press “Plan a shift” — “New shift” opens. The form is split into the “Product and mode”, “Planning”, “Production assignment” and “Templates” sections and — for aggregation only — “Aggregation”. If duplicate printing is enabled for the shift, the “Templates” section is replaced by “Duplicate printing” (section 8).",
            image: { id: "shift-filled", caption: "The shift form after a product is chosen" },
          },
          {
            kind: "paragraph",
            text: "Choosing a product fills in values from its card: the counterparty in “For counterparty (tolling)” and the box and pallet capacities. This is neither a bug nor an accident — it is how the cabinet saves you typing. The prefilled values can be changed: what counts is what is saved in the shift, not what is written on the product.",
          },
          {
            kind: "unordered-list",
            items: [
              "“Planned quantity, units” — how many units are planned. A positive whole number.",
              "“Shift date” — the day the task belongs to.",
              "“Production date (for reports)” — the date that goes onto the labels and into the reports. The cabinet warns: “If omitted, labels and reports keep the previous date rule.”",
              "“Line” — the workplace where production will run. “None selected” by default.",
            ],
          },
          {
            kind: "callout",
            tone: "info",
            text: "The two dates do not duplicate each other. “Shift date” is about planning the work; “Production date (for reports)” is about what gets printed and filed. If production runs overnight and formally belongs to another day, fill in both.",
          },
        ],
      },
      {
        id: "assignment",
        heading: "6. Tolling and the SSCC issuer",
        blocks: [
          {
            kind: "paragraph",
            text: "Two fields in the “Production assignment” section are easy to mix up, and the cabinet warns about it right on the form.",
          },
          {
            kind: "definition-list",
            items: [
              {
                term: "Who the goods are produced for",
                detail:
                  "The “For counterparty (tolling)” field. It is filled in from the product if the product has a default counterparty; the default value is “None selected”.",
              },
              {
                term: "Whose numbers go on the boxes",
                detail:
                  "The “SSCC issuer” field, “Our organization” by default. The hint on the form: “Decides whose numbers appear on the boxes -- not the same question as which counterparty the goods are for.”",
              },
            ],
          },
          {
            kind: "callout",
            tone: "warning",
            text: "A mistake in the issuer does not show up at once: the shift is planned, production runs, and the wrong numbers are already on the printed box labels. Check this field before the shift is opened at the station.",
          },
        ],
      },
      {
        id: "aggregation",
        heading: "7. Mode and aggregation",
        blocks: [
          {
            kind: "paragraph",
            text: "The mode is set by the “Mode” field and decides what the operator does at the station. “Validation” — the codes are only checked. “Aggregation” — the codes are additionally packed into boxes, and the boxes get labels. A new form opens in “Validation” mode.",
          },
          {
            kind: "step",
            title: "Fill in the aggregation parameters",
            text: "Choose “Aggregation” — a section with the same name appears in the form. “Box capacity, units” is filled in from the product. The “Use pallets” checkbox adds the “Pallet capacity, units” field: while the checkbox is clear, that field is not there. In the “Templates” section choose the “Box label template” — aggregation requires it, and the shift will not save without it.",
            image: {
              id: "shift-aggregation",
              caption: "The “Templates” and “Aggregation” sections",
            },
            expected: "The “Aggregation” section is shown and the box capacity is filled in.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "There is no “Aggregation” section while “Validation” is selected — that is not a display glitch. If you cannot find the box capacity, check the mode first.",
          },
          {
            kind: "step",
            title: "Save the task",
            text: "Press “Plan”. The shift appears in the list with the “Planned” status. There are no actions in the row itself: open “Details” — the “Shift actions” section of the panel holds “Edit” and “Delete”. For an active shift, “Close shift” takes the place of deletion there — but that is already the next stage of the work.",
            image: { id: "shift-planned", caption: "The shift is planned" },
            expected: "A row with the “Planned” status appeared in the list.",
          },
        ],
      },
      {
        id: "duplicate",
        heading: "8. Printing a Data Matrix duplicate",
        blocks: [
          {
            kind: "paragraph",
            text: "Sometimes the marking code on the product itself cannot be scanned further down the chain — it ends up under a label or on the bottom, for example. A shift in “Validation” mode is then switched to duplicate printing: the station prints a label with the same code, and that label goes onto the outer packaging.",
          },
          {
            kind: "step",
            title: "Turn the duplicate on in the shift form",
            text: "In the “Product and mode” section choose “Validation” — a “Label printing” switch appears under the mode with the “No printing” and “Duplicate Data Matrix” options. The second option is not always available: if the equipment or the shift protocol does not support it, it stays disabled.",
            image: {
              id: "shift-duplicate-print",
              caption: "A shift with duplicate printing turned on",
            },
          },
          {
            kind: "step",
            title: "Choose the template and the verification mode",
            text: "Turning the duplicate on replaces the “Templates” section with “Duplicate printing”. Choose the “Product label template” — the list shows the size and the resolution of every template. The “Require label verification” checkbox makes the operator scan the printed label: “The operator must scan the new label before accepting the next unit.” Without the checkbox the station lets them continue as soon as the label is sent to the printer.",
            expected: "A template is chosen in the section and the verification mode is set.",
          },
          {
            kind: "callout",
            tone: "info",
            text: "The duplicate does not change the records: “The full product code is copied to the outer packaging. The product quantity stays the same.” If there is no suitable template for the product, the cabinet says so — add or enable a template in the “Labels” section.",
          },
          {
            kind: "callout",
            tone: "warning",
            text: "The printing parameters are frozen the moment the shift is opened: for an active shift the cabinet states plainly that the template and the verification were frozen when the shift opened. They cannot be changed on the fly — plan duplicate printing before the start.",
          },
        ],
      },
      {
        id: "after",
        heading: "9. Editing and deleting",
        blocks: [
          {
            kind: "paragraph",
            text: "While the shift is planned it can be changed freely and deleted outright. As soon as the shift is opened at a station, the rules change.",
          },
          {
            kind: "step",
            title: "Editing an active shift is limited",
            text: "In an open shift the form is called “Edit shift” and shows the shift number. The product, the mode, the line, the counterparty, the issuer, the template and the capacities are locked — only the planned quantity and the dates can be changed.",
            image: {
              id: "shift-active-locked",
              caption: "An active shift: most of the fields are locked",
            },
          },
          {
            kind: "callout",
            tone: "warning",
            text: "The cabinet treats any save of an active shift as critical and asks again: “These changes affect working stations. To apply them, finish work in the shift, leave it, and re-enter it on every station using it. Until then, stations will keep using the previous settings.” Until the operators re-enter the shift, the stations run on the old parameters — warn the line in advance.",
          },
          {
            kind: "step",
            title: "Confirm the critical change",
            text: "In the “Critical active shift change” dialog choose “Save changes” if you are ready to ask the line to re-enter, or “Continue editing” to go back to the form.",
            image: { id: "shift-active-edit", caption: "Confirming a critical change" },
          },
          {
            kind: "step",
            title: "Deleting is only possible before the start",
            text: "Open the shift with the “Details” button and press “Delete” in the “Shift actions” section — the cabinet asks “Delete shift?” and shows the product. A deleted shift cannot be restored. An active shift has no such button, and a closed one has no “Shift actions” section at all.",
            image: { id: "shift-delete", caption: "Confirming the deletion of a shift" },
          },
        ],
      },
      {
        id: "faq",
        heading: "10. Common questions",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "The product cannot be selected",
                detail:
                  "It is either a draft — the “draft -- unavailable” label — or marked as not in use: the “not in use” label. Bring the product card in the catalog to a working state, or clear the “Do not use” checkbox.",
              },
              {
                term: "I cannot find the box and pallet capacities",
                detail:
                  "The “Aggregation” section is only shown in “Aggregation” mode. The “Pallet capacity, units” field appears once the “Use pallets” checkbox is set.",
              },
              {
                term: "The shift will not save in aggregation mode",
                detail:
                  "Aggregation requires a “Box label template”. Choose a template in the “Templates” section — either a specific one or the organization setting.",
              },
              {
                term: "The counterparty filled itself in",
                detail:
                  "It was taken from the card of the product you chose. The value can be changed right in the form: the shift saves what you leave here.",
              },
              {
                term: "The line will not delete",
                detail:
                  "It is used by shifts or assigned to stations. Detach the line from the stations in the “Devices” section and try deleting again.",
              },
              {
                term: "I cannot assign a line to a station",
                detail:
                  "The devices section is read-only for a manager. A cabinet administrator assigns the line.",
              },
              {
                term: "I edited an active shift but the station still runs the old way",
                detail:
                  "That is by design: the station picks up the new parameters only after leaving the shift and entering it again. Until then it uses the previous settings.",
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
