import type { LegalDocumentLocaleContent } from "../types.js";

export const PRIVACY_CONTENT = {
  ru: {
    locale: "ru",
    title: "Политика обработки персональных данных",
    summary:
      "Политика описывает обработку персональных данных на сайте markiro.app и распределение ролей при работе с данными внутри тенанта.",
    sections: [
      {
        id: "general",
        heading: "1. Общие положения и оператор",
        blocks: [
          {
            kind: "paragraph",
            text: "Оператор персональных данных сайта markiro.app — Богатырев Владислав Сергеевич, адрес: 353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26. Для обращений используются hello@v-b.tech и телефон +7 934 355-14-90.",
          },
          {
            kind: "paragraph",
            text: "Политика действует для публичного сайта, формы запроса демонстрации и тех случаев, когда Markiro самостоятельно определяет цели обработки. Отношения по данным сотрудников тенанта отдельно описаны в разделе 12.",
          },
        ],
      },
      {
        id: "principles",
        heading: "2. Термины и принципы",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Персональные данные",
                detail:
                  "любая информация, относящаяся к прямо или косвенно определенному или определяемому физическому лицу.",
              },
              {
                term: "Обработка",
                detail:
                  "любое действие или совокупность действий с персональными данными с использованием автоматизации или без нее.",
              },
              {
                term: "Тенант",
                detail:
                  "изолированная организация-заказчик в Markiro, самостоятельно определяющая цели работы с данными своих работников и иных лиц.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "Обработка ведется законно, добросовестно, для заранее определенных целей, в минимально необходимом объеме, с обеспечением точности, ограничением срока хранения и защитой от неправомерного доступа.",
          },
        ],
      },
      {
        id: "subjects-and-data",
        heading: "3. Субъекты, данные и источники",
        blocks: [
          {
            kind: "paragraph",
            text: "Субъектами являются посетители сайта и представители организаций, которые направляют запрос на демонстрацию, а также пользователи платформы в тех случаях, когда Markiro выступает самостоятельным оператором.",
          },
          {
            kind: "paragraph",
            text: "Форма демонстрации получает непосредственно от посетителя имя, значение поля «компания», адрес электронной почты и необязательный номер телефона. Система также фиксирует технические поля «исходная страница», «идентификатор запроса», «версия согласия» и ограниченные данные антифрода и captcha. Поля не используются для скрытого обогащения профиля.",
          },
        ],
      },
      {
        id: "purposes-and-bases",
        heading: "4. Цели и правовые основания",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "ответ на запрос посетителя и уточнение его потребностей;",
              "организация демонстрации Markiro;",
              "отправка транзакционного подтверждения о получении запроса;",
              "предотвращение автоматизированных злоупотреблений и защита безопасности сервиса;",
              "исполнение договора, соблюдение обязательных требований и защита законных интересов — только когда соответствующее основание действительно применимо.",
            ],
          },
          {
            kind: "paragraph",
            text: "Для данных формы основанием служит отдельное согласие MKR-PD-02/2026.08.01. Эта редакция не предусматривает рекламу, маркетинговые рассылки, веб-аналитику, профилирование, обогащение лидов или передачу заявок в CRM.",
          },
        ],
      },
      {
        id: "operations",
        heading: "5. Операции и способы обработки",
        blocks: [
          {
            kind: "paragraph",
            text: "Оператор может собирать, записывать, систематизировать, накапливать, хранить, уточнять, извлекать, использовать, передавать привлеченным обработчикам в установленном объеме, блокировать, удалять и уничтожать данные. Обработка осуществляется смешанным способом: автоматизированными средствами и, при разборе обращения, без использования средств автоматизации.",
          },
        ],
      },
      {
        id: "retention-and-destruction",
        heading: "6. Сроки хранения, блокирование и уничтожение",
        blocks: [
          {
            kind: "paragraph",
            text: "Деловая заявка и связанная переписка хранятся не более одного года с последнего содержательного контакта, если договор, обязательное требование закона или действующее требование либо спор не создают иного документированного основания. После достижения цели или истечения срока данные удаляются, уничтожаются либо блокируются на время проверки обоснованного требования.",
          },
          {
            kind: "paragraph",
            text: "Зашифрованная служебная копия письма в очереди доставки живет существенно меньше: полезная нагрузка стирается после терминального результата, а техническая запись доставки удаляется по ограниченному операционному сроку. Этот короткий срок не заменяет отдельное удаление деловой переписки из почтового ящика по годовому пределу.",
          },
        ],
      },
      {
        id: "processors",
        heading: "7. Получатели и привлеченные сервисы",
        blocks: [
          {
            kind: "paragraph",
            text: "В необходимом объеме могут использоваться сервисы Яндекс Облака для размещения инфраструктуры и секретов, Postbox для транзакционной отправки, SmartCaptcha для защиты формы и выбранный оператором почтовый провайдер для приема и хранения переписки. Роли и официальные наименования поставщиков должны сверяться с действующими договорами перед публикацией и при изменении состава сервисов.",
          },
          {
            kind: "paragraph",
            text: "Привлеченные лица получают только необходимый объем данных и обрабатывают его по договору, поручению или собственным опубликованным условиям в пределах применимого правового основания. Оператор не продает данные.",
          },
        ],
      },
      {
        id: "localization-and-transfer",
        heading: "8. Локализация и трансграничная передача",
        blocks: [
          {
            kind: "paragraph",
            text: "Первичная запись, систематизация, накопление, хранение, уточнение и извлечение персональных данных граждан Российской Федерации выполняются с использованием баз данных, находящихся на территории Российской Федерации.",
          },
          {
            kind: "paragraph",
            text: "Трансграничная передача в этой конфигурации не планируется. До ее возможного включения оператор отдельно проверит получателей, основания и обязательные процедуры, обновит эту политику и предоставит необходимую информацию субъектам.",
          },
        ],
      },
      {
        id: "security-and-incidents",
        heading: "9. Безопасность и инциденты",
        blocks: [
          {
            kind: "paragraph",
            text: "Применяются разграничение доступа, изоляция тенантов, шифрование чувствительных служебных данных, журналирование, резервирование, контроль изменений, ограничение сроков хранения и процедуры реагирования на инциденты. Состав мер пересматривается с учетом характера данных и актуальных угроз без раскрытия сведений, способных ослабить защиту.",
          },
          {
            kind: "paragraph",
            text: "При подтвержденном нарушении оператор ограничивает последствия, сохраняет необходимые доказательства, выполняет предусмотренные законом уведомления и информирует затронутых участников в применимом объеме.",
          },
        ],
      },
      {
        id: "subject-rights",
        heading: "10. Права субъекта и порядок обращения",
        blocks: [
          {
            kind: "paragraph",
            text: "Субъект вправе запросить сведения об обработке, уточнение, блокирование или удаление данных, возразить против обработки в предусмотренных законом случаях и отозвать согласие. Запрос направляется на hello@v-b.tech или по почтовому адресу оператора. Для защиты данных оператор может запросить сведения, достаточные для подтверждения личности и поиска обращения.",
          },
          {
            kind: "paragraph",
            text: "Отзыв не делает незаконной обработку, выполненную до его получения. Ограниченная обработка может продолжаться, если этого требует закон, договорное требование или защита прав, о чем субъекту сообщается применительно к его запросу.",
          },
        ],
      },
      {
        id: "cookies-and-captcha",
        heading: "11. Cookies, технические данные и SmartCaptcha",
        blocks: [
          {
            kind: "paragraph",
            text: "Сайт не устанавливает аналитические или рекламные cookies. Для базовой работы могут обрабатываться строго необходимые данные браузера и сервера. Когда форма включена, SmartCaptcha может получать IP-адрес и сетевые метаданные, характеристики браузера и устройства, реферер, часовой пояс, время запроса, проверочный токен и cookies поставщика, необходимые для выявления автоматизированных обращений.",
          },
          {
            kind: "paragraph",
            text: "Сценарий captcha загружается только при включенной онлайн-отправке. Если появится необязательное хранилище или отслеживание, для него будет создан отдельный механизм выбора до запуска.",
          },
        ],
      },
      {
        id: "tenant-data",
        heading: "12. Данные внутри тенанта",
        blocks: [
          {
            kind: "paragraph",
            text: "Если организация-тенант определяет цели и состав обработки данных своих сотрудников, оператором этих данных остается тенант. Он отвечает за правовые основания, информирование работников, получение согласий, когда они требуются, точность данных, объем инструкций и решения по обращениям субъектов.",
          },
          {
            kind: "paragraph",
            text: "Markiro в этой части обрабатывает данные по документированному поручению тенанта и отвечает за соблюдение инструкции, конфиденциальность, безопасность, контроль привлеченных обработчиков, сообщение об инцидентах, содействие по запросам и возврат либо удаление данных. Для собственных отдельно определенных целей Markiro действует как самостоятельный оператор.",
          },
        ],
      },
      {
        id: "revisions",
        heading: "13. Редакции и применимый текст",
        blocks: [
          {
            kind: "paragraph",
            text: "Код документа — MKR-PD-01, редакция — 2026.08.01, дата вступления в силу — 2026-08-15. Новая редакция публикуется как отдельная версия с собственной датой и связью с заменяемым документом.",
          },
          {
            kind: "paragraph",
            text: "Русский текст является юридически значимым и приоритетным. Английская версия представляет собой информационный перевод соответствующей русской редакции.",
          },
        ],
      },
    ],
  },
  en: {
    locale: "en",
    title: "Personal Data Processing Policy",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. The policy describes processing on markiro.app and the allocation of tenant-data roles.",
    sections: [
      {
        id: "general",
        heading: "1. General provisions and controller",
        blocks: [
          {
            kind: "paragraph",
            text: "The controller for markiro.app is Богатырев Владислав Сергеевич, address: 353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26. Requests may be sent to hello@v-b.tech or made by phone at +7 934 355-14-90.",
          },
          {
            kind: "paragraph",
            text: "This policy covers the public website, demonstration-request form, and cases where Markiro independently determines processing purposes. Tenant employee data is addressed separately in section 12.",
          },
        ],
      },
      {
        id: "principles",
        heading: "2. Terms and principles",
        blocks: [
          {
            kind: "definition-list",
            items: [
              {
                term: "Personal data",
                detail: "information relating to an identified or identifiable person.",
              },
              {
                term: "Processing",
                detail:
                  "any operation performed on personal data, by automated or non-automated means.",
              },
              {
                term: "Tenant",
                detail:
                  "an isolated customer organization in Markiro that determines purposes for data concerning its staff and other persons.",
              },
            ],
          },
          {
            kind: "paragraph",
            text: "Processing is lawful, fair, purpose-limited, data-minimized, accurate, retention-limited, and protected against unauthorized access.",
          },
        ],
      },
      {
        id: "subjects-and-data",
        heading: "3. Data subjects, data, and sources",
        blocks: [
          {
            kind: "paragraph",
            text: "Data subjects include website visitors and organization representatives requesting a demonstration, and platform users where Markiro acts as an independent controller.",
          },
          {
            kind: "paragraph",
            text: "The form collects directly from the visitor a name, company, email address, and optional phone number. It also records the source page, request identifier, consent revision, and bounded anti-abuse and captcha technical data. These fields are not used for hidden profile enrichment.",
          },
        ],
      },
      {
        id: "purposes-and-bases",
        heading: "4. Purposes and legal bases",
        blocks: [
          {
            kind: "unordered-list",
            items: [
              "responding to the visitor and clarifying their needs;",
              "arranging a Markiro demonstration;",
              "sending a transactional receipt confirmation;",
              "preventing automated abuse and protecting service security;",
              "performing a contract, meeting a mandatory legal duty, or defending legitimate claims only where that basis actually applies.",
            ],
          },
          {
            kind: "paragraph",
            text: "Form data relies on separate consent MKR-PD-02/2026.08.01. This revision provides no advertising, marketing mail, web analytics, profiling, lead enrichment, or CRM forwarding.",
          },
        ],
      },
      {
        id: "operations",
        heading: "5. Processing operations",
        blocks: [
          {
            kind: "paragraph",
            text: "The controller may collect, record, organize, accumulate, store, correct, retrieve, use, transmit to engaged processors within the stated scope, restrict, erase, and destroy data. Processing is mixed: automated and, when correspondence is reviewed, non-automated.",
          },
        ],
      },
      {
        id: "retention-and-destruction",
        heading: "6. Retention, restriction, and destruction",
        blocks: [
          {
            kind: "paragraph",
            text: "A business request and related correspondence are retained for no more than one year after the last substantive contact unless a contract, mandatory law, or an active claim provides another documented basis. Data are then erased or destroyed, or temporarily restricted while a substantiated request is assessed.",
          },
          {
            kind: "paragraph",
            text: "The encrypted operational mail-delivery copy has a much shorter lifecycle: its payload is erased after a terminal result and the bounded technical delivery row is later cleaned up. That shorter period does not replace deletion of the mailbox correspondence at the one-year boundary.",
          },
        ],
      },
      {
        id: "processors",
        heading: "7. Recipients and service providers",
        blocks: [
          {
            kind: "paragraph",
            text: "As needed, Yandex Cloud services may host infrastructure and secrets, Postbox may send transactional mail, SmartCaptcha may protect the form, and the controller's mailbox provider may receive and retain correspondence. Provider legal names and roles must be checked against active contracts before publication and whenever the service set changes.",
          },
          {
            kind: "paragraph",
            text: "Engaged parties receive only necessary data and process it under a contract, instruction, or their published terms within an applicable legal basis. The controller does not sell personal data.",
          },
        ],
      },
      {
        id: "localization-and-transfer",
        heading: "8. Localization and international transfer",
        blocks: [
          {
            kind: "paragraph",
            text: "The initial recording, organization, accumulation, storage, correction, and retrieval of Russian citizens' personal data use databases located in the Russian Federation.",
          },
          {
            kind: "paragraph",
            text: "No cross-border transfer is intended in this configuration. Before any future activation, the controller will assess recipients, legal grounds, and mandatory procedures, update this policy, and give required information to data subjects.",
          },
        ],
      },
      {
        id: "security-and-incidents",
        heading: "9. Security and incidents",
        blocks: [
          {
            kind: "paragraph",
            text: "Measures include access control, tenant isolation, encryption of sensitive operational data, logging, backups, change control, retention limits, and incident response. Measures are reviewed against data sensitivity and current threats without publishing exploitable detail.",
          },
          {
            kind: "paragraph",
            text: "For a confirmed breach, the controller contains the impact, preserves necessary evidence, performs legally required notifications, and informs affected participants where applicable.",
          },
        ],
      },
      {
        id: "subject-rights",
        heading: "10. Data-subject rights and requests",
        blocks: [
          {
            kind: "paragraph",
            text: "A data subject may request information, correction, restriction or erasure, object where the law provides, and withdraw consent. Requests go to hello@v-b.tech or the controller's postal address. To protect data, the controller may request enough information to verify identity and locate the request.",
          },
          {
            kind: "paragraph",
            text: "Withdrawal does not invalidate processing performed before it was received. Limited processing may continue where law, a contractual claim, or the defense of rights requires it, with an explanation relevant to the request.",
          },
        ],
      },
      {
        id: "cookies-and-captcha",
        heading: "11. Cookies, technical data, and SmartCaptcha",
        blocks: [
          {
            kind: "paragraph",
            text: "The site sets no analytics or advertising cookies. Strictly necessary browser and server data may be processed. When submission is enabled, SmartCaptcha may receive an IP address and network metadata, browser and device characteristics, referrer, time zone, request time, verification token, and provider cookies needed to detect automated requests.",
          },
          {
            kind: "paragraph",
            text: "Captcha code loads only when online submission is enabled. Any future non-essential storage or tracking requires a separate choice mechanism before launch.",
          },
        ],
      },
      {
        id: "tenant-data",
        heading: "12. Data inside a tenant",
        blocks: [
          {
            kind: "paragraph",
            text: "When a tenant organization determines purposes and scope for its employees' data, that tenant remains the controller. It is responsible for lawful grounds, notices, required consents, accuracy, instructions, and decisions on data-subject requests.",
          },
          {
            kind: "paragraph",
            text: "For that processing, Markiro acts on the tenant's documented instruction and remains responsible for instruction compliance, confidentiality, security, engaged-processor control, incident notice, request assistance, and data return or deletion. Markiro is an independent controller for its separately determined purposes.",
          },
        ],
      },
      {
        id: "revisions",
        heading: "13. Revisions and authoritative text",
        blocks: [
          {
            kind: "paragraph",
            text: "Document code: MKR-PD-01; revision: 2026.08.01; effective date: 2026-08-15. A replacement is published as a distinct revision with its own date and supersession link.",
          },
          {
            kind: "paragraph",
            text: "The Russian text is authoritative. This English text is an informational translation of the matching Russian revision.",
          },
        ],
      },
    ],
  },
} as const satisfies Readonly<Record<"ru" | "en", LegalDocumentLocaleContent>>;
