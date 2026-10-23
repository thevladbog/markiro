/**
 * English copy of the «Маркиро Автоном» home page (/en/). The download and pricing
 * pages exist in Russian only (spec 2026-10-20, open question О7), so every English
 * call to action leads to them and says so once, in `RU_PAGES_NOTE`.
 *
 * Facts follow the standalone code (`apps/standalone`) and `docs/standalone/ROADMAP.md`;
 * the Russian home (`autonom.ts`) sets the tone.
 */

import type { FaqEntry } from "./pages";
import type { TariffCode } from "./pricing";

export const RU_PAGES_NOTE = "The download and pricing pages are in Russian.";

/** The video-call request form at the bottom of the English home page. */
export const CALL_HREF_EN = "/en/#demo";

export const SITE_NAV_EN = [
  { href: "/en/#product", label: "Product" },
  { href: "/en/offline-production/", label: "Offline work" },
  { href: "/en/instructions/", label: "Instructions" },
  { href: "/en/articles/", label: "Articles" },
  { href: "/en/faq/", label: "Questions" },
] as const;

export const TRIAL_FACTS_EN = [
  "14 days, every feature",
  "Windows 10 and 11",
  "no payment or card",
] as const;

export const HOME_COPY_EN = {
  hero: {
    badge: "Markiro Autonom · for Windows",
    titleLight: ["Serialization", "and aggregation."],
    titleStrong: "All on your PC.",
    lead: "A station on the line checks every code before it goes into a case and builds cases and pallets with SSCC. The software, the database and the backups run on your own computers: a shift needs no internet.",
    download: "Download the trial",
    pricing: "Pricing from {price} RUB a year",
    screenAlt:
      "Station screen during a shift: open case 11 of 16, last scan accepted, pallet 3 of 8. The interface is in Russian.",
  },
  clients: {
    kicker: "Running on manufacturers' lines",
  },
  local: {
    kicker: "No cloud",
    title: "The software, the database and the backups stay at your plant.",
    lead: "The main PC in the office holds the database. Stations on the lines and handhelds in the warehouse connect to it over the plant's local network. If the internet goes down, the shift carries on, and the data on codes, cases and pallets stays at the plant.",
    networkLabel: "Plant local network",
    networkBadge: "no internet needed",
    diagramLabel:
      "Diagram: the main PC in the office, two stations on the lines and a handheld in the warehouse on the plant's local network",
    hub: { title: "Main PC · office", note: "database, backups, licence" },
    nodes: [
      { title: "Station", note: "line 1", icon: "scanner" },
      { title: "Station", note: "line 2", icon: "scanner" },
      { title: "Handheld", note: "warehouse", icon: "handheld" },
    ],
    screenAlt:
      "Station shift list without a link to the main PC: two shifts, the open one continues.",
    screenCaption:
      "A station without a link to the main PC: the open shift continues, and its records reach the main PC when the link returns.",
    facts: [
      {
        value: "0",
        text: "requests to Markiro servers during a shift. The licence and updates are loaded from a file.",
      },
      {
        value: "Hourly",
        text: "automatic backups of the database on the main PC while data changes, at least one a day, and one on demand.",
      },
      {
        value: "1 PC",
        text: "holds the database of every line at the plant. Stations and handhelds connect to it over the network; the plan sets the number of lines and workstations.",
      },
    ],
  },
  product: {
    kicker: "What it does",
    title: "Stations, handhelds and the office write to one journal.",
    lead: "Every error on screen comes with a reason and a next step. Everything stations and handhelds do is visible in the office.",
    station: {
      title: "Station on the line",
      text: "Scans every unit and rejects duplicates, foreign GTINs and partly read symbols. Builds the case, prints the SSCC label and keeps the pallet going.",
      tags: ["duplicate", "foreign GTIN", "case and pallet", "ZPL / TSPL"],
      alt: "Station screen: the last scan rejected as a duplicate, case 11 of 16.",
    },
    handheld: {
      title: "Handheld in the warehouse",
      text: "An Android handheld builds pallets, adds and removes cases and prints pallet labels in the same shift as the station.",
      alt: "Handheld screen: case 44, 11 of 16 accepted, the recent scans.",
    },
    office: {
      title: "Office",
      text: "Shifts, products, label templates, conflicts and backups. Exports for GIS MT are made on the same PC.",
      tags: ["output by day", "conflicts", "backups"],
      alt: "Office overview: output by day, lines, shifts and what needs attention.",
    },
    labels: {
      title: "Labels",
      text: "Stock case templates of 58×40, 75×120, 100×100 and 100×150 mm and pallet templates of 58×40, 75×120 and 100×150 mm. Preview and print are built from one layout.",
      boxAlt: "100×150 case label: 16 units per pack, production date, SSCC.",
      palletAlt: "100×150 pallet label: 8 cases, 128 units, GTIN, SSCC.",
    },
  },
  start: {
    kicker: "Getting started",
    title: "You can try it yourself. A contract is needed only to buy.",
    steps: [
      {
        title: "Download",
        text: "An installer for Windows 10 and 11. Fill in a short form and the link arrives by email.",
      },
      {
        title: "Install with demo data",
        text: "The setup wizard creates the organisation and the lines. With demo data you can run a shift without a scanner or a printer.",
      },
      {
        title: "Test it on your line",
        text: "Connect a scanner and a ZPL or TSPL printer. 14 days with every feature; if you need longer, we extend it.",
      },
      {
        title: "Buy a licence",
        text: "Pay the invoice for your plan and load the licence file in the office. Nothing is reinstalled and your data stays.",
      },
    ],
    requirementsTitle: "What you need",
    requirements: [
      {
        icon: "office",
        title: "Main PC",
        text: "Windows 10 or 11 and a fixed address on the plant network.",
      },
      {
        icon: "scanner",
        title: "Station at the line",
        text: "A Windows PC with a USB or COM scanner. On the Start plan it can be the main PC itself.",
      },
      {
        icon: "printer",
        title: "Label printer",
        text: "Any printer with ZPL or TSPL, such as Zebra or TSC.",
      },
      {
        icon: "handheld",
        title: "Handheld for the warehouse",
        text: "An Android 9 or later terminal with a scanner. It connects to the main PC over the plant network.",
      },
    ],
    callLink: "or walk through your line with us in a 30-minute video call",
  },
  pricing: {
    kicker: "Pricing",
    title: "A site licence, paid yearly. Every plan has every feature.",
    perYear: "RUB a year",
    onRequest: "On request",
    onRequestNote: "set by the number of lines and workstations",
    recommended: "Recommended",
    tryIt: "Try for 14 days",
    terms: [
      "Prices per site per year, VAT not applicable.",
      "Payment by invoice under a public offer.",
      "When you change plans, the unused balance is credited.",
      "After the term ends, the open shift continues and data and exports stay available.",
    ],
    allPrices: "All prices and worked examples",
  },
  people: {
    kicker: "Who is behind the product",
    title: "Who builds Markiro and what stays with you.",
    founder: {
      initials: "VB",
      name: "Vladislav Bogatyrev",
      role: "founder, development and support",
      text: "I write the software, answer questions and launch sites. I reply to email and Telegram myself, with no call centre in between.",
      promises: [
        "The software and the database sit on your PC. An open shift is never interrupted, even when the licence has ended.",
        "Exports and backups stay available after the licence ends.",
        "A perpetual licence is available on request.",
      ],
    },
    docs: {
      title: "Instructions and documents",
      text: "Open before you buy: you can read the documents and the terms before installing anything.",
      links: [
        { href: "/en/instructions/", label: "Operator and office instructions" },
        { href: "/en/legal/", label: "Legal documents" },
        { href: "/en/privacy/", label: "Processing policy" },
      ],
    },
  },
  faq: {
    kicker: "Questions",
    title: "What people ask before installing",
    more: "If your question is not here, write to Telegram",
    or: "or to",
  },
  final: {
    kicker: "14 days free, every feature",
    title: "Try Markiro on your own line.",
    call: "Walk through your line in 30 minutes",
  },
} as const;

