export type CanonicalPath =
  | "/"
  | "/markirovka-chestny-znak/"
  | "/sscc-i-agregatsiya/"
  | "/rabochee-mesto-upakovki/"
  | "/kiosk-samovydachi/"
  | "/integratsiya-1c/"
  | "/oflayn-rabota/"
  | "/faq/"
  | "/en/"
  | "/en/chestny-znak-serialization/"
  | "/en/sscc-and-aggregation/"
  | "/en/packing-workstation/"
  | "/en/self-service-pickup-kiosk/"
  | "/en/1c-integration/"
  | "/en/offline-production/"
  | "/en/faq/";

export type Locale = "ru" | "en";

export interface SearchPageRecord {
  readonly path: string;
  readonly alternatePath?: string | undefined;
  readonly locale: Locale;
  readonly navigationLabel: string;
  readonly description: string;
  readonly lastModified: `${number}-${number}-${number}`;
}

export interface ContentSection {
  heading: string;
  paragraphs: readonly string[];
  bullets?: readonly string[];
}

export interface FaqEntry {
  question: string;
  answer: string;
}

export interface SeoPageDefinition {
  path: CanonicalPath;
  alternatePath: CanonicalPath;
  locale: Locale;
  title: string;
  description: string;
  heading: string;
  navigationLabel: string;
  eyebrow: string;
  introduction: string;
  socialImage: string;
  socialImageAlt: string;
  reviewedAt: `${number}-${number}-${number}`;
  relatedPaths: readonly CanonicalPath[];
  sections: readonly ContentSection[];
  faq?: readonly FaqEntry[];
}

const SHARED_IMAGE = "/og-markiro.jpg";
const SHARED_IMAGE_ALT = "Markiro — маркировка, агрегация и прослеживаемость производства";

