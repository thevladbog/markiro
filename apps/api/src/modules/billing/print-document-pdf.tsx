import {
  Document,
  Font,
  Image,
  Page,
  Path,
  Svg,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { renderCode128Svg, renderQrSvg } from "@markiro/domain";
import { join } from "node:path";
import sanitizeHtml from "sanitize-html";
import sharp from "sharp";
import {
  amountInWords,
  documentBarcodeValue,
  documentKindLabel,
  documentSubject,
  formatMoney,
  formatPrintDate,
  formatPrintDateTime,
  paginatePrintLines,
  paymentPurpose,
  paymentQrPayload,
  profileIdentity,
} from "./print-document-layout";
import type { BillingProfileSnapshot, PrintDocumentModel, PrintLine } from "./print-document-model";

Font.register({
  family: "IBM Plex Sans",
  fonts: [
    { src: join(__dirname, "assets/IBMPlexSans-Regular.ttf"), fontWeight: 400 },
    { src: join(__dirname, "assets/IBMPlexSans-SemiBold.ttf"), fontWeight: 600 },
  ],
});

const colors = {
  ink: "#181a18",
  green: "#2f6d50",
  lime: "#8fbb62",
  muted: "#747a72",
  rule: "#c1c4bc",
  paperTint: "#fafaf8",
  fill: "#f0f1ed",
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingHorizontal: 32,
    paddingBottom: 45,
    fontFamily: "IBM Plex Sans",
    fontSize: 8.5,
    color: colors.ink,
  },
  header: {
    height: 47,
    borderBottomWidth: 0.7,
    borderBottomColor: colors.rule,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 6 },
  brandMark: {
    width: 20,
    height: 20,
    padding: 3,
    backgroundColor: colors.green,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 2,
  },
  brandPixel: { width: 6, height: 6, backgroundColor: "#ffffff" },
  brandPixelAccent: { width: 6, height: 6, backgroundColor: colors.lime },
  brandText: { fontSize: 17, fontWeight: 600, letterSpacing: -0.5 },
  documentId: { alignItems: "flex-end", gap: 4 },
  documentKind: { fontSize: 7.5, fontWeight: 600, letterSpacing: 1, color: "#565b54" },
  mono: { fontFamily: "IBM Plex Sans", letterSpacing: 0.45 },
  body: { paddingTop: 18 },
  subject: { fontSize: 20, fontWeight: 600, lineHeight: 1.05, maxWidth: 390 },
  meta: { marginTop: 5, marginBottom: 11, color: colors.muted },
  sectionLabel: { fontSize: 7, fontWeight: 600, letterSpacing: 0.9, color: "#565b54" },
  bank: {
    minHeight: 108,
    borderWidth: 0.7,
    borderColor: colors.rule,
    backgroundColor: colors.paperTint,
    padding: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  bankWithoutQr: { minHeight: 74 },
  bankMain: { flex: 1.35, gap: 3 },
  bankAccount: { flex: 1, gap: 3 },
  bankName: { fontSize: 7.5 },
  legalName: { fontSize: 9.5, fontWeight: 600 },
  account: { fontSize: 10.5, fontWeight: 600, letterSpacing: 0.7 },
  muted: { color: colors.muted },
  qr: { width: 99.2, height: 99.2, backgroundColor: "#ffffff" },
  parties: { flexDirection: "row", gap: 20, marginTop: 10, marginBottom: 9 },
  party: {
    flex: 1,
    minHeight: 49,
    borderTopWidth: 0.7,
    borderTopColor: colors.rule,
    paddingTop: 6,
  },
  partyName: { fontSize: 9, fontWeight: 600, marginTop: 4, marginBottom: 3 },
  partyAddress: { marginTop: 3, color: "#535750", lineHeight: 1.2 },
  itemsHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 5,
    marginBottom: 6,
  },
  table: { width: "100%", borderTopWidth: 0.7, borderLeftWidth: 0.7, borderColor: colors.rule },
  row: { flexDirection: "row", borderBottomWidth: 0.7, borderBottomColor: colors.rule },
  tableHeader: { backgroundColor: colors.fill, minHeight: 19 },
  cell: {
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderRightWidth: 0.7,
    borderRightColor: colors.rule,
  },
  headerCell: { fontSize: 6.2, letterSpacing: 0.5, color: "#585d56", fontWeight: 600 },
  number: { width: 22 },
  position: { flex: 1 },
  unit: { width: 48 },
  quantity: { width: 43, textAlign: "right" },
  price: { width: 70, textAlign: "right" },
  total: { width: 73, textAlign: "right" },
  positionName: { fontSize: 8.2, fontWeight: 600 },
  positionDescription: { marginTop: 3, color: colors.muted, fontSize: 6.7, lineHeight: 1.25 },
  totals: { alignSelf: "flex-end", width: 226, marginTop: 11 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3.5 },
  grandTotal: {
    borderTopWidth: 1.2,
    borderTopColor: colors.green,
    marginTop: 3,
    paddingTop: 6,
    fontSize: 12,
    fontWeight: 600,
  },
  grandTotalValue: { color: colors.green },
  amountWords: { marginTop: 4, fontSize: 7, lineHeight: 1.2, color: "#5e635c" },
  noteSection: { marginTop: 11, borderTopWidth: 0.7, borderTopColor: colors.rule, paddingTop: 6 },
  noteText: { marginTop: 4, lineHeight: 1.35 },
  offerNotice: {
    alignSelf: "flex-start",
    marginTop: 9,
    paddingVertical: 4,
    paddingHorizontal: 6,
    backgroundColor: "#eef4eb",
    color: colors.green,
    fontWeight: 600,
  },
  signing: { flexDirection: "row", alignItems: "flex-end", gap: 36, marginTop: 14 },
  signature: { flex: 1 },
  signatureLine: { marginTop: 23 },
  signatureHint: { fontSize: 6.5, color: colors.muted, marginTop: 3 },
  stamp: {
    width: 88,
    height: 88,
    borderWidth: 0.8,
    borderStyle: "dashed",
    borderColor: "#a9ada5",
    backgroundColor: "#f2f3f0",
    alignItems: "center",
    justifyContent: "center",
  },
  stampText: { fontSize: 6.3, letterSpacing: 0.55, color: "#9a9e97" },
  footer: {
    position: "absolute",
    left: 32,
    right: 32,
    bottom: 20,
    height: 23,
    borderTopWidth: 0.7,
    borderTopColor: colors.rule,
    paddingTop: 5,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  barcode: { width: 148, height: 17 },
  footerText: { fontSize: 6.2, color: colors.muted },
});

