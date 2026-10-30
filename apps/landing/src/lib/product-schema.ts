import { PRODUCT_FACTS, V4_HOME_FAQ } from "../content/product-facts";
import { TARIFFS } from "../content/pricing";
import type { PageGraph, PageMetadata } from "./seo";

const origin = "https://markiro.app";
const softwareId = `${origin}/#software`;
const handheldId = `${origin}/#handheld-software`;
const productId = `${origin}/stoimost/#product`;
const ref = (id: string) => ({ "@id": id });

/** The three V4 commercial surfaces share identities and public facts. Legal/instruction graphs are untouched. */
export function buildV4ProductGraph(page: PageMetadata, shared: PageGraph["@graph"]): PageGraph {
  const facts = PRODUCT_FACTS;
  const pricing = page.path === "/stoimost/";
  const home = page.path === "/";
  const pageUrl = `${origin}${page.path}`;
  const graph: PageGraph["@graph"] = [
    ...shared,
    {
      "@type": "WebPage",
      "@id": `${pageUrl}#webpage`,
      url: pageUrl,
      name: home ? facts.heading : pricing ? "Тарифы Маркиро" : "Маркиро Автоном для Windows",
      description: page.description,
      inLanguage: "ru",
      isPartOf: ref(`${origin}/#website`),
      mainEntity: ref(pricing ? productId : softwareId),
      about: [ref(softwareId), ref(handheldId)],
      ...(home ? { hasPart: ref(`${origin}/#faq`) } : { breadcrumb: ref(`${pageUrl}#breadcrumb`) }),
    },
    {
      "@type": "SoftwareApplication",
      "@id": softwareId,
      name: facts.name,
      alternateName: ["Markiro Autonom", "Markiro"],
      url: `${origin}/`,
      installUrl: `${origin}/skachat/`,
      description:
        "Программа для агрегации кодов маркировки на Windows. Офис управляет сменами и продукцией; станция выполняет упаковку и агрегацию. Главный ПК, офис и станция — роли одного установщика. Пробный период 14 дней со всеми функциями, без оплаты.",
      applicationCategory: facts.applicationCategory,
      operatingSystem: facts.desktop.operatingSystems,
      processorRequirements: facts.desktop.architecture,
      inLanguage: "ru",
      publisher: ref(`${origin}/#organization`),
      softwareHelp: { "@type": "CreativeWork", url: `${origin}/instruktsii/` },
      featureList: [
        facts.office,
        facts.station,
        "Собирайте короба и паллеты в одной смене агрегации — на станции или ТСД.",
        "Программа и база на ПК производства, работа без интернета",
        "Резервные копии базы на оборудовании производства",
        "Выгрузки смены в TXT, CSV или XML для ГИС МТ и 1С",
      ],
    },
    {
      "@type": "SoftwareApplication",
      "@id": handheldId,
      name: "Маркиро Автоном — приложение ТСД",
      description: facts.handheld.description,
      applicationCategory: facts.applicationCategory,
      operatingSystem: `Android ${facts.handheld.minimumAndroidVersion}+`,
      inLanguage: "ru",
      publisher: ref(`${origin}/#organization`),
      softwareRequirements: ref(softwareId),
      featureList: [
        facts.handheld.description,
        "Короба и паллеты в одной смене агрегации",
        "Отдельное приложение. Связь с главным ПК по локальной сети.",
      ],
    },
  ];
  if (pricing)
    graph.push({
      "@type": "Product",
      "@id": productId,
      name: facts.name,
      description: `Годовая лицензия на одну площадку. ${facts.office} ${facts.station} ${facts.handheld.description} ${facts.seats}`,
      brand: { "@type": "Brand", name: "Маркиро" },
      mainEntityOfPage: ref(`${pageUrl}#webpage`),
      offers: TARIFFS.filter((t) => t.pricePerYear !== null).map((t) => ({
        "@type": "Offer",
        "@id": `${pageUrl}#offer-${t.code}`,
        name: `Тариф «${t.name}»`,
        description: `Годовая лицензия на одну площадку. ${t.features.join("; ")}. ${facts.seats} Цены без НДС.`,
        url: `${pageUrl}#plan-${t.code}`,
        price: t.pricePerYear,
        priceCurrency: "RUB",
        seller: ref(`${origin}/#organization`),
        itemOffered: ref(productId),
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: t.pricePerYear,
          priceCurrency: "RUB",
          billingDuration: "P1Y",
          referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitText: "площадка" },
          unitText: "площадка в год",
          valueAddedTaxIncluded: false,
        },
      })),
    });
  if (home)
    graph.push({
      "@type": "FAQPage",
      "@id": `${origin}/#faq`,
      mainEntity: V4_HOME_FAQ.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      })),
    });
  else
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${pageUrl}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Главная", item: `${origin}/` },
        {
          "@type": "ListItem",
          position: 2,
          name: pricing ? "Стоимость" : "Скачать",
          item: pageUrl,
        },
      ],
    });
  return { "@context": "https://schema.org", "@graph": graph };
}
