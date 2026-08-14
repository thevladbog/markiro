import type { Locale } from "./pages";

const RU = {
  common: {
    breadcrumbsLabel: "Хлебные крошки",
    discussTask: "Обсудить задачу",
    footerLabel: "Ссылки в подвале",
    homeLabel: "Markiro, на главную страницу",
    menuClose: "Закрыть меню",
    menuOpen: "Открыть меню",
    nav: {
      aggregation: "Агрегация",
      faq: "Вопросы",
      offline: "Офлайн",
      serialization: "Маркировка",
    },
    navigationLabel: "Основная навигация",
    relatedHeading: "Связанные производственные сценарии",
    relatedKicker: "Следующий шаг",
    requestDemo: "Запросить демонстрацию",
    requestDemoShort: "Запросить демо",
    seoCtaHeading: "Проверим сценарий на данных вашей линии.",
    seoCtaKicker: "Демонстрация на вашем процессе",
    skipLink: "Перейти к содержанию",
  },
  home: {
    continuity: {
      heading: ["Сеть может исчезнуть.", "Производство не должно."],
      kicker: "01 / НЕПРЕРЫВНОСТЬ",
      lead: "Станция работает локально и синхронизирует операции, когда соединение возвращается.",
      points: [
        ["Проверка на месте", "Коды проходят проверку на станции без ожидания ответа сервера."],
        [
          "Операции сохраняются",
          "Каждое действие остаётся в локальном журнале до уверенной отправки.",
        ],
        ["Линия продолжает работу", "Оператор видит состояние и может восстановиться после сбоя."],
      ],
    },
    cycle: {
      heading: ["КОД ПРОШЁЛ.", "КОРОБ СОБРАН."],
      kicker: "02 / ПРОИЗВОДСТВЕННЫЙ ЦИКЛ",
      lead: "Оператор видит понятный текущий шаг. Система сохраняет связь между кодом, группой и этикеткой.",
      stages: [
        ["Проверка кода", "Система сверяет код и не пропускает проблемный."],
        ["Сборка группы", "Товар собирается в короб и паллету с сохранением родительства."],
        ["Этикетка и печать", "Макет строится из тех же данных, которые прошли проверку."],
      ],
    },
    demo: {
      company: "Компания",
      contactNote: "Контактный телефон появится после подключения публичной линии.",
      heading: "Покажем Markiro на вашей линии.",
      kicker: "07 / ДЕМО НА ВАШЕЙ ЛИНИИ",
      lead: "Разберём ваш процесс и покажем рабочий сценарий без абстрактной презентации.",
      legal: {
        consent: "согласие на обработку персональных данных",
        prefix: "Отправляя форму, вы принимаете",
        privacy: "политикой обработки данных",
        separator: "и подтверждаете, что ознакомились с",
      },
      name: "Как к вам обращаться",
      phone: "Телефон для связи",
      unavailable:
        "Онлайн-отправка будет доступна после подключения CRM и утверждения документов об обработке данных.",
    },
    hero: {
      heading: ["Линия идёт.", "Маркировка под контролем."],
      kicker: "МАРКИРОВКА / АГРЕГАЦИЯ / ПРОСЛЕЖИВАЕМОСТЬ",
      lead: "Проверяем коды, собираем короба и печатаем этикетки даже без интернета. Инженер поймёт процесс, работа продолжится.",
      note: "ДЛЯ ЛИНИЙ, КОТОРЫЕ НЕЛЬЗЯ ОСТАНАВЛИВАТЬ",
    },
    implementation: {
      heading: "Запускаем без большого проекта.",
      kicker: "06 / ВНЕДРЕНИЕ",
      lead: "Начните с одной станции и реального рабочего сценария. Масштабирование идёт после проверки процесса на линии.",
      link: "Обсудить первую линию",
      steps: [
        ["Разбираем линию", "Фиксируем оборудование, роли и текущий маршрут кодов."],
        ["Настраиваем сценарий", "Собираем рабочий процесс под конкретный продукт и упаковку."],
        [
          "Проверяем на смене",
          "Запускаем вместе с оператором и проверяем восстановление после ошибок.",
        ],
        ["Расширяем контур", "Добавляем кабинеты, киоски и интеграции по готовности."],
      ],
    },
    lineConsole: {
      accepted: "Код принят",
      assembly: "СБОРКА",
      caseAssembly: "Сборка короба",
      codes: "КОДОВ МАРКИРОВКИ",
      lineActive: "ЛИНИЯ АКТИВНА",
      station: "СТАНЦИЯ 03 / АГРЕГАЦИЯ",
      shiftAccepted: "ПРИНЯТО ЗА СМЕНУ",
      timeValue: "52,40",
      timeUnit: "сек",
    },
    platform: {
      heading: ["Одна линия сегодня.", "Платформа завтра."],
      kicker: "05 / ПЛАТФОРМА",
      lead: "Подключайте новые контуры по готовности, не заменяя уже работающий процесс.",
      modules: [
        [
          "Кабинет производства",
          "Задания, шаблоны этикеток, история операций и управление площадкой.",
        ],
        ["Киоск выдачи", "Самообслуживание со сканером и восстановлением после разрыва связи."],
        ["1С и API", "Обмен заданиями и статусами без ручного переноса данных."],
      ],
    },
    product: {
      codeAccepted: "КОД ПРИНЯТ",
      codeCheck: "ПРОВЕРКА КОДА",
      firstDescription: "Оператор видит, прошёл продукт проверку или требует отдельного решения.",
      firstHeading: "Код проверяется сразу после сканирования",
      heading: ["Не очередной кабинет.", "Инструмент для линии."],
      kicker: "03 / ДВА РЕЖИМА",
      labelsReady: ["ЭТИКЕТКИ", "ГОТОВЫ"],
      lead: "Каждый экран отвечает на один вопрос оператора и не прячет состояние за таблицами.",
      productFound: "Продукт найден",
      productName: "Молоко отборное в короб",
      productNumber: "ПРОДУКТ 404123",
      secondDescription:
        "Предпросмотр и печать используют один макет. Оператор не сверяет поля на глаз.",
      secondHeading: "Этикетка строится из проверенных данных",
      verified: "ПРОВЕРЕНО",
    },
    trace: {
      benefits: ["Точное место сбоя", "История действий", "Понятный следующий шаг"],
      events: [
        ["14:21:03", "Код принят", "Марка связана с товаром", "ok"],
        ["14:21:08", "Короб закрыт", "24 единицы в группе", "ok"],
        ["14:21:12", "Этикетка отправлена на печать", "Принтер линии 02", "ok"],
        ["14:21:18", "Печать не подтвердилась", "Нужно действие оператора", "problem"],
      ],
      heading: ["Ошибка не исчезает.", "Она получает понятный маршрут."],
      kicker: "04 / ПРОСЛЕЖИВАЕМОСТЬ",
      lead: "Каждое действие остаётся в истории. Проблемную операцию можно понять, повторить или передать ответственному.",
      panelLabel: "Пример журнала событий",
      station: "СТАНЦИЯ 03",
      toolbar: "ИСТОРИЯ КОРОБА 24",
    },
  },
} as const;