async function svgDataUri(svg: string, width: number): Promise<string> {
  const png = await sharp(Buffer.from(svg), { density: 600 }).resize({ width }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

type QrVector = { viewBox: string; path: string };

function qrVector(svg: string): QrVector {
  const match = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"[\s\S]*?<path d="([^"]+)"/);
  if (!match) throw new Error("payment_qr_render_failed");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const quietZone = 24;
  return {
    viewBox: `${-quietZone} ${-quietZone} ${width + quietZone * 2} ${height + quietZone * 2}`,
    path: match[3] ?? "",
  };
}

function termsText(value: string): string {
  return sanitizeHtml(value.replace(/<\/(?:p|li)>/gi, "$&\n"), {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .trim();
}

function Header({
  model,
  page,
  totalPages,
}: {
  model: PrintDocumentModel;
  page: number;
  totalPages: number;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.brand}>
        <View style={styles.brandMark}>
          <View style={styles.brandPixel} />
          <View style={styles.brandPixel} />
          <View style={styles.brandPixel} />
          <View style={styles.brandPixelAccent} />
        </View>
        <Text style={styles.brandText}>markiro</Text>
      </View>
      <View style={styles.documentId}>
        <Text style={styles.documentKind}>{documentKindLabel(model)}</Text>
        <Text style={styles.mono}>
          № {model.number} · {formatPrintDate(model.issuedOrPublishedAt)}
          {totalPages > 1 ? ` · Лист ${page} из ${totalPages}` : ""}
        </Text>
      </View>
    </View>
  );
}

function Footer({ model, barcode }: { model: PrintDocumentModel; barcode: string }) {
  return (
    <View style={styles.footer} fixed>
      <Image style={styles.barcode} src={barcode} />
      <Text style={styles.footerText}>
        Сформировано системой Markiro · {formatPrintDateTime(model.issuedOrPublishedAt)}
      </Text>
    </View>
  );
}

function Bank({ model, qr }: { model: PrintDocumentModel; qr: QrVector | null }) {
  const seller = model.seller;
  return (
    <View style={qr ? styles.bank : [styles.bank, styles.bankWithoutQr]}>
      <View style={styles.bankMain}>
        <Text style={styles.sectionLabel}>БАНКОВСКИЕ РЕКВИЗИТЫ</Text>
        <Text style={styles.muted}>Получатель</Text>
        <Text style={styles.legalName}>{String(seller.legalName ?? "")}</Text>
        <Text style={styles.mono}>
          {seller.taxId ? `ИНН ${seller.taxId}` : ""}
          {seller.kpp ? ` · КПП ${seller.kpp}` : ""}
        </Text>
        <Text style={styles.mono}>
          {seller.bic ? `БИК ${seller.bic}` : ""}
          {seller.correspondentAccount ? ` · к/с ${seller.correspondentAccount}` : ""}
        </Text>
      </View>
      <View style={styles.bankAccount}>
        <Text style={styles.muted}>Расчётный счёт</Text>
        <Text style={styles.account}>{String(seller.bankAccount ?? "")}</Text>
        <Text style={styles.bankName}>{String(seller.bankName ?? "")}</Text>
        <Text style={[styles.mono, styles.muted]}>Валюта: {String(seller.currency ?? "RUB")}</Text>
      </View>
      {qr ? (
        <Svg style={styles.qr} viewBox={qr.viewBox}>
          <Path d={qr.path} fill="#000000" />
        </Svg>
      ) : null}
    </View>
  );
}

function Party({ label, profile }: { label: string; profile: BillingProfileSnapshot }) {
  return (
    <View style={styles.party}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <Text style={styles.partyName}>{String(profile.legalName ?? "")}</Text>
      <Text style={[styles.mono, styles.muted]}>{profileIdentity(profile)}</Text>
      {profile.address ? <Text style={styles.partyAddress}>{profile.address}</Text> : null}
    </View>
  );
}

function LinesTable({ lines }: { lines: PrintLine[] }) {
  return (
    <View style={styles.table}>
      <View style={[styles.row, styles.tableHeader]}>
        <Text style={[styles.cell, styles.headerCell, styles.number]}>№</Text>
        <Text style={[styles.cell, styles.headerCell, styles.position]}>ПОЗИЦИЯ</Text>
        <Text style={[styles.cell, styles.headerCell, styles.unit]}>ЕД.</Text>
        <Text style={[styles.cell, styles.headerCell, styles.quantity]}>КОЛ-ВО</Text>
        <Text style={[styles.cell, styles.headerCell, styles.price]}>ЦЕНА</Text>
        <Text style={[styles.cell, styles.headerCell, styles.total]}>СУММА</Text>
      </View>
      {lines.map((line) => (
        <View style={styles.row} key={`${line.position}-${line.name}`}>
          <Text style={[styles.cell, styles.mono, styles.number]}>{line.position}</Text>
          <View style={[styles.cell, styles.position]}>
            <Text style={styles.positionName}>{line.name}</Text>
            {line.description ? (
              <Text style={styles.positionDescription}>{line.description}</Text>
            ) : null}
          </View>
          <Text style={[styles.cell, styles.unit]}>{line.unit}</Text>
          <Text style={[styles.cell, styles.mono, styles.quantity]}>{line.quantity}</Text>
          <Text style={[styles.cell, styles.mono, styles.price]}>
            {formatMoney(line.unitPrice)}
          </Text>
          <Text style={[styles.cell, styles.mono, styles.total]}>
            {formatMoney(line.lineTotal)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Closing({ model }: { model: PrintDocumentModel }) {
  return (
    <>
      <View style={styles.totals}>
        <View style={styles.totalRow}>
          <Text>Подытог</Text>
          <Text style={styles.mono}>{formatMoney(model.subtotal)}</Text>
        </View>
        <View style={styles.totalRow}>
          <Text>НДС</Text>
          <Text style={styles.mono}>{formatMoney(model.vatTotal)}</Text>
        </View>
        <View style={[styles.totalRow, styles.grandTotal]}>
          <Text>ИТОГО</Text>
          <Text style={[styles.mono, styles.grandTotalValue]}>{formatMoney(model.total)}</Text>
        </View>
        <Text style={styles.amountWords}>{amountInWords(model.total)}</Text>
      </View>
      {model.kind === "offer" && model.termsHtml ? (
        <View style={styles.noteSection}>
          <Text style={styles.sectionLabel}>УСЛОВИЯ СОТРУДНИЧЕСТВА</Text>
          <Text style={styles.noteText}>{termsText(model.termsHtml)}</Text>
        </View>
      ) : null}
      {model.kind === "invoice" ? (
        <View style={styles.noteSection}>
          <Text style={styles.sectionLabel}>НАЗНАЧЕНИЕ ПЛАТЕЖА</Text>
          <Text style={styles.noteText}>{paymentPurpose(model)}</Text>
        </View>
      ) : (
        <Text style={styles.offerNotice}>Не является счётом на оплату</Text>
      )}
      <View style={styles.signing}>
        <View style={styles.signature}>
          <Text style={styles.sectionLabel}>ПОСТАВЩИК</Text>
          <Text style={styles.signatureLine}>________________ / ____________________</Text>
          <Text style={styles.signatureHint}>подпись / расшифровка</Text>
        </View>
        <View style={styles.stamp}>
          <Text style={styles.stampText}>МЕСТО ДЛЯ ПЕЧАТИ</Text>
        </View>
      </View>
    </>
  );
}

export async function renderPrintPdf(model: PrintDocumentModel): Promise<Buffer> {
  const qrPayload = paymentQrPayload(model);
  const qr = qrPayload ? qrVector(renderQrSvg(qrPayload)) : null;
  const barcode = await svgDataUri(
    renderCode128Svg(documentBarcodeValue(model), {
      includeText: false,
    }),
    900,
  );
  const pages = paginatePrintLines(model.lines);
  const pdf = await renderToBuffer(
    <Document title={`${documentKindLabel(model)} № ${model.number}`}>
      {pages.map((lines, index) => {
        const first = index === 0;
        const last = index === pages.length - 1;
        return (
          <Page key={`${model.number}-${index + 1}`} size="A4" style={styles.page}>
            <Header model={model} page={index + 1} totalPages={pages.length} />
            <View style={styles.body}>
              {first ? (
                <>
                  <Text style={styles.subject}>{documentSubject(model)}</Text>
                  <Text style={styles.meta}>
                    {model.kind === "invoice" ? "от" : "от"}{" "}
                    {formatPrintDate(model.issuedOrPublishedAt)} ·{" "}
                    {model.kind === "invoice" ? "оплатить до" : "действительно до"}{" "}
                    {formatPrintDate(model.dueOrExpiresAt)}
                  </Text>
                  <Bank model={model} qr={qr} />
                  <View style={styles.parties}>
                    <Party label="ПОСТАВЩИК" profile={model.seller} />
                    <Party label="ПОКУПАТЕЛЬ" profile={model.buyer} />
                  </View>
                </>
              ) : null}
              <View style={styles.itemsHeading}>
                <Text style={styles.sectionLabel}>
                  СОСТАВ {model.kind === "invoice" ? "СЧЁТА" : "ПРЕДЛОЖЕНИЯ"}
                </Text>
                <Text style={[styles.mono, styles.muted]}>{model.lines.length} поз.</Text>
              </View>
              <LinesTable lines={lines} />
              {last ? <Closing model={model} /> : null}
            </View>
            <Footer model={model} barcode={barcode} />
          </Page>
        );
      })}
    </Document>,
  );
  if (pdf.byteLength > 10 * 1024 * 1024) throw new Error("print_document_too_large");
  return pdf;
}
