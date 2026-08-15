import type { LegalDocumentLocaleContent } from "../types.js";

export const BRAND_LETTERHEAD_CONTENT = {
  ru: {
    locale: "ru",
    title: "Фирменный бланк Markiro",
    summary: "Правила использования компактного редактируемого фирменного бланка.",
    sections: [
      {
        id: "template-status",
        heading: "1. Статус",
        blocks: [
          {
            kind: "paragraph",
            text: "ШАБЛОН — НЕ ЯВЛЯЕТСЯ ДЕЙСТВУЮЩИМ ДОКУМЕНТОМ. Бланк становится частью документа только после заполнения, проверки и оформления уполномоченным лицом.",
          },
        ],
      },
      {
        id: "permitted-use",
        heading: "2. Использование",
        blocks: [
          {
            kind: "paragraph",
            text: "Шаблон предназначен для официальной переписки и индивидуальных документов Markiro. Следует сохранять фирменный знак, типографику, компактную верхнюю область, нижний колонтитул, поля и стили заголовков.",
          },
        ],
      },
      {
        id: "placeholders",
        heading: "3. Заполняемые реквизиты",
        blocks: [
          {
            kind: "paragraph",
            text: "Перед выпуском заполняются название и номер документа, дата, адресат, текст, сведения об уполномоченном лице и иные применимые реквизиты. Для индивидуального документа назначается уникальный номер; общая версия шаблона не заменяет его.",
          },
        ],
      },
      {
        id: "document-control",
        heading: "4. Контроль документа",
        blocks: [
          {
            kind: "paragraph",
            text: "Код шаблона: MKR-BRD-01. Редакция: 2026.08.01. Дата вступления в силу: 2026-08-15. Нижний колонтитул содержит номер страницы и Data Matrix, ведущий на запись именно этого шаблона в публичном реестре. Русский текст является приоритетным; английский — информационным переводом.",
          },
        ],
      },
      {
        id: "prohibited-elements",
        heading: "5. Что не входит в шаблон",
        blocks: [
          {
            kind: "paragraph",
            text: "Шаблон не содержит предзаполненные сведения о контрагенте, подпись, печать, заявление об утверждении, юридическую оценку или статус проверки конкретного документа. Такие элементы добавляются только в рамках отдельной подтвержденной процедуры.",
          },
        ],
      },
    ],
  },
  en: {
    locale: "en",
    title: "Markiro Branded Letterhead",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. These are the use rules for the compact editable letterhead.",
    sections: [
      {
        id: "template-status",
        heading: "1. Status",
        blocks: [
          {
            kind: "paragraph",
            text: "TEMPLATE — NOT AN OPERATIVE DOCUMENT. The letterhead becomes part of a document only after completion, review, and execution by an authorized person.",
          },
        ],
      },
      {
        id: "permitted-use",
        heading: "2. Permitted use",
        blocks: [
          {
            kind: "paragraph",
            text: "The template is for official Markiro correspondence and issued documents. Preserve the brand mark, typography, compact header, footer, margins, and heading styles.",
          },
        ],
      },
      {
        id: "placeholders",
        heading: "3. Fields to complete",
        blocks: [
          {
            kind: "paragraph",
            text: "Before issue, complete the document name and number, date, addressee, body, authorized-person details, and other applicable particulars. Assign a unique number to an individual document; the common template revision does not replace it.",
          },
        ],
      },
      {
        id: "document-control",
        heading: "4. Document control",
        blocks: [
          {
            kind: "paragraph",
            text: "Template code: MKR-BRD-01. Revision: 2026.08.01. Effective date: 2026-08-15. The footer carries the page number and a Data Matrix linking to this template's public registry record. The Russian text is authoritative; English is informational.",
          },
        ],
      },
      {
        id: "prohibited-elements",
        heading: "5. Excluded elements",
        blocks: [
          {
            kind: "paragraph",
            text: "The template contains no prefilled counterparty details, signature, seal, approval statement, legal assessment, or verification status for a particular document. Those elements require a separate confirmed process.",
          },
        ],
      },
    ],
  },
} as const satisfies Readonly<Record<"ru" | "en", LegalDocumentLocaleContent>>;
