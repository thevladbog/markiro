import { Font, Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { join } from "node:path";
import type { PrintDocumentModel } from "./print-document-model";

Font.register({
  family: "IBM Plex Sans",
  fonts: [
    { src: join(__dirname, "assets/IBMPlexSans-Regular.ttf"), fontWeight: 400 },
    { src: join(__dirname, "assets/IBMPlexSans-SemiBold.ttf"), fontWeight: 600 },
  ],
});

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: "IBM Plex Sans", fontSize: 9, color: "#171717" },
  title: { fontSize: 18, marginBottom: 6 },
  meta: { color: "#555", marginBottom: 18 },
  profiles: { flexDirection: "row", gap: 20, marginBottom: 18 },
  profile: { flex: 1 },
  heading: { fontSize: 10, fontWeight: 700, marginBottom: 4 },
  profileText: { marginBottom: 2 },
  table: { width: "100%", borderWidth: 1, borderColor: "#aaa" },
  row: { flexDirection: "row", borderBottomWidth: 1, borderColor: "#aaa" },
  cell: { padding: 5, borderRightWidth: 1, borderColor: "#aaa" },
  number: { width: 25 },
  position: { flex: 1 },
  unit: { width: 60 },
  quantity: { width: 45 },
  price: { width: 70 },
  total: { width: 70 },
  totals: { alignSelf: "flex-end", width: 180, marginTop: 18 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  disclaimer: { marginTop: 6, fontWeight: 700 },
  terms: { marginTop: 20 },
  signatures: { flexDirection: "row", gap: 30, marginTop: 45 },
  signature: { flex: 1, borderTopWidth: 1, borderColor: "#777", paddingTop: 5, color: "#555" },
});

export async function renderPrintPdf(model: PrintDocumentModel): Promise<Buffer> {
  const title = model.kind === "invoice" ? "Счёт на оплату" : "Коммерческое предложение";
  const pdf = await renderToBuffer(
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>
          {title} № {model.number}
        </Text>
        <Text style={styles.meta}>
          Дата: {model.issuedOrPublishedAt.toISOString().slice(0, 10)}
        </Text>
        {model.kind === "offer" ? (
          <Text style={styles.disclaimer}>Не является счётом на оплату</Text>
        ) : null}
        <View style={styles.profiles}>
          <View style={styles.profile}>
            <Text style={styles.heading}>Поставщик</Text>
            <Text style={styles.profileText}>{String(model.seller.legalName ?? "")}</Text>
            <Text>{String(model.seller.taxId ?? "")}</Text>
          </View>
          <View style={styles.profile}>
            <Text style={styles.heading}>Покупатель</Text>
            <Text style={styles.profileText}>{String(model.buyer.legalName ?? "")}</Text>
            <Text>{String(model.buyer.taxId ?? "")}</Text>
          </View>
        </View>
        <View style={styles.table}>
          <View style={styles.row} fixed>
            <Text style={[styles.cell, styles.number]}>№</Text>
            <Text style={[styles.cell, styles.position]}>Позиция</Text>
            <Text style={[styles.cell, styles.unit]}>Ед.</Text>
            <Text style={[styles.cell, styles.quantity]}>Кол.</Text>
            <Text style={[styles.cell, styles.price]}>Цена</Text>
            <Text style={[styles.cell, styles.total]}>Сумма</Text>
          </View>
          {model.lines.map((line) => (
            <View style={styles.row} key={`${line.position}-${line.name}`}>
              <Text style={[styles.cell, styles.number]}>{line.position}</Text>
              <Text style={[styles.cell, styles.position]}>{line.name}</Text>
              <Text style={[styles.cell, styles.unit]}>{line.unit}</Text>
              <Text style={[styles.cell, styles.quantity]}>{line.quantity}</Text>
              <Text style={[styles.cell, styles.price]}>{line.unitPrice}</Text>
              <Text style={[styles.cell, styles.total]}>{line.lineTotal}</Text>
            </View>
          ))}
        </View>
        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text>Подытог</Text>
            <Text>{model.subtotal} ₽</Text>
          </View>
          <View style={styles.totalRow}>
            <Text>НДС</Text>
            <Text>{model.vatTotal} ₽</Text>
          </View>
          <View style={styles.totalRow}>
            <Text>Итого</Text>
            <Text>{model.total} ₽</Text>
          </View>
        </View>
        <View style={styles.signatures}>
          <Text style={styles.signature}>Поставщик / подпись</Text>
          <Text style={styles.signature}>Покупатель / подпись</Text>
        </View>
      </Page>
    </Document>,
  );
  if (pdf.byteLength > 10 * 1024 * 1024) throw new Error("print_document_too_large");
  return pdf;
}
