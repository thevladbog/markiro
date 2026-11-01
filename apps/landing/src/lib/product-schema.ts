import { PRODUCT_FACTS, V4_HOME_FAQ } from "../content/product-facts";
import { PRODUCT_FACTS_EN, V4_HOME_FAQ_EN } from "../content/product-facts-en";
import { TARIFFS } from "../content/pricing";
import { TARIFFS_EN } from "../content/autonom-en";
import type { PageGraph, PageMetadata } from "./seo";

const origin = "https://markiro.app";
const softwareId = `${origin}/#software`;
const handheldId = `${origin}/#handheld-software`;
const productId = `${origin}/stoimost/#product`;
const ref = (id: string) => ({ "@id": id });

/** The three V4 commercial surfaces share identities and public facts. Legal/instruction graphs are untouched. */
export function buildV4ProductGraph(page: PageMetadata, shared: PageGraph["@graph"]): PageGraph {
  const facts = PRODUCT_FACTS;
  const en = page.locale === "en";
  const copy = en ? PRODUCT_FACTS_EN : facts;
  const homePath = en ? "/en/" : "/";
  const faqId = `${origin}${homePath}#faq`;
  const pricing = page.path === "/stoimost/";
  const home = page.path === "/" || page.path === "/en/";
  const pageUrl = `${origin}${page.path}`;
  const graph: PageGraph["@graph"] = [
    ...shared,
    {
      "@type": "WebPage",
      "@id": `${pageUrl}#webpage`,
      url: pageUrl,
      name: home ? copy.heading : pricing ? "Тарифы Маркиро" : "Маркиро Автоном для Windows",
      description: page.description,
      inLanguage: page.locale,
      isPartOf: ref(`${origin}/#website`),
      mainEntity: ref(pricing ? productId : softwareId),
      about: [ref(softwareId), ref(handheldId)],
      ...(home ? { hasPart: ref(faqId) } : { breadcrumb: ref(`${pageUrl}#breadcrumb`) }),
    },
    {
      "@type": "SoftwareApplication",
      "@id": softwareId,
      name: copy.name,
      alternateName: en ? ["Маркиро Автоном", "Markiro"] : ["Markiro Autonom", "Markiro"],
      url: `${origin}${homePath}`,
      installUrl: `${origin}/skachat/`,
      description: en
        ? PRODUCT_FACTS_EN.softwareDescription
        : "Программа для агрегации кодов маркировки на Windows. Офис управляет сменами и продукцией; станция выполняет упаковку и агрегацию. Главный ПК, офис и станция — роли одного установщика. Пробный период 14 дней со всеми функциями, без оплаты.",
      // Home pages show these annual site licences. A trial is not a free software price.
      ...(home
        ? {
            offers: TARIFFS.filter((tariff) => tariff.pricePerYear !== null).map((tariff) => ({
              "@type": "Offer",
              name: en
                ? `${TARIFFS_EN[tariff.code].name} — annual site licence`
                : `Тариф «${tariff.name}» — лицензия на площадку на год`,
              url: `${origin}/stoimost/#plan-${tariff.code}`,
              price: tariff.pricePerYear,
              priceCurrency: "RUB",
              seller: ref(`${origin}/#organization`),
              description: en
                ? "Annual licence for one production site. Prices exclude VAT."
                : "Годовая лицензия на одну площадку. Цены без НДС.",
            })),
          }
        : {}),
      applicationCategory: facts.applicationCategory,
      operatingSystem: facts.desktop.operatingSystems,
      processorRequirements: facts.desktop.architecture,
      inLanguage: "ru",
      publisher: ref(`${origin}/#organization`),
      softwareHelp: {
        "@type": "CreativeWork",
        url: `${origin}${en ? "/en/instructions/" : "/instruktsii/"}`,
      },
      featureList: [
        copy.office,
        copy.station,
        en
          ? "Build cases and pallets in one aggregation shift, on a station or a handheld."
          : "Собирайте короба и паллеты в одной смене агрегации — на станции или ТСД.",
        en
          ? "The application and database run on your production PC without internet access"
          : "Программа и база на ПК производства, работа без интернета",
        en
          ? "Database backups stay on your own equipment"
          : "Резервные копии базы на оборудовании производства",
        en
          ? "Export shift results in TXT, CSV or XML for GIS MT and 1C"
          : "Выгрузки смены в TXT, CSV или XML для ГИС МТ и 1С",
      ],
    },
    {
      "@type": "SoftwareApplication",
      "@id": handheldId,
      name: en ? "Markiro Autonom — handheld application" : "Маркиро Автоном — приложение ТСД",
      description: copy.handheld.description,
      applicationCategory: facts.applicationCategory,
      operatingSystem: `Android ${facts.handheld.minimumAndroidVersion}+`,
      inLanguage: "ru",
      publisher: ref(`${origin}/#organization`),
      softwareRequirements: ref(softwareId),
      featureList: [
        copy.handheld.description,
        en
          ? "Cases and pallets in one aggregation shift"
          : "Короба и паллеты в одной смене агрегации",
        en
          ? "Separate application. Connects to the main PC over the local network."
          : "Отдельное приложение. Связь с главным ПК по локальной сети.",
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
      "@id": faqId,
      mainEntity: (en ? V4_HOME_FAQ_EN : V4_HOME_FAQ).map((f) => ({
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