export const SEO_PAGES: readonly SeoPageDefinition[] = [
  {
    path: "/",
    alternatePath: "/en/",
    locale: "ru",
    title: "ПО для маркировки пива и агрегации коробов — Markiro",
    description:
      "ПО для маркировки пива и слабоалкогольных напитков: проверка кодов, агрегация коробов и работа станции при нестабильной сети.",
    heading: "Маркировка и агрегация. Линия идёт.",
    navigationLabel: "Markiro",
    eyebrow: "Маркировка / агрегация / прослеживаемость",
    introduction:
      "Производственная система для пива, сидра и слабоалкогольных напитков: проверка кодов, упаковка, агрегация и восстановление операций без остановки линии.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-26",
    relatedPaths: ["/markirovka-chestny-znak/", "/sscc-i-agregatsiya/", "/oflayn-rabota/"],
    sections: [],
  },
  {
    path: "/markirovka-chestny-znak/",
    alternatePath: "/en/chestny-znak-serialization/",
    locale: "ru",
    title: "Маркировка «Честный знак» на производстве — Markiro",
    description:
      "Как Markiro связывает проверку кодов, печать этикеток, упаковку и журнал операций в управляемый процесс маркировки на производственной линии.",
    heading: "Маркировка «Честный знак» как производственный процесс",
    navigationLabel: "Маркировка «Честный знак»",
    eyebrow: "Контроль от кода до упаковки",
    introduction:
      "Markiro объединяет операции с кодами маркировки в последовательный производственный поток: код проверяется, наносится, связывается с упаковкой и остаётся в журнале прослеживаемости.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-14",
    relatedPaths: ["/rabochee-mesto-upakovki/", "/sscc-i-agregatsiya/", "/integratsiya-1c/"],
    sections: [
      {
        heading: "Где начинается контроль",
        paragraphs: [
          "Система получает производственное задание и данные о товаре, а рабочая станция проверяет сканируемые значения до фиксации операции.",
          "Проверка на границе операции снижает риск перенести неверный код на следующий этап упаковки.",
        ],
      },
      {
        heading: "Что фиксируется на линии",
        paragraphs: [
          "События печати, нанесения, упаковки и агрегации сохраняются как последовательность действий, связанную со сменой, рабочим местом и оператором.",
        ],
        bullets: [
          "результат проверки кода;",
          "связь единицы с коробом;",
          "ошибки и действия восстановления;",
          "состояние синхронизации локальных операций.",
        ],
      },
      {
        heading: "Граница ответственности",
        paragraphs: [
          "Markiro управляет производственным контуром и прослеживаемостью операций. Обмен с внешними системами настраивается по подтверждённому контракту; конкретный состав интеграции зависит от действующего процесса предприятия.",
        ],
      },
    ],
  },
  {
    path: "/sscc-i-agregatsiya/",
    alternatePath: "/en/sscc-and-aggregation/",
    locale: "ru",
    title: "SSCC и агрегация коробов с пивной продукцией — Markiro",
    description:
      "Markiro собирает маркированное пиво и слабоалкогольные напитки в короба, проверяет SSCC и сохраняет историю агрегации и восстановления.",
    heading: "SSCC и агрегация коробов для пивной продукции",
    navigationLabel: "SSCC и агрегация",
    eyebrow: "Единица → короб",
    introduction:
      "Markiro сейчас ориентирован на производственные сценарии товарной группы «Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки», включая сидр. Новые товарные группы добавляются поэтапно. Для конкретного товара применимость проверяется по кодам ТН ВЭД ЕАЭС и ОКПД 2 и фактическому процессу линии.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-26",
    relatedPaths: ["/markirovka-chestny-znak/", "/rabochee-mesto-upakovki/", "/oflayn-rabota/"],
    sections: [
      {
        heading: "Что такое SSCC в агрегации",
        paragraphs: [
          "SSCC — 18-значный идентификатор логистической единицы: например, короба или паллеты. В текущем сценарии Markiro он идентифицирует короб. В штрихкоде и при обмене с внешними системами SSCC может передаваться с идентификатором применения GS1 AI (00), поэтому оператор видит 20 цифр, а система хранит нормализованное 18-значное значение.",
          "Код единицы товара и SSCC решают разные задачи. Код маркировки идентифицирует конкретную потребительскую упаковку, а SSCC связывает транспортную упаковку с её составом и уровнем в иерархии.",
        ],
      },
      {
        heading: "Как единицы собираются в короб",
        paragraphs: [
          "Оператор открывает короб на рабочей станции и последовательно сканирует коды маркировки бутылок, банок или другой потребительской упаковки. Markiro связывает принятые коды с открытым коробом и показывает его заполнение. После проверки состава оператор закрывает короб и печатает его этикетку.",
          "Текущий поддерживаемый уровень — цепочка «единица → короб». Паллетная агрегация, где закрытые короба становятся вложениями паллеты, будет добавлена отдельным следующим этапом.",
        ],
        bullets: [
          "рабочая станция получает доступный диапазон SSCC и расходует номера последовательно;",
          "код связывается с конкретной открытой упаковкой и рабочей сменой;",
          "состав и количество единиц видны до закрытия короба;",
          "этикетка строится из тех же данных, которые прошли проверку.",
        ],
      },
      {
        heading: "Что Markiro проверяет до закрытия упаковки",
        paragraphs: [
          "Проверка происходит на границе каждой операции. Проблемный код не должен незаметно перейти в готовую транспортную упаковку, а ошибка одного сканирования не должна лишать оператора возможности продолжать допустимые действия.",
        ],
        bullets: [
          "распознан ли формат кода и относится ли он к текущему заданию;",
          "не был ли этот код уже принят или связан с другой упаковкой;",
          "достигнуто ли ожидаемое количество единиц в коробе;",
          "какой короб, станция, смена и оператор создали событие;",
          "подтверждена ли печать этикетки или требуется отдельное действие.",
        ],
      },
      {
        heading: "Почему журнал событий важнее одного итогового состояния",
        paragraphs: [
          "Итоговая связь показывает, какие единицы сейчас относятся к коробу. Журнал объясняет, как это состояние появилось: кто отсканировал код, когда упаковка была закрыта, что отправлялось на печать и где возникло отклонение.",
          "Такой порядок нужен для разбора расхождений и восстановления после сбоя. Закрытая упаковка не исправляется незаметно: изменение состава, исключение кода или разагрегация должны оставаться отдельным контролируемым действием.",
        ],
      },
      {
        heading: "Как агрегация работает при нестабильной сети",
        paragraphs: [
          "Рабочая станция хранит локальное задание, диапазон SSCC, открытые упаковки и журнал сканирований. Поэтому допустимые операции не зависят от ответа сервера на каждом шаге и могут продолжаться при временном разрыве связи.",
          "После восстановления сети локальная очередь отправляется повторяемо. Подтверждённые сервером события удаляются из очереди, а конфликт между устройствами сохраняется и становится видимым для ответственного сотрудника. Markiro не маскирует конфликт автоматическим выбором, который нельзя проверить.",
        ],
      },
      {
        heading: "Граница Markiro и внешних систем",
        paragraphs: [
          "Markiro формирует и сохраняет производственный факт агрегации: SSCC, состав упаковки, родительские связи и историю операций. Передача сведений в систему маркировки «Честный знак», 1С или другой внешний контур выполняется только по согласованному интеграционному контракту предприятия.",
          "Демонстрация начинается с проверки текущего задания, правил упаковки, источника SSCC и требуемого выходного документа. Это позволяет не обещать универсальный обмен там, где состав данных и ответственность сторон ещё не определены.",
        ],
      },
      {
        heading: "Что подготовить для демонстрации агрегации",
        paragraphs: [
          "Для предметного разбора достаточно одного реального сценария линии. Мы сопоставим его с текущими возможностями Markiro и отдельно обозначим, какие настройки или интеграции потребуются.",
        ],
        bullets: [
          "вид продукции и коды ТН ВЭД ЕАЭС и ОКПД 2;",
          "тип потребительской и транспортной упаковки;",
          "количество единиц в коробе и, если это требуется в будущем, планируемое количество коробов на паллете;",
          "модели сканеров и принтеров;",
          "источник производственного задания и диапазонов SSCC;",
          "состав обмена с 1С и системой маркировки.",
        ],
      },
    ],
  },
  {
    path: "/rabochee-mesto-upakovki/",
    alternatePath: "/en/packing-workstation/",
    locale: "ru",
    title: "Рабочее место упаковщика и маркировки — Markiro",
    description:
      "Локальная станция Markiro связывает сканер, принтер, задание и журнал операций, чтобы упаковщик продолжал работу при нестабильной сети.",
    heading: "Рабочее место упаковщика, рассчитанное на непрерывную линию",
    navigationLabel: "Рабочее место упаковки",
    eyebrow: "Сканер / принтер / локальный журнал",
    introduction:
      "Станция Markiro — это рабочий интерфейс оператора и локальный контур выполнения: она принимает сканы, проверяет шаг процесса, готовит печать и сохраняет операции до синхронизации.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-14",
    relatedPaths: ["/oflayn-rabota/", "/sscc-i-agregatsiya/", "/markirovka-chestny-znak/"],
    sections: [
      {
        heading: "Оператор видит следующий допустимый шаг",
        paragraphs: [
          "Интерфейс показывает активную смену, задание, текущую упаковку и результат последнего сканирования. Ошибка объясняется на том же рабочем месте, где её можно исправить.",
        ],
      },
      {
        heading: "Оборудование остаётся частью локального контура",
        paragraphs: [
          "Сканеры, принтеры, шрифты и макеты не должны зависеть от внешнего CDN или доступности браузерного сервиса. Печать и предварительный просмотр используют одну модель этикетки.",
        ],
      },
      {
        heading: "Восстановление важнее скрытого автоповтора",
        paragraphs: [
          "Система показывает неотправленные, отклонённые и конфликтующие операции. Повтор должен быть безопасным, а оператору или инженеру требуется понятная точка продолжения после перезапуска.",
        ],
      },
    ],
  },
  {
    path: "/kiosk-samovydachi/",
    alternatePath: "/en/self-service-pickup-kiosk/",
    locale: "ru",
    title: "Киоск самовыдачи маркированной продукции — Markiro",
    description:
      "Киоск Markiro помогает покупателю получить подготовленный заказ по коду, а сотрудникам — сохранить контроль выдачи и восстановление при сбоях.",
    heading: "Киоск самовыдачи для подготовленных заказов",
    navigationLabel: "Киоск самовыдачи",
    eyebrow: "Самообслуживание с контролем выдачи",
    introduction:
      "Киоск Markiro — отдельное доверенное устройство: покупатель проходит короткий сценарий получения, а права кабинета и производственных операторов не переносятся в публичный интерфейс.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-14",
    relatedPaths: ["/oflayn-rabota/", "/markirovka-chestny-znak/", "/faq/"],
    sections: [
      {
        heading: "Как проходит выдача",
        paragraphs: [
          "Сценарий ведёт пользователя от идентификации заказа к подтверждению и выдаче. Крупные элементы управления и понятные состояния рассчитаны на сенсорный экран.",
        ],
      },
      {
        heading: "Устройство сначала связывается с организацией",
        paragraphs: [
          "Киоск получает собственную идентичность через контролируемое сопряжение. Пользовательский ввод не определяет организацию или права доступа сам по себе.",
        ],
      },
      {
        heading: "Что происходит без связи",
        paragraphs: [
          "Локально доступный сценарий и очередь операций должны переживать перезапуск. Действия, для которых нужны свежие серверные данные или авторизация, явно показывают ограничение вместо ложного успеха.",
        ],
      },
    ],
  },
  {
    path: "/integratsiya-1c/",
    alternatePath: "/en/1c-integration/",
    locale: "ru",
    title: "Интеграция маркировки и производства с 1С — Markiro",
    description:
      "Markiro разделяет производственный контур и обмен с 1С: задания и товары приходят по согласованному контракту, а ошибки остаются повторяемыми и наблюдаемыми.",
    heading: "Интеграция Markiro с 1С без скрытой потери операций",
    navigationLabel: "Интеграция с 1С",
    eyebrow: "Обмен с явным статусом",
    introduction:
      "Интеграция с 1С — это управляемая граница обмена, а не прямой доступ учётной системы к рабочему месту. Markiro принимает проверяемые данные и возвращает явный результат обработки.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-14",
    relatedPaths: ["/markirovka-chestny-znak/", "/sscc-i-agregatsiya/", "/faq/"],
    sections: [
      {
        heading: "Контракт вместо ручного переноса",
        paragraphs: [
          "Состав обмена определяется данными предприятия: каталогом, заданиями, статусами и идентификаторами. Входные значения проверяются до записи, а ошибка относится к конкретной записи или пакету.",
        ],
      },
      {
        heading: "Повтор не должен создавать дубликаты",
        paragraphs: [
          "Сетевой сбой не всегда означает, что операция не была принята. Поэтому повторяемые запросы и обработка статусов проектируются идемпотентно, с явным подтверждением результата.",
        ],
      },
      {
        heading: "Конкретная конфигурация согласуется отдельно",
        paragraphs: [
          "Версия 1С, расширения, состав справочников и правила обмена отличаются. На демонстрации фиксируются источники данных, владельцы полей, частота обмена и способ восстановления ошибок.",
        ],
      },
    ],
  },
  {
    path: "/oflayn-rabota/",
    alternatePath: "/en/offline-production/",
    locale: "ru",
    title: "Офлайн-работа маркировки на производстве — Markiro",
    description:
      "Markiro сохраняет локальные операции маркировки и упаковки, переживает перезапуск и синхронизирует очередь после восстановления соединения.",
    heading: "Офлайн-работа производства: линия не ждёт сеть",
    navigationLabel: "Офлайн-работа производства",
    eyebrow: "Локальное выполнение и контролируемая синхронизация",
    introduction:
      "Офлайн-режим Markiro — не скрытие ошибки сети, а отдельный рабочий контур: допустимые операции выполняются локально, записываются в журнал и отправляются после восстановления связи.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-14",
    relatedPaths: ["/rabochee-mesto-upakovki/", "/sscc-i-agregatsiya/", "/kiosk-samovydachi/"],
    sections: [
      {
        heading: "Что остаётся на устройстве",
        paragraphs: [
          "Задания и справочные данные, необходимые для разрешённого сценария, синхронизируются заранее. Локальный журнал и исходящая очередь сохраняются между перезапусками.",
        ],
      },
      {
        heading: "Как возвращается связь",
        paragraphs: [
          "Очередь отправляется повторяемо с идентичностью устройства и последовательностью операций. Сервер различает принятые, отклонённые, конфликтующие и временно не обработанные записи.",
        ],
      },
      {
        heading: "Офлайн не означает без ограничений",
        paragraphs: [
          "Операция, которой нужны свежие серверные права или данные, не должна изображать успех. Интерфейс показывает ограничение и сохраняет понятный путь восстановления.",
        ],
      },
    ],
  },
  {
    path: "/faq/",
    alternatePath: "/en/faq/",
    locale: "ru",
    title: "Вопросы о Markiro, маркировке и агрегации",
    description:
      "Короткие ответы о Markiro: маркировка, SSCC, агрегация, офлайн-работа станции, киоск самовыдачи, оборудование и интеграция с 1С.",
    heading: "Вопросы о Markiro и работе на производстве",
    navigationLabel: "Вопросы и ответы",
    eyebrow: "Прямые ответы без общих обещаний",
    introduction:
      "Здесь собраны ответы о границах продукта и основных производственных сценариях. Детали внедрения проверяются на данных и оборудовании конкретного предприятия.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-14",
    relatedPaths: ["/markirovka-chestny-znak/", "/sscc-i-agregatsiya/", "/oflayn-rabota/"],
    sections: [],
    faq: [
      {
        question: "Что делает Markiro?",
        answer:
          "Markiro управляет производственными операциями маркировки: проверкой кодов, печатью этикеток, упаковкой, агрегацией и журналом прослеживаемости.",
      },
      {
        question: "Продолжит ли станция работу без интернета?",
        answer:
          "Допустимые офлайн-операции выполняются локально и сохраняются в очереди. После восстановления связи станция синхронизирует их и показывает отклонения или конфликты.",
      },
      {
        question: "Что такое SSCC в Markiro?",
        answer:
          "SSCC идентифицирует транспортную упаковку — например, короб или паллету — и связывает её с вложенными единицами и историей агрегации.",
      },
      {
        question: "Markiro работает со сканерами и принтерами?",
        answer:
          "Рабочая станция рассчитана на локальный производственный контур со сканером и принтером. Совместимость конкретных моделей проверяется до внедрения.",
      },
      {
        question: "Есть ли интеграция с 1С?",
        answer:
          "Markiro поддерживает интеграционный контур для обмена производственными данными. Точный состав и формат обмена согласуются для конфигурации предприятия.",
      },
      {
        question: "Можно ли использовать киоск для самовыдачи?",
        answer:
          "Да, Markiro включает отдельный сценарий киоска для получения подготовленных заказов с собственной идентичностью устройства и контролем доступных действий.",
      },
    ],
  },
  {
    path: "/en/",
    alternatePath: "/",
    locale: "en",
    title: "Beer serialization and case aggregation software — Markiro",
    description:
      "Serialization software for beer and low-alcohol beverages: code verification, case aggregation, and resilient workstation operation.",
    heading: "Serialization and aggregation. Keep the line moving.",
    navigationLabel: "Markiro",
    eyebrow: "Serialization / aggregation / traceability",
    introduction:
      "A production system for beer, cider and low-alcohol beverages: code verification, packing, aggregation, and recoverable operations without stopping the line.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-26",
    relatedPaths: [
      "/en/chestny-znak-serialization/",
      "/en/sscc-and-aggregation/",
      "/en/offline-production/",
    ],
    sections: [],
  },
  {
    path: "/en/chestny-znak-serialization/",
    alternatePath: "/markirovka-chestny-znak/",
    locale: "en",
    title: "Chestny ZNAK production serialization — Markiro",
    description:
      "See how Markiro connects code verification, label printing, packing, and event history into a controlled Chestny ZNAK production workflow.",
    heading: "Chestny ZNAK serialization as a production workflow",
    navigationLabel: "Chestny ZNAK serialization",
    eyebrow: "Control from serialized code to pack",
    introduction:
      "Markiro turns serialization operations into one production flow: codes are verified, applied, connected to packs, and retained in the traceability log.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-14",
    relatedPaths: ["/en/packing-workstation/", "/en/sscc-and-aggregation/", "/en/1c-integration/"],
    sections: [
      {
        heading: "Where control begins",
        paragraphs: [
          "The system receives a production order and product data, while the workstation validates each scanned value before recording the operation.",
          "Validation at the operation boundary reduces the risk of carrying an invalid code into the next packing stage.",
        ],
      },
      {
        heading: "What the line records",
        paragraphs: [
          "Printing, application, packing, and aggregation events are stored as an ordered history tied to the shift, workstation, and operator.",
        ],
        bullets: [
          "code validation results;",
          "the relationship between an item and its case;",
          "errors and recovery actions;",
          "the synchronization state of local operations.",
        ],
      },
      {
        heading: "Clear responsibility boundaries",
        paragraphs: [
          "Markiro controls the production workflow and its traceability. External exchanges follow an agreed contract, and the exact integration scope depends on the plant's operating process.",
        ],
      },
    ],
  },
  {
    path: "/en/sscc-and-aggregation/",
    alternatePath: "/sscc-i-agregatsiya/",
    locale: "en",
    title: "SSCC case aggregation for beer production — Markiro",
    description:
      "Markiro aggregates serialized beer and low-alcohol beverages into cases, validates SSCC relationships, and retains recovery history.",
    heading: "SSCC case aggregation for beer production",
    navigationLabel: "SSCC and aggregation",
    eyebrow: "Item → case",
    introduction:
      "Markiro currently focuses on production workflows for the Chestny ZNAK product group “Beer, beverages made from beer and low-alcohol beverages”, including cider. Additional product categories are being added gradually. Applicability to a specific product is checked against its TN VED EAEU and OKPD 2 codes and the actual line process.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-26",
    relatedPaths: [
      "/en/chestny-znak-serialization/",
      "/en/packing-workstation/",
      "/en/offline-production/",
    ],
    sections: [
      {
        heading: "What an SSCC means in aggregation",
        paragraphs: [
          "An SSCC is the 18-digit identifier of a logistics unit such as a case or pallet. In Markiro's current workflow it identifies a case. In a barcode and external exchange the SSCC can be represented with the GS1 Application Identifier (00), so the operator may see 20 digits while the system stores the normalized 18-digit value.",
          "A serialized product code and an SSCC serve different purposes. The serialized code identifies an individual consumer unit; the SSCC connects a transport pack to its contents and its level in the packaging hierarchy.",
        ],
      },
      {
        heading: "How items become cases",
        paragraphs: [
          "The operator opens a case at the workstation and scans the serialized codes on bottles, cans, or other consumer packs. Markiro connects accepted codes to that open case and displays its fill state. After validating the contents, the operator closes the case and prints its label.",
          "The currently supported level is the item-to-case chain. Pallet aggregation, where closed cases become items inside a pallet, will be added as a separate next stage.",
        ],
        bullets: [
          "the workstation receives an available SSCC range and consumes numbers sequentially;",
          "each code is associated with a specific open pack and production shift;",
          "contents and item count remain visible before the case is closed;",
          "the label uses the same data that passed validation.",
        ],
      },
      {
        heading: "What Markiro validates before closing a pack",
        paragraphs: [
          "Validation happens at each operation boundary. A problematic code must not silently enter a completed logistics unit, while one rejected scan must not prevent the operator from continuing unrelated permitted work.",
        ],
        bullets: [
          "whether the code format is recognized and belongs to the active order;",
          "whether the code was already accepted or associated with another pack;",
          "whether the expected number of items has been reached;",
          "which case, workstation, shift, and operator produced the event;",
          "whether label printing was confirmed or needs a separate action.",
        ],
      },
      {
        heading: "Why the event log matters more than a final snapshot",
        paragraphs: [
          "The final relationship shows which items currently belong to a case. The event log explains how that state was created: who scanned a code, when the pack was closed, what was sent to print, and where an exception appeared.",
          "This ordered history supports discrepancy analysis and recovery after a failure. A closed pack is not edited silently: changing its contents, releasing a code, or disaggregating the pack remains a separate controlled action.",
        ],
      },
      {
        heading: "How aggregation continues through unstable connectivity",
        paragraphs: [
          "The workstation retains the local order, SSCC range, open packs, and scan journal. Permitted operations therefore do not depend on a server response at every step and can continue through a temporary connection loss.",
          "When connectivity returns, the local queue is submitted idempotently. Server-accepted events leave the queue, while a cross-device conflict is retained and made visible to the responsible user. Markiro does not hide the conflict behind an automatic choice that cannot be audited.",
        ],
      },
      {
        heading: "The boundary between Markiro and external systems",
        paragraphs: [
          "Markiro creates and retains the production fact of aggregation: the SSCC, pack contents, parent-child relationships, and operation history. Submission to Chestny ZNAK, 1C, or another external system follows the plant's agreed integration contract.",
          "A demonstration begins by checking the active production order, packing rules, SSCC source, and required output document. This prevents a generic integration promise where the data contract and ownership have not yet been defined.",
        ],
      },
      {
        heading: "What to prepare for an aggregation demonstration",
        paragraphs: [
          "One real line workflow is enough for a focused review. We will compare it with current Markiro capabilities and identify any configuration or integration work separately.",
        ],
        bullets: [
          "product type and its TN VED EAEU and OKPD 2 codes;",
          "consumer and transport packaging formats;",
          "items per case and, when relevant for future scope, the planned number of cases per pallet;",
          "scanner and printer models;",
          "the source of production orders and SSCC ranges;",
          "the required exchange with 1C and the serialization system.",
        ],
      },
    ],
  },
  {
    path: "/en/packing-workstation/",
    alternatePath: "/rabochee-mesto-upakovki/",
    locale: "en",
    title: "Production packing and serialization workstation — Markiro",
    description:
      "The local Markiro station connects scanners, printers, production orders, and an operation log so packing continues through unstable connectivity.",
    heading: "A packing workstation designed for continuous production",
    navigationLabel: "Packing workstation",
    eyebrow: "Scanner / printer / local journal",
    introduction:
      "The Markiro station is both the operator interface and the local execution layer: it accepts scans, validates each step, prepares printing, and retains operations until synchronization.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-14",
    relatedPaths: [
      "/en/offline-production/",
      "/en/sscc-and-aggregation/",
      "/en/chestny-znak-serialization/",
    ],
    sections: [
      {
        heading: "The operator sees the next valid step",
        paragraphs: [
          "The interface shows the active shift, order, current pack, and latest scan result. An error is explained at the same workstation where it can be resolved.",
        ],
      },
      {
        heading: "Hardware stays inside the local production layer",
        paragraphs: [
          "Scanners, printers, fonts, and layouts must not depend on a CDN or an available browser service. Preview and print use the same label model.",
        ],
      },
      {
        heading: "Recovery matters more than hidden retries",
        paragraphs: [
          "The system exposes pending, rejected, and conflicting operations. Retries must be safe, with a clear continuation point after restart for the operator or engineer.",
        ],
      },
    ],
  },
  {
    path: "/en/self-service-pickup-kiosk/",
    alternatePath: "/kiosk-samovydachi/",
    locale: "en",
    title: "Self-service pickup kiosk for serialized goods — Markiro",
    description:
      "The Markiro kiosk guides customers through prepared-order pickup while staff retain controlled fulfilment, device identity, and failure recovery.",
    heading: "Self-service pickup for prepared orders",
    navigationLabel: "Self-service pickup kiosk",
    eyebrow: "Self-service with controlled fulfilment",
    introduction:
      "The Markiro kiosk is a separate trusted device: customers follow a short pickup flow without exposing office or production-operator permissions in a public interface.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-14",
    relatedPaths: ["/en/offline-production/", "/en/chestny-znak-serialization/", "/en/faq/"],
    sections: [
      {
        heading: "How pickup works",
        paragraphs: [
          "The flow guides a customer from order identification to confirmation and collection. Large controls and explicit states are designed for touch screens.",
        ],
      },
      {
        heading: "The device is paired before it serves customers",
        paragraphs: [
          "The kiosk receives its own identity through controlled pairing. Customer input alone never chooses an organization or grants permissions.",
        ],
      },
      {
        heading: "What happens without connectivity",
        paragraphs: [
          "Locally available steps and the operation queue survive a restart. Actions requiring current server data or authorization show a clear limitation instead of a false success.",
        ],
      },
    ],
  },
  {
    path: "/en/1c-integration/",
    alternatePath: "/integratsiya-1c/",
    locale: "en",
    title: "Production serialization integration with 1C — Markiro",
    description:
      "Markiro separates production execution from 1C exchange, validating orders and products while keeping failures observable, repeatable, and recoverable.",
    heading: "Connect Markiro and 1C without silently losing operations",
    navigationLabel: "1C integration",
    eyebrow: "Data exchange with explicit status",
    introduction:
      "A 1C integration is a controlled exchange boundary, not direct access from the accounting system to a workstation. Markiro validates incoming data and returns an explicit processing result.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-14",
    relatedPaths: ["/en/chestny-znak-serialization/", "/en/sscc-and-aggregation/", "/en/faq/"],
    sections: [
      {
        heading: "A contract instead of manual transfer",
        paragraphs: [
          "The exchange scope follows plant data: catalogues, orders, statuses, and identifiers. Incoming values are validated before storage, and each error is tied to a specific record or batch.",
        ],
      },
      {
        heading: "Retries must not create duplicates",
        paragraphs: [
          "A network failure does not prove that an operation was rejected. Requests and status processing are therefore designed to be idempotent and to provide explicit confirmation.",
        ],
      },
      {
        heading: "Each configuration is agreed separately",
        paragraphs: [
          "1C versions, extensions, catalogues, and exchange rules vary. The demonstration identifies data sources, field owners, exchange frequency, and the error-recovery process.",
        ],
      },
    ],
  },
  {
    path: "/en/offline-production/",
    alternatePath: "/oflayn-rabota/",
    locale: "en",
    title: "Offline production serialization and packing — Markiro",
    description:
      "Markiro keeps serialization and packing operations locally, survives workstation restarts, and synchronizes the durable queue after connectivity returns.",
    heading: "Offline production: the line does not wait for the network",
    navigationLabel: "Offline production",
    eyebrow: "Local execution and controlled synchronization",
    introduction:
      "Markiro offline mode is a separate operating layer, not a hidden network error: permitted actions run locally, enter a durable journal, and synchronize after connectivity returns.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-14",
    relatedPaths: [
      "/en/packing-workstation/",
      "/en/sscc-and-aggregation/",
      "/en/self-service-pickup-kiosk/",
    ],
    sections: [
      {
        heading: "What remains on the device",
        paragraphs: [
          "Orders and reference data required for an approved workflow are synchronized in advance. The local journal and outgoing queue persist across restarts.",
        ],
      },
      {
        heading: "How connectivity returns",
        paragraphs: [
          "The queue is submitted safely with device identity and operation sequence. The server distinguishes accepted, rejected, conflicting, and temporarily unprocessed records.",
        ],
      },
      {
        heading: "Offline does not mean unrestricted",
        paragraphs: [
          "An operation that needs current permissions or server data must not pretend to succeed. The interface shows the limitation and preserves a clear recovery path.",
        ],
      },
    ],
  },
  {
    path: "/en/faq/",
    alternatePath: "/faq/",
    locale: "en",
    title: "Questions about Markiro serialization and aggregation",
    description:
      "Direct answers about Markiro, SSCC aggregation, offline production stations, pickup kiosks, equipment compatibility, and integration with 1C.",
    heading: "Questions about Markiro in production",
    navigationLabel: "Questions and answers",
    eyebrow: "Direct answers without vague promises",
    introduction:
      "These answers define the product boundaries and core production workflows. Implementation details are validated against each plant's data and equipment.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-14",
    relatedPaths: [
      "/en/chestny-znak-serialization/",
      "/en/sscc-and-aggregation/",
      "/en/offline-production/",
    ],
    sections: [],
    faq: [
      {
        question: "What does Markiro do?",
        answer:
          "Markiro controls production serialization operations: code verification, label printing, packing, aggregation, and the traceability event log.",
      },
      {
        question: "Will the station keep working without the internet?",
        answer:
          "Permitted offline operations run locally and stay in a durable queue. When connectivity returns, the station synchronizes them and exposes any rejection or conflict.",
      },
      {
        question: "What is an SSCC in Markiro?",
        answer:
          "An SSCC identifies a logistics unit such as a case or pallet and connects it to its contents and aggregation history.",
      },
      {
        question: "Does Markiro work with scanners and printers?",
        answer:
          "The workstation is designed for a local production layer with scanners and printers. Compatibility with specific models is validated before rollout.",
      },
      {
        question: "Can Markiro integrate with 1C?",
        answer:
          "Markiro provides an integration layer for production-data exchange. The exact scope and exchange format are agreed for each plant configuration.",
      },
      {
        question: "Can the kiosk support self-service pickup?",
        answer:
          "Yes. Markiro includes a prepared-order pickup flow with its own trusted device identity and tightly controlled available actions.",
      },
    ],
  },
];

export const MARKETING_SEARCH_PAGES: readonly SearchPageRecord[] = SEO_PAGES.map((page) => ({
  path: page.path,
  alternatePath: page.alternatePath,
  locale: page.locale,
  navigationLabel: page.navigationLabel,
  description: page.description,
  lastModified: page.reviewedAt,
}));

export function findSeoPage(path: string): SeoPageDefinition {
  const page = SEO_PAGES.find((candidate) => candidate.path === path);
  if (page === undefined) throw new Error(`Unknown SEO page: ${path}`);
  return page;
}
