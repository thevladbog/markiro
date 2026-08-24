import type { BillingProfileSnapshot, PrintDocumentModel } from "./print-document-model";

export function formatPrintDate(value: Date | null): string {
  return value
    ? new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "Europe/Moscow",
      }).format(value)
    : "—";
}

export function formatPrintDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Moscow",
  })
    .format(value)
    .replace(",", "");
}

export function formatMoney(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ₽`;
  return `${new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)} ₽`;
}

export function documentKindLabel(model: PrintDocumentModel): string {
  return model.kind === "invoice" ? "СЧЁТ НА ОПЛАТУ" : "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ";
}

export function documentBarcodeValue(model: PrintDocumentModel): string {
  const number = /^[\x20-\x7e]+$/.test(model.number)
    ? model.number
    : Buffer.from(model.number, "utf8").toString("base64url");
  return `${model.kind === "invoice" ? "INV" : "OFR"}-${number}`;
}

export function documentSubject(model: PrintDocumentModel): string {
  if (model.lines.length === 0) return "Услуги платформы Markiro";
  return "Лицензия и услуги платформы Markiro";
}

export function paymentPurpose(model: PrintDocumentModel): string {
  const vat = Number(model.vatTotal);
  const vatText =
    Number.isFinite(vat) && vat > 0
      ? `В том числе НДС ${formatMoney(model.vatTotal)}.`
      : "Без НДС.";
  return `Оплата по счёту № ${model.number} от ${formatPrintDate(model.issuedOrPublishedAt)}. ${vatText}`;
}

function qrField(name: string, value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? `${name}=${value}` : null;
}

export function paymentQrPayload(model: PrintDocumentModel): string | null {
  if (model.kind !== "invoice") return null;
  const seller = model.seller;
  if (
    !seller.legalName ||
    !seller.bankAccount ||
    !seller.bankName ||
    !seller.bic ||
    !seller.correspondentAccount
  ) {
    return null;
  }
  const kopecks = Math.round(Number(model.total) * 100);
  if (!Number.isFinite(kopecks) || kopecks < 0) return null;
  const fields = [
    qrField("Name", seller.legalName),
    qrField("PersonalAcc", seller.bankAccount),
    qrField("BankName", seller.bankName),
    qrField("BIC", seller.bic),
    qrField("CorrespAcc", seller.correspondentAccount),
    qrField("PayeeINN", seller.taxId),
    qrField("KPP", seller.kpp),
    `Sum=${kopecks}`,
    qrField("Purpose", paymentPurpose(model)),
  ].filter((field): field is string => field !== null);
  const delimiter = ["|", "#", ";", ":", "^", "~"].find((candidate) =>
    fields.every((field) => !field.includes(candidate)),
  );
  return delimiter ? `ST00012${delimiter}${fields.join(delimiter)}` : null;
}

const hundreds = [
  "",
  "сто",
  "двести",
  "триста",
  "четыреста",
  "пятьсот",
  "шестьсот",
  "семьсот",
  "восемьсот",
  "девятьсот",
];
const tens = [
  "",
  "",
  "двадцать",
  "тридцать",
  "сорок",
  "пятьдесят",
  "шестьдесят",
  "семьдесят",
  "восемьдесят",
  "девяносто",
];
const teens = [
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
];
const onesMale = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const onesFemale = [
  "",
  "одна",
  "две",
  "три",
  "четыре",
  "пять",
  "шесть",
  "семь",
  "восемь",
  "девять",
];

function plural(value: number, forms: readonly [string, string, string]): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 19) return forms[2];
  const mod10 = value % 10;
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function tripletWords(value: number, female: boolean): string[] {
  const words: string[] = [];
  const hundred = Math.floor(value / 100);
  const rest = value % 100;
  if (hundred > 0) words.push(hundreds[hundred] ?? "");
  if (rest >= 10 && rest < 20) {
    words.push(teens[rest - 10] ?? "");
  } else {
    const ten = Math.floor(rest / 10);
    const one = rest % 10;
    if (ten > 0) words.push(tens[ten] ?? "");
    if (one > 0) words.push((female ? onesFemale : onesMale)[one] ?? "");
  }
  return words.filter(Boolean);
}

export function amountInWords(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return formatMoney(value);
  const rounded = Math.round(numeric * 100);
  let rubles = Math.floor(rounded / 100);
  const kopecks = rounded % 100;
  const groups = [
    {
      divisor: 1_000_000_000,
      forms: ["миллиард", "миллиарда", "миллиардов"] as const,
      female: false,
    },
    { divisor: 1_000_000, forms: ["миллион", "миллиона", "миллионов"] as const, female: false },
    { divisor: 1_000, forms: ["тысяча", "тысячи", "тысяч"] as const, female: true },
  ];
  const words: string[] = [];
  for (const group of groups) {
    const part = Math.floor(rubles / group.divisor);
    if (part > 0) {
      words.push(...tripletWords(part, group.female), plural(part, group.forms));
      rubles %= group.divisor;
    }
  }
  if (rubles > 0) words.push(...tripletWords(rubles, false));
  if (words.length === 0) words.push("ноль");
  const fullRubles = Math.floor(rounded / 100);
  const text = `${words.join(" ")} ${plural(fullRubles, ["рубль", "рубля", "рублей"])} ${String(kopecks).padStart(2, "0")} ${plural(kopecks, ["копейка", "копейки", "копеек"])}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function profileIdentity(profile: BillingProfileSnapshot): string {
  return [
    profile.taxId ? `ИНН ${profile.taxId}` : null,
    profile.kpp ? `КПП ${profile.kpp}` : null,
    profile.registrationId ? `ОГРН ${profile.registrationId}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
