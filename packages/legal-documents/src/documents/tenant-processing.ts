import type { LegalDocumentLocaleContent } from "../types.js";

export const TENANT_PROCESSING_CONTENT = {
  ru: {
    locale: "ru",
    title: "Поручение на обработку персональных данных тенанта",
    summary:
      "Шаблон определяет границы ответственности тенанта как оператора и Markiro как лица, обрабатывающего данные по поручению.",
    sections: [
      {
        id: "template-status",
        heading: "1. Статус шаблона",
        blocks: [
          {
            kind: "paragraph",
            text: "ШАБЛОН — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ. Этот текст не создает поручение до заполнения сведений о сторонах, целях, категориях субъектов и данных, сроках, специальных инструкциях и до оформления сторонами согласованным способом.",
          },
        ],
      },
      {
        id: "roles",
        heading: "2. Роли сторон",
        blocks: [
          {
            kind: "paragraph",
            text: "Тенант, который определяет цели и способы обработки персональных данных своих работников и иных лиц, является оператором. Markiro является лицом, осуществляющим обработку персональных данных по поручению оператора, только в пределах документированных инструкций тенанта.",
          },
          {
            kind: "paragraph",
            text: "Роль обработчика не освобождает Markiro от обязанностей по конфиденциальности, безопасности, соблюдению поручения и содействию оператору.",
          },
        ],
      },
      {
        id: "tenant-duties",
        heading: "3. Обязанности тенанта-оператора",
        blocks: [
          {
            kind: "paragraph",
            text: "Тенант обеспечивает законные основания обработки, уведомление сотрудников и иных субъектов, получение согласий, когда они требуются, точность и актуальность данных, законность цели и объема, документированные инструкции, а также принимает решения по обращениям субъектов как оператор.",
          },
          {
            kind: "paragraph",
            text: "Тенант не поручает обработку данных, избыточных для заявленной производственной цели, и своевременно сообщает об изменении основания, состава данных, срока или режима доступа.",
          },
        ],
      },
      {
        id: "instructions",
        heading: "4. Предмет и инструкции",
        blocks: [
          {
            kind: "paragraph",
            text: "Индивидуальный документ должен определить операции, цели, категории субъектов и данных, территорию и срок обработки, порядок доступа, выгрузки, исправления, блокирования, возврата и удаления. Markiro вправе запросить уточнение противоречивой или технически невыполнимой инструкции и сообщает, если инструкция, по его обоснованному мнению, нарушает применимое право.",
          },
        ],
      },
      {
        id: "processor-duties",
        heading: "5. Обязанности Markiro как обработчика",
        blocks: [
          {
            kind: "paragraph",
            text: "Markiro обрабатывает данные только по документированному поручению, обеспечивает конфиденциальность допущенных лиц, применяет соразмерные меры безопасности, сохраняет изоляцию тенантов и предоставляет оператору согласованные сведения, необходимые для подтверждения исполнения поручения.",
          },
          {
            kind: "paragraph",
            text: "Markiro не использует данные тенанта для рекламы, самостоятельного профилирования работников или целей третьих лиц и не расширяет поручение молчанием либо настройкой интерфейса.",
          },
        ],
      },
      {
        id: "subprocessors",
        heading: "6. Привлеченные обработчики",
        blocks: [
          {
            kind: "paragraph",
            text: "Привлечение субподрядчика допускается на условиях, согласованных с тенантом или предусмотренных договором. Markiro ведет актуальный состав существенных обработчиков, передает им только необходимый объем и возлагает сопоставимые обязанности по конфиденциальности, безопасности и удалению.",
          },
        ],
      },
      {
        id: "incidents-and-assistance",
        heading: "7. Инциденты, доказательства и содействие",
        blocks: [
          {
            kind: "paragraph",
            text: "Markiro без неоправданной задержки сообщает тенанту о подтвержденном инциденте, затрагивающем порученные данные, в объеме доступных проверенных сведений, содействует локализации последствий и последующему уточнению информации.",
          },
          {
            kind: "paragraph",
            text: "С учетом характера обработки Markiro содействует тенанту в ответах субъектам, оценке требований к безопасности, подтверждении принятых мер и подготовке обязательных уведомлений. Тенант остается ответственным за юридическое решение и ответ как оператор.",
          },
        ],
      },
      {
        id: "return-and-deletion",
        heading: "8. Возврат и удаление",
        blocks: [
          {
            kind: "paragraph",
            text: "После прекращения поручения Markiro по выбору, предусмотренному индивидуальным документом, возвращает доступную выгрузку и удаляет порученные данные либо сохраняет строго ограниченную часть, если обязательное требование запрещает немедленное удаление. Резервные копии выводятся из обращения по установленному циклу и не используются для обычной обработки.",
          },
        ],
      },
      {
        id: "independent-processing",
        heading: "9. Самостоятельная обработка Markiro",
        blocks: [
          {
            kind: "paragraph",
            text: "Markiro действует как самостоятельный оператор только для отдельно определенных собственных целей, например биллинг и расчеты, безопасность платформы, реагирование на злоупотребления и обязательный учет, если Markiro самостоятельно определяет цель и основание. Такая обработка не маскируется под поручение и описывается в соответствующей политике или договоре.",
          },
        ],
      },
      {
        id: "execution-and-numbering",
        heading: "10. Оформление и нумерация",
        blocks: [
          {
            kind: "paragraph",
            text: "Код шаблона: MKR-DPA-01. Редакция: 2026.08.01. Дата вступления в силу шаблона: 2026-08-15. После заполнения и оформления конкретный документ получает уникальный индивидуальный номер; код общего шаблона не подтверждает заключение поручения.",
          },
          {
            kind: "paragraph",
            text: "Русский текст является юридически значимым и приоритетным. Английская версия представляет собой информационный перевод этой же редакции.",
          },
        ],
      },
    ],
  },
  en: {
    locale: "en",
    title: "Tenant Personal Data Processing Instruction",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. This template separates the tenant-controller and Markiro-processor roles.",
    sections: [
      {
        id: "template-status",
        heading: "1. Template status",
        blocks: [
          {
            kind: "paragraph",
            text: "TEMPLATE — NOT AN OPERATIVE DOCUMENT. No instruction is created until party details, purposes, subject and data categories, terms, and special instructions are completed and the parties execute the document through an agreed process.",
          },
        ],
      },
      {
        id: "roles",
        heading: "2. Party roles",
        blocks: [
          {
            kind: "paragraph",
            text: "A tenant determining the purposes and means for personal data concerning its workers or other people is the controller. Markiro is a person processing personal data on behalf of that controller only within the tenant's documented instructions.",
          },
          {
            kind: "paragraph",
            text: "The processor role does not release Markiro from confidentiality, security, instruction-compliance, or controller-assistance duties.",
          },
        ],
      },
      {
        id: "tenant-duties",
        heading: "3. Tenant-controller duties",
        blocks: [
          {
            kind: "paragraph",
            text: "The tenant ensures lawful grounds, employee and data-subject notices, required consents, data accuracy, lawful purpose and scope, documented instructions, and decisions on data-subject requests as controller.",
          },
          {
            kind: "paragraph",
            text: "The tenant does not instruct processing beyond the stated production purpose and promptly communicates changes to legal basis, data scope, term, or access regime.",
          },
        ],
      },
      {
        id: "instructions",
        heading: "4. Subject matter and instructions",
        blocks: [
          {
            kind: "paragraph",
            text: "An issued document must define operations, purposes, subject and data categories, territory and term, access, export, correction, restriction, return, and deletion. Markiro may seek clarification of contradictory or technically impossible instructions and reports instructions it reasonably believes violate applicable law.",
          },
        ],
      },
      {
        id: "processor-duties",
        heading: "5. Markiro processor duties",
        blocks: [
          {
            kind: "paragraph",
            text: "Markiro processes only on documented instruction, binds authorized personnel to confidentiality, applies proportionate security, preserves tenant isolation, and provides agreed evidence needed to demonstrate instruction compliance.",
          },
          {
            kind: "paragraph",
            text: "Markiro does not use tenant data for advertising, independent employee profiling, or third-party purposes and does not silently expand the instruction through interface settings.",
          },
        ],
      },
      {
        id: "subprocessors",
        heading: "6. Subprocessors",
        blocks: [
          {
            kind: "paragraph",
            text: "A subprocessor may be engaged under terms agreed with the tenant or established by contract. Markiro maintains the material processor set, transfers only necessary data, and imposes comparable confidentiality, security, and deletion duties.",
          },
        ],
      },
      {
        id: "incidents-and-assistance",
        heading: "7. Incidents, evidence, and assistance",
        blocks: [
          {
            kind: "paragraph",
            text: "Without undue delay, Markiro informs the tenant of a confirmed incident affecting instructed data using available verified facts, assists containment, and supplies later clarifications.",
          },
          {
            kind: "paragraph",
            text: "Taking processing nature into account, Markiro assists with subject requests, security assessments, measure evidence, and mandatory-notice preparation. The tenant retains the legal decision and response as controller.",
          },
        ],
      },
      {
        id: "return-and-deletion",
        heading: "8. Return and deletion",
        blocks: [
          {
            kind: "paragraph",
            text: "After the instruction ends, Markiro provides an available export and deletes instructed data as selected in the issued document, unless a mandatory rule requires limited retention. Backups age out under the established cycle and are not used for ordinary processing.",
          },
        ],
      },
      {
        id: "independent-processing",
        heading: "9. Markiro independent processing",
        blocks: [
          {
            kind: "paragraph",
            text: "Markiro is an independent controller only for separately determined purposes such as billing, platform security, abuse response, and statutory records where Markiro determines the purpose and basis. Such processing is not described as an instruction and is disclosed in the relevant policy or contract.",
          },
        ],
      },
      {
        id: "execution-and-numbering",
        heading: "10. Execution and numbering",
        blocks: [
          {
            kind: "paragraph",
            text: "Template code: MKR-DPA-01. Revision: 2026.08.01. Template effective date: 2026-08-15. A completed and executed document receives a unique individual number; the common template code is not proof of execution.",
          },
          {
            kind: "paragraph",
            text: "The Russian text is authoritative. This English text is an informational translation of the same revision.",
          },
        ],
      },
    ],
  },
} as const satisfies Readonly<Record<"ru" | "en", LegalDocumentLocaleContent>>;
