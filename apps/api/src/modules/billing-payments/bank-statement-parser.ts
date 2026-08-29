export interface ParsedBankStatementRow {
  sourceRowId: string;
  operationDate: Date | null;
  amount: string | null;
  currency: string;
  payerName: string | null;
  paymentPurpose: string | null;
  bankReference: string | null;
  payerAccount: string | null;
  rawFields: Record<string, string>;
  parseError: string | null;
}

export interface ParsedBankStatement {
  parserVersion: "bank-csv-v1" | "bank-1c-client-bank-exchange-v1";
  rows: ParsedBankStatementRow[];
}

export function parseBankStatement(content: string): ParsedBankStatement {
  const normalized = content.replace(/^\uFEFF/, "").trim();
  if (normalized.startsWith("1CClientBankExchange")) {
    return {
      parserVersion: "bank-1c-client-bank-exchange-v1",
      rows: parseOneCClientBankExchange(normalized),
    };
  }

  const rows = parseCsv(normalized);
  if (rows !== null) return { parserVersion: "bank-csv-v1", rows };
  throw new Error("payment_import_unsupported_format");
}

function parseCsv(content: string): ParsedBankStatementRow[] | null {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = (lines.shift() ?? "")
    .split(/[;,]/)
    .slice(0, 100)
    .map((value) => value.trim().toLowerCase().slice(0, 100));
  if (!header.some((key) => key === "amount" || key === "сумма")) return null;

  return lines.map((line, index) => {
    const values = line
      .split(/[;,]/)
      .slice(0, 100)
      .map((value) => value.trim().slice(0, 5_000));
    const get = (...names: string[]) =>
      values[header.findIndex((key) => names.includes(key))] ?? "";
    const amount = normalizeAmount(get("amount", "сумма"));
    const operationDateSource = get("date", "operation_date", "дата");
    const operationDate = parseDate(operationDateSource);
    return {
      sourceRowId: String(index + 1),
      operationDate,
      amount,
      currency: get("currency", "валюта").slice(0, 10) || "RUB",
      payerName: nullable(get("payer", "payer_name", "плательщик"), 1_000),
      paymentPurpose: nullable(get("purpose", "payment_purpose", "назначение"), 5_000),
      bankReference: nullable(get("reference", "bank_reference", "номер"), 1_000),
      payerAccount: nullable(
        get("payer_account", "account", "счет_плательщика", "счёт_плательщика"),
        100,
      ),
      rawFields: Object.fromEntries(
        header.map((key, column) => [key || `column_${column + 1}`, values[column] ?? ""]),
      ),
      parseError:
        amount && (!operationDateSource || operationDate) ? null : "invalid_amount_or_date",
    };
  });
}

function parseOneCClientBankExchange(content: string): ParsedBankStatementRow[] {
  const documents: Array<Record<string, string>> = [];
  let document: Record<string, string> | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("СекцияДокумент=")) {
      if (document) documents.push(document);
      document = { СекцияДокумент: line.slice(line.indexOf("=") + 1).slice(0, 5_000) };
      continue;
    }
    if (line === "КонецДокумента") {
      if (document) documents.push(document);
      document = null;
      continue;
    }
    if (!document) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().slice(0, 100);
    if (!key || Object.keys(document).length >= 100) continue;
    document[key] = line
      .slice(separator + 1)
      .trim()
      .slice(0, 5_000);
  }
  if (document) documents.push(document);
  if (documents.length === 0) throw new Error("payment_import_unsupported_format");

  return documents.map((fields, index) => {
    const amount = normalizeAmount(fields.Сумма ?? "");
    const operationDate = parseDate(fields.Дата ?? "");
    const number = nullable(fields.Номер ?? "", 1_000);
    return {
      sourceRowId: String(index + 1),
      operationDate,
      amount,
      currency: (fields.Валюта ?? "RUB").slice(0, 10),
      payerName: nullable(fields.Плательщик ?? fields.Плательщик1 ?? "", 1_000),
      paymentPurpose: nullable(fields.НазначениеПлатежа ?? "", 5_000),
      bankReference: number,
      payerAccount: nullable(
        fields.ПлательщикСчет ?? fields.ПлательщикСчёт ?? fields.ПлательщикРасчСчет ?? "",
        100,
      ),
      rawFields: fields,
      parseError: amount && operationDate ? null : "invalid_amount_or_date",
    };
  });
}

function normalizeAmount(value: string): string | null {
  const normalized = value.replaceAll(" ", "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const civil = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (civil) {
    const [, day, month, year] = civil;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return parsed.getUTCFullYear() === Number(year) &&
      parsed.getUTCMonth() === Number(month) - 1 &&
      parsed.getUTCDate() === Number(day)
      ? parsed
      : null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nullable(value: string, max: number): string | null {
  const normalized = value.trim().slice(0, max);
  return normalized || null;
}
