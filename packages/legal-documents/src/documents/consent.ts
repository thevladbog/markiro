import type { LegalDocumentLocaleContent } from "../types.js";

export const CONSENT_CONTENT = {
  ru: {
    locale: "ru",
    title: "Согласие на обработку персональных данных",
    summary:
      "Самостоятельное согласие посетителя на обработку данных, необходимых для ответа на запрос и организации демонстрации Markiro.",
    sections: [
      {
        id: "operator",
        heading: "1. Оператор",
        blocks: [
          {
            kind: "paragraph",
            text: "Я даю согласие Богатыреву Владиславу Сергеевичу, адрес: 353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26, email: hello@v-b.tech, телефон: +7 934 355-14-90, на обработку моих персональных данных на условиях настоящего документа.",
          },
        ],
      },
      {
        id: "data-and-purposes",
        heading: "2. Данные и цели",
        blocks: [
          {
            kind: "paragraph",
            text: "Согласие охватывает указанные мной имя, компанию, адрес электронной почты и необязательный номер телефона, а также исходную страницу, идентификатор запроса, версию согласия и ограниченные технические данные защиты формы.",
          },
          {
            kind: "unordered-list",
            items: [
              "ответ на мой запрос и уточнение потребностей;",
              "организация демонстрации Markiro;",
              "отправка транзакционного подтверждения получения запроса;",
              "предотвращение автоматизированных злоупотреблений и обеспечение безопасности сервиса.",
            ],
          },
        ],
      },
      {
        id: "operations-and-processors",
        heading: "3. Операции, способы и привлеченные сервисы",
        blocks: [
          {
            kind: "paragraph",
            text: "Разрешаю сбор, запись, систематизацию, накопление, хранение, уточнение, извлечение, использование, передачу привлеченным обработчикам в необходимом объеме, блокирование, удаление и уничтожение данных. Обработка может выполняться автоматизированно и без использования средств автоматизации.",
          },
          {
            kind: "paragraph",
            text: "Для указанных целей могут привлекаться российская облачная инфраструктура и хранилище секретов, сервис транзакционной почты Postbox, SmartCaptcha и почтовый провайдер оператора. Состав и роли поставщиков раскрываются в политике обработки персональных данных.",
          },
        ],
      },
      {
        id: "term-and-withdrawal",
        heading: "4. Срок и отзыв",
        blocks: [
          {
            kind: "paragraph",
            text: "Согласие действует до достижения указанных целей, но деловая заявка и связанная переписка хранятся не более одного года с последнего содержательного контакта, если для более длительной ограниченной обработки не возникло иное законное основание.",
          },
          {
            kind: "paragraph",
            text: "Я могу отозвать согласие письмом на hello@v-b.tech или почтовым отправлением по адресу оператора. Отзыв не отменяет законность обработки, выполненной до отзыва; закон или необходимость защиты прав могут требовать продолжения ограниченной обработки после него.",
          },
        ],
      },
      {
        id: "confirmation",
        heading: "5. Подтверждение",
        blocks: [
          {
            kind: "paragraph",
            text: "Устанавливая обязательный флажок в форме и отправляя запрос, я подтверждаю, что действую свободно, своей волей и в своем интересе, прочитал настоящее согласие и политику обработки персональных данных, понимаю цели, состав данных, операции и порядок отзыва.",
          },
          {
            kind: "paragraph",
            text: "Идентификатор принятого согласия: MKR-PD-02/2026.08.01. Код документа: MKR-PD-02. Редакция: 2026.08.01. Дата вступления в силу: 2026-08-15. Русский текст является юридически значимым и приоритетным.",
          },
        ],
      },
    ],
  },
  en: {
    locale: "en",
    title: "Consent to Personal Data Processing",
    summary:
      "This is an informational translation. The matching Russian revision is authoritative. It records consent needed to answer a request and arrange a Markiro demonstration.",
    sections: [
      {
        id: "operator",
        heading: "1. Controller",
        blocks: [
          {
            kind: "paragraph",
            text: "I consent to processing by Богатырев Владислав Сергеевич, address: 353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26, email: hello@v-b.tech, phone: +7 934 355-14-90, on the terms of this document.",
          },
        ],
      },
      {
        id: "data-and-purposes",
        heading: "2. Data and purposes",
        blocks: [
          {
            kind: "paragraph",
            text: "This consent covers the name, company, email address, and optional phone number that I provide, together with the source page, request identifier, consent revision, and bounded form-protection technical data.",
          },
          {
            kind: "unordered-list",
            items: [
              "responding to my request and clarifying my needs;",
              "arranging a Markiro demonstration;",
              "sending a transactional confirmation that the request was received;",
              "preventing automated abuse and protecting the service.",
            ],
          },
        ],
      },
      {
        id: "operations-and-processors",
        heading: "3. Operations, methods, and service providers",
        blocks: [
          {
            kind: "paragraph",
            text: "I permit collection, recording, organization, accumulation, storage, correction, retrieval, use, necessary transmission to engaged processors, restriction, erasure, and destruction. Processing may be automated and may also be performed without automated means.",
          },
          {
            kind: "paragraph",
            text: "The stated purposes may use Russian cloud infrastructure and secret storage, Postbox transactional mail, SmartCaptcha, and the controller's mailbox provider. The processing policy discloses provider categories and roles.",
          },
        ],
      },
      {
        id: "term-and-withdrawal",
        heading: "4. Term and withdrawal",
        blocks: [
          {
            kind: "paragraph",
            text: "Consent remains effective until the stated purposes are achieved, but the business request and related correspondence are retained for no more than one year after the last substantive contact unless another lawful basis requires limited longer processing.",
          },
          {
            kind: "paragraph",
            text: "I may withdraw consent by emailing hello@v-b.tech or sending post to the controller's address. Withdrawal does not invalidate processing performed before withdrawal; law or the defense of rights may require limited continued processing.",
          },
        ],
      },
      {
        id: "confirmation",
        heading: "5. Confirmation",
        blocks: [
          {
            kind: "paragraph",
            text: "By selecting the required unchecked box and submitting the form, I confirm that I act freely and in my own interest, have read this consent and the processing policy, and understand the purposes, data, operations, and withdrawal procedure.",
          },
          {
            kind: "paragraph",
            text: "Accepted consent identifier: MKR-PD-02/2026.08.01. Document code: MKR-PD-02. Revision: 2026.08.01. Effective date: 2026-08-15. The Russian text is authoritative; this English text is an informational translation.",
          },
        ],
      },
    ],
  },
} as const satisfies Readonly<Record<"ru" | "en", LegalDocumentLocaleContent>>;