const EN = {
  common: {
    breadcrumbsLabel: "Breadcrumbs",
    discussTask: "Discuss your workflow",
    footerLabel: "Footer links",
    homeLabel: "Markiro home page",
    menuClose: "Close menu",
    menuOpen: "Open menu",
    nav: {
      aggregation: "Aggregation",
      faq: "Questions",
      offline: "Offline",
      serialization: "Serialization",
    },
    navigationLabel: "Primary navigation",
    relatedHeading: "Related production workflows",
    relatedKicker: "Next step",
    requestDemo: "Request a demonstration",
    requestDemoShort: "Request a demo",
    seoCtaHeading: "Test the workflow with data from your line.",
    seoCtaKicker: "A demonstration using your process",
    skipLink: "Skip to content",
  },
  home: {
    continuity: {
      heading: ["The network may disappear.", "Production must not."],
      kicker: "01 / CONTINUITY",
      lead: "The station operates locally and synchronizes its operations when connectivity returns.",
      points: [
        [
          "Validate on the spot",
          "Codes are validated at the station without waiting for a server response.",
        ],
        [
          "Keep every operation",
          "Each action remains in the local journal until delivery is confirmed.",
        ],
        [
          "Keep the line moving",
          "Operators see the current state and can recover after a failure.",
        ],
      ],
    },
    cycle: {
      heading: ["CODE VERIFIED.", "CASE COMPLETE."],
      kicker: "02 / PRODUCTION CYCLE",
      lead: "The operator sees one clear current step. The system retains the relationship between the code, group, and label.",
      stages: [
        [
          "Code verification",
          "The system validates the code and stops invalid data at the operation boundary.",
        ],
        [
          "Pack aggregation",
          "Products become cases and pallets without losing their parent-child relationships.",
        ],
        ["Label and print", "The layout uses the same data that passed validation."],
      ],
    },
    demo: {
      company: "Company",
      contactNote: "A contact number will appear when the public phone line is connected.",
      heading: "See Markiro on your production line.",
      kicker: "07 / DEMO ON YOUR LINE",
      lead: "We will examine your process and demonstrate a working scenario instead of an abstract presentation.",
      legal: {
        consent: "personal-data processing consent",
        prefix: "By submitting this form, you accept the",
        privacy: "data processing policy",
        separator: "and confirm that you have read the",
      },
      name: "Your name",
      phone: "Contact phone",
      unavailable:
        "Online submission will be available after the CRM connection and data-processing documents are approved.",
    },
    hero: {
      heading: ["Keep the line moving.", "Keep serialization under control."],
      kicker: "SERIALIZATION / AGGREGATION / TRACEABILITY",
      lead: "Verify codes, aggregate cases, and print labels even without the internet. Engineers retain control and production continues.",
      note: "FOR LINES THAT CANNOT AFFORD TO STOP",
    },
    implementation: {
      heading: "Start without a large transformation project.",
      kicker: "06 / IMPLEMENTATION",
      lead: "Begin with one station and a real operating workflow. Scale only after validating the process on the line.",
      link: "Discuss the first line",
      steps: [
        [
          "Understand the line",
          "Document the equipment, roles, and current route of serialized codes.",
        ],
        [
          "Configure the workflow",
          "Build the operating process around the actual product and packaging.",
        ],
        ["Validate during a shift", "Launch with an operator and test recovery from real errors."],
        [
          "Extend the production layer",
          "Add office tools, kiosks, and integrations when the process is ready.",
        ],
      ],
    },
    lineConsole: {
      accepted: "Code accepted",
      assembly: "PACKING",
      caseAssembly: "Case assembly",
      codes: "SERIALIZED CODES",
      lineActive: "LINE ACTIVE",
      station: "STATION 03 / AGGREGATION",
      shiftAccepted: "ACCEPTED THIS SHIFT",
      timeValue: "52.40",
      timeUnit: "sec",
    },
    platform: {
      heading: ["One line today.", "A platform tomorrow."],
      kicker: "05 / PLATFORM",
      lead: "Connect new production areas when they are ready without replacing an already working process.",
      modules: [
        ["Production office", "Orders, label templates, operation history, and site management."],
        ["Pickup kiosk", "Scanner-led self-service with recovery after a lost connection."],
        ["1C and API", "Exchange orders and statuses without transferring data manually."],
      ],
    },
    product: {
      codeAccepted: "CODE ACCEPTED",
      codeCheck: "CODE VERIFICATION",
      firstDescription:
        "The operator immediately sees whether the product passed validation or needs a separate decision.",
      firstHeading: "Validate the code immediately after scanning",
      heading: ["Not another back office.", "A tool for the line."],
      kicker: "03 / TWO OPERATING MODES",
      labelsReady: ["LABELS", "READY"],
      lead: "Each screen answers one operator question and never hides the current state behind tables.",
      productFound: "Product found",
      productName: "Premium milk into case",
      productNumber: "PRODUCT 404123",
      secondDescription:
        "Preview and print use one layout. The operator never has to compare fields by eye.",
      secondHeading: "Build labels from verified data",
      verified: "VERIFIED",
    },
    trace: {
      benefits: ["Exact failure location", "Complete action history", "A clear next step"],
      events: [
        ["14:21:03", "Code accepted", "Serialized code linked to product", "ok"],
        ["14:21:08", "Case closed", "24 items in the group", "ok"],
        ["14:21:12", "Label sent to print", "Line printer 02", "ok"],
        ["14:21:18", "Print not confirmed", "Operator action required", "problem"],
      ],
      heading: ["An error does not disappear.", "It gets a clear recovery path."],
      kicker: "04 / TRACEABILITY",
      lead: "Every action stays in the history. A failed operation can be understood, retried safely, or assigned to the right person.",
      panelLabel: "Example event log",
      station: "STATION 03",
      toolbar: "CASE 24 HISTORY",
    },
  },
} as const;

export function getUiCopy(locale: Locale): typeof RU | typeof EN {
  return locale === "ru" ? RU : EN;
}
