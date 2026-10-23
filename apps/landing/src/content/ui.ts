import type { Locale } from "./pages";

const RU = {
  common: {
    breadcrumbsLabel: "Хлебные крошки",
    discussTask: "Обсудить задачу",
    homeLabel: "Маркиро, на главную страницу",
    menuClose: "Закрыть меню",
    menuOpen: "Открыть меню",
    navigationLabel: "Основная навигация",
    faqKicker: "Вопросы по теме",
    relatedArticlesHeading: "Статьи по теме",
    relatedArticlesKicker: "Разобрано подробнее",
    reviewedLabel: "Проверено",
    summaryHeading: "Коротко о главном",
    summaryKicker: "Коротко",
    relatedHeading: "Связанные производственные сценарии",
    relatedKicker: "Следующий шаг",
    requestDemo: "Запросить демонстрацию",
    seoCtaHeading: "Проверим сценарий на данных вашей линии.",
    seoCtaKicker: "Демонстрация на вашем процессе",
    skipLink: "Перейти к содержанию",
  },
  home: {
    demo: {
      company: "Компания",
      contactNote: "Контактный телефон появится после подключения публичной линии.",
      email: "Email",
      heading: "Разберём вашу линию за 30 минут.",
      kicker: "Созвон по видеосвязи",
      lead: "Расскажите о продукте, упаковке и оборудовании. За 30 минут покажем, как идёт смена в Маркиро Автоном, и сверим правила вашей товарной группы.",
      legal: {
        consent: "согласия",
        prefix: "Даю согласие на обработку персональных данных на условиях",
        privacy: "политикой обработки персональных данных",
        separator: "и подтверждаю, что ознакомился с",
      },
      name: "Как к вам обращаться",
      phone: "Телефон для связи (необязательно)",
      unavailable: "Онлайн-отправка временно недоступна.",
      unavailableContact: "Напишите нам на",
    },
  },
  hub: {
    articlesHeading: "Все статьи",
    articlesKicker: "01 / Практика",
    instructionsKicker: "Инструкции",
    minutes: "мин чтения",
    otherGroup: "Другие инструкции",
    registryLink: "публичном реестре документов",
    registryNote: "Коды, редакции, даты и PDF/A всех инструкций также опубликованы в",
  },
} as const;

const EN = {
  common: {
    breadcrumbsLabel: "Breadcrumbs",
    discussTask: "Discuss your workflow",
    homeLabel: "Markiro home page",
    menuClose: "Close menu",
    menuOpen: "Open menu",
    navigationLabel: "Primary navigation",
    faqKicker: "Questions on this topic",
    relatedArticlesHeading: "Related articles",
    relatedArticlesKicker: "Covered in depth",
    reviewedLabel: "Reviewed",
    summaryHeading: "In short",
    summaryKicker: "Summary",
    relatedHeading: "Related production workflows",
    relatedKicker: "Next step",
    requestDemo: "Request a demonstration",
    seoCtaHeading: "Test the workflow with data from your line.",
    seoCtaKicker: "A demonstration using your process",
    skipLink: "Skip to content",
  },
  home: {
    demo: {
      company: "Company",
      contactNote: "A contact number will appear when the public phone line is connected.",
      email: "Email",
      heading: "Walk through your line with us in 30 minutes.",
      kicker: "Video call",
      lead: "Tell us about your product, packaging and equipment. In 30 minutes we will show how a shift runs in Markiro Autonom and check the rules of your product group.",
      legal: {
        consent: "personal-data consent",
        prefix: "I consent to the processing of my personal data under the",
        privacy: "personal-data processing policy",
        separator: "and confirm that I have read the",
      },
      name: "Your name",
      phone: "Contact phone (optional)",
      unavailable: "Online submission is temporarily unavailable.",
      unavailableContact: "Email us at",
    },
  },
  hub: {
    articlesHeading: "All articles",
    articlesKicker: "01 / Practice",
    instructionsKicker: "Instructions",
    minutes: "min read",
    otherGroup: "Other instructions",
    registryLink: "public document registry",
    registryNote:
      "Codes, revisions, dates and PDF/A files of every instruction are also published in the",
  },
} as const;

export function getUiCopy(locale: Locale): typeof RU | typeof EN {
  return locale === "ru" ? RU : EN;
}
