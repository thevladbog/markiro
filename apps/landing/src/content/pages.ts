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
    title: "Markiro — маркировка и агрегация для производства",
    description:
      "Markiro помогает проверять коды, печатать этикетки, собирать короба и паллеты и сохранять прослеживаемость на производственной линии.",
    heading: "Линия идёт. Маркировка под контролем.",
    navigationLabel: "Markiro",
    eyebrow: "Маркировка / агрегация / прослеживаемость",
    introduction:
      "Производственная система для проверки кодов, упаковки, агрегации и восстановления операций без остановки линии.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-14",
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
          "связь единицы с коробом или паллетой;",
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
    title: "SSCC и агрегация коробов и паллет — Markiro",
    description:
      "Markiro помогает собирать единицы в короба и паллеты, проверять иерархию упаковки по SSCC и сохранять историю агрегации и восстановления.",
    heading: "SSCC и агрегация без потери иерархии упаковки",
    navigationLabel: "SSCC и агрегация",
    eyebrow: "Единица → короб → паллета",
    introduction:
      "SSCC — серийный код транспортной упаковки. В Markiro он становится идентификатором короба или паллеты, с которым связаны вложенные единицы и история операций.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: SHARED_IMAGE_ALT,
    reviewedAt: "2026-08-14",
    relatedPaths: ["/markirovka-chestny-znak/", "/rabochee-mesto-upakovki/", "/oflayn-rabota/"],
    sections: [
      {
        heading: "Как строится иерархия",
        paragraphs: [
          "Оператор открывает упаковку, сканирует вложенные коды и закрывает её после проверки состава. Для следующего уровня готовый короб становится вложением паллеты.",
        ],
        bullets: [
          "один код не должен одновременно принадлежать разным открытым упаковкам;",
          "состав проверяется до закрытия;",
          "каждое изменение остаётся отдельным событием;",
          "ошибка не должна останавливать работу остальных операций линии.",
        ],
      },
      {
        heading: "Зачем сохранять события, а не только итог",
        paragraphs: [
          "Итоговая связь показывает текущее состояние, а журнал объясняет, как оно появилось. Это необходимо для разбора расхождений, повторной синхронизации и контролируемого восстановления.",
        ],
      },
      {
        heading: "Работа при нестабильной сети",
        paragraphs: [
          "Локальная станция продолжает регистрировать допустимые операции. После восстановления связи очередь отправляется повторяемо, а конфликт должен стать видимым и восстанавливаемым.",
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
    title: "Markiro — production serialization and aggregation",
    description:
      "Markiro verifies serialized codes, prints labels, aggregates cases and pallets, and keeps production traceability available when the network is down.",
    heading: "Keep the line moving. Keep serialization under control.",
    navigationLabel: "Markiro",
    eyebrow: "Serialization / aggregation / traceability",
    introduction:
      "A production system for code verification, packing, aggregation, and recoverable operations without stopping the line.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-14",
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
          "the relationship between an item, case, or pallet;",
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
    title: "SSCC case and pallet aggregation — Markiro",
    description:
      "Markiro aggregates items into cases and pallets, validates the SSCC packaging hierarchy, and retains the history required for controlled recovery.",
    heading: "SSCC aggregation without losing the packaging hierarchy",
    navigationLabel: "SSCC and aggregation",
    eyebrow: "Item → case → pallet",
    introduction:
      "An SSCC identifies a logistics unit. In Markiro, it identifies a case or pallet together with its contents and complete aggregation history.",
    socialImage: SHARED_IMAGE,
    socialImageAlt: "Markiro — production serialization, aggregation, and traceability",
    reviewedAt: "2026-08-14",
    relatedPaths: [
      "/en/chestny-znak-serialization/",
      "/en/packing-workstation/",
      "/en/offline-production/",
    ],
    sections: [
      {
        heading: "How the hierarchy is built",
        paragraphs: [
          "The operator opens a pack, scans its contents, and closes it after validation. At the next level, the completed case becomes an item inside a pallet.",
        ],
        bullets: [
          "one code cannot belong to two open packs at the same time;",
          "contents are validated before closing;",
          "every change remains a separate event;",
          "one error must not stop unrelated line operations.",
        ],
      },
      {
        heading: "Why events matter as much as the result",
        paragraphs: [
          "The final relationship shows the current state; the event log explains how it was created. That history supports discrepancy analysis, safe resynchronization, and controlled recovery.",
        ],
      },
      {
        heading: "Working through unstable connectivity",
        paragraphs: [
          "The local station keeps recording permitted operations. When connectivity returns, the queue can be submitted safely and any conflict remains visible and recoverable.",
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

export function findSeoPage(path: string): SeoPageDefinition {
  const page = SEO_PAGES.find((candidate) => candidate.path === path);
  if (page === undefined) throw new Error(`Unknown SEO page: ${path}`);
  return page;
}
