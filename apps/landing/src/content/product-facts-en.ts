/** English V4 copy; the application interface remains Russian. */
export const PRODUCT_FACTS_EN = {
  name: "Markiro Autonom",
  heading: "Aggregation software for manually packed products",
  description:
    "For small and medium manufacturers in Russia that pack by hand. Check Chestny ZNAK codes, aggregate cases and pallets, and print SSCC labels.",
  handheld: {
    heading: "Packing and aggregation on a handheld",
    description:
      "Check codes, build cases and pallets, and print labels — the same operations as the station.",
    connection: "Android 9+. Connects to the main PC over your local network.",
  },
  office: "Office on PC: shifts, products and production results.",
  station: "Station: code checks, case and pallet aggregation, and SSCC label printing.",
  seats: "One workstation means one station or one handheld. Office users are counted separately.",
  softwareDescription:
    "Windows software for aggregating marking codes. The office manages shifts and products; the station handles packing and aggregation. The main PC, office and station are roles in one installer. Try every feature for 14 days without payment.",
} as const;

export const V4_HOME_FAQ_EN = [
  {
    question: "Will it suit my production site?",
    answer:
      "Markiro is designed for small and medium manufacturers that pack products by hand. Before you start, we will check your product category and workflow with you.",
  },
  {
    question: "Do I need a separate server?",
    answer:
      "The main PC, office and station can run on one Windows 10/11 x64 computer. Additional stations and handhelds connect over the local network. The main PC must stay on while they are in use.",
  },
  {
    question: "How do I transfer data to GIS MT and 1C?",
    answer:
      "Export shift results in TXT, CSV or XML and transfer the files to GIS MT or 1C. Markiro prepares the files; submitting the report to GIS MT is a separate step.",
  },
  {
    question: "What happens when the licence expires?",
    answer:
      "An open shift can finish, and data and exports remain available. Load a new licence file to open new shifts.",
  },
  {
    question: "Is the application available in English?",
    answer:
      "The application interface and printed documents are in Russian. This page describes the product for manufacturing sites in Russia; the download and pricing pages are also in Russian.",
  },
] as const;