/** The English names and terms of the four plans; prices come from `pricing.ts`. */
export const TARIFFS_EN: Readonly<
  Record<
    TariffCode,
    { readonly name: string; readonly audience: string; readonly features: readonly string[] }
  >
> = {
  start: {
    name: "Start",
    audience: "one line, one computer",
    features: ["1 line", "1 workstation", "2 office users", "reply within 2 working days"],
  },
  line: {
    name: "Line",
    audience: "a line and a warehouse with a handheld",
    features: [
      "1 line",
      "2 workstations: a station and a handheld",
      "3 office users",
      "reply the same working day",
      "extra workstations and lines on request",
    ],
  },
  workshop: {
    name: "Workshop",
    audience: "up to three lines",
    features: [
      "3 lines",
      "5 workstations",
      "10 office users",
      "your logo on labels and forms",
      "reply the same working day",
    ],
  },
  plant: {
    name: "Plant",
    audience: "four lines or more",
    features: ["lines and workstations by contract", "on-site launch", "support terms by contract"],
  },
};

export const HOME_FAQ_EN: readonly FaqEntry[] = [
  {
    question: "What happens after 14 days?",
    answer:
      "The open shift finishes, and data and exports stay available. New shifts will not open until a licence file is loaded.",
  },
  {
    question: "Is internet access needed?",
    answer:
      "Not for work. Stations and handhelds connect to the main PC over the local network, and the licence and updates are loaded from a file.",
  },
  {
    question: "Is the interface in English?",
    answer:
      "No. The software, its screens and the documents it prints are in Russian, for production lines in Russia.",
  },
  {
    question: "Can it move to another computer?",
    answer:
      "Yes. Our support restores the database from a backup on the new PC, the stations keep their pairing, and we reissue the licence file free of charge.",
  },
  {
    question: "Which equipment works?",
    answer:
      "USB and COM scanners, label printers with ZPL or TSPL, and Android handhelds. We check your list before you buy.",
  },
  {
    question: "How does a company pay?",
    answer:
      "By invoice under a public offer, yearly, in roubles. When you change plans, the unused balance is credited.",
  },
  {
    question: "Can you help with the installation?",
    answer:
      "One call during the trial is free. A remote launch costs 30 000 RUB, and an on-site launch costs 90 000 RUB plus travel.",
  },
];
