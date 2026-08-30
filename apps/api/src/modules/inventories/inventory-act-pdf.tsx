import {
  Document,
  Font,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import {
  inventoryDocumentFilenamePrefix,
  renderCode128Svg,
  selectEligibleInventoryFinalBoxes,
  type InventoryChzStatus,
  type InventoryDocumentGeneratedPart,
  type InventoryDocumentGenerationMetadata,
} from "@markiro/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

import type { InventoryResultSource } from "./inventory-result-source.service";

const assetsPath = join(__dirname, "../billing/assets");
const logoSvg = readFileSync(join(assetsPath, "markiro-logo-on-light.svg"), "utf8");

Font.register({
  family: "IBM Plex Sans",
  fonts: [
    { src: join(assetsPath, "IBMPlexSans-Regular.ttf"), fontWeight: 400 },
    { src: join(assetsPath, "IBMPlexSans-SemiBold.ttf"), fontWeight: 600 },
  ],
});

const STATUS_LABELS: Readonly<Record<InventoryChzStatus, string>> = {
  EMITTED: "Эмитирован",
  INTRODUCED: "В обороте",
  APPLIED: "Нанесён",
  RETIRED: "Выбыл",
  WRITTEN_OFF: "Списан",
  DISAGGREGATION: "Расформирован",
};

const OTHER_STATUS_ORDER: readonly InventoryChzStatus[] = [
  "EMITTED",
  "APPLIED",
  "RETIRED",
  "WRITTEN_OFF",
  "DISAGGREGATION",
];

export interface InventoryActStatusRow {
  label: string;
  code: string;
  total: number;
  checked: number;
  result: string;
}

export interface InventoryActViewModel {
  inventoryNumber: string;
  documentDate: string;
  organizationName: string;
  organizationInn: string;
  productName: string;
  gtin14: string;
  lineName: string;
  mode: string;
  productionDateRange: string;
  startedAt: string;
  closedAt: string;
  closeType: string;
  snapshot: string;
  expectedCount: number;
  verifiedCount: number;
  missingCount: number;
  verifiedPercent: string;
  protectedCount: number;
  ineligibleCount: number;
  unknownCount: number;
  statusRows: InventoryActStatusRow[];
  packageSummary: string;
  boxCount: number;
  barcodeValue: string;
  signatures: readonly string[];
}

export function buildInventoryActViewModel(
  source: InventoryResultSource,
  metadata: InventoryDocumentGenerationMetadata,
): InventoryActViewModel {
  const expectedCount = source.expected.length;
  const verifiedCount = source.verified.length;
  const protectedCount = source.protected.length;
  const protectedChecked = source.protected.filter((code) => code.found).length;
  const ineligibleFound = source.ineligible.filter((code) => code.found);
  const unknownCount = source.unknown.filter((code) => code.found).length;
  const missingCount = source.writeOffCandidates.filter(
    (candidate) => !source.protected.some((code) => code.codeHash === candidate.codeHash),
  ).length;
  const statusRows: InventoryActStatusRow[] = [
    {
      label: STATUS_LABELS.INTRODUCED,
      code: "INTRODUCED",
      total: expectedCount,
      checked: verifiedCount,
      result: signedDifference(verifiedCount - expectedCount),
    },
  ];
  if (protectedCount > 0) {
    statusRows.push({
      label: "В отгрузке",
      code: "MOVING_BY_UD",
      total: protectedCount,
      checked: protectedChecked,
      result: "исключено",
    });
  }
  for (const status of OTHER_STATUS_ORDER) {
    const total = source.operation.statusCounts[status];
    if (total === 0) continue;
    statusRows.push({
      label: STATUS_LABELS[status],
      code: status,
      total,
      checked: ineligibleFound.filter((code) => code.sourceStatus === status).length,
      result: "не учитывается",
    });
  }

  const finalBoxes = selectEligibleInventoryFinalBoxes(source);
  const verifiedParentBoxes = new Set(
    source.verified.flatMap((code) => (code.parentSscc === null ? [] : [code.parentSscc])),
  );
  const packageSummary =
    source.operation.mode === "repack"
      ? `Старых коробов отсканировано: ${source.oldBoxes.length} · Итоговых коробов: ${finalBoxes.length} · Кодов в итоговых коробах: ${finalBoxes.reduce((sum, box) => sum + box.codes.length, 0)}`
      : `Коробов в подтверждённом остатке: ${verifiedParentBoxes.size} · Кодов в коробах: ${source.verified.filter((code) => code.parentSscc !== null).length}`;

  return {
    inventoryNumber: metadata.inventoryNumber,
    documentDate: formatDate(metadata.operationDateTime),
    organizationName: metadata.organizationName,
    organizationInn: metadata.organizationInn,
    productName: source.operation.productName,
    gtin14: source.operation.gtin14,
    lineName: source.operation.lineName,
    mode: source.operation.mode === "repack" ? "С переупаковкой" : "Без переупаковки",
    productionDateRange: `${formatCivilDate(source.operation.productionDateFrom)} — ${formatCivilDate(source.operation.productionDateTo)}`,
    startedAt: formatDateTime(source.operation.startedAt),
    closedAt: formatDateTime(source.operation.closedAt),
    closeType:
      source.operation.emergencyCloseReason === null
        ? "Штатное"
        : `Аварийное: ${source.operation.emergencyCloseReason}`,
    snapshot: `${formatDateTime(source.operation.snapshotFixedAt)} · ревизия ${source.operation.snapshotRevision}`,
    expectedCount,
    verifiedCount,
    missingCount,
    verifiedPercent:
      expectedCount === 0
        ? "—"
        : `${((verifiedCount / expectedCount) * 100).toFixed(1).replace(".", ",")} %`,
    protectedCount,
    ineligibleCount: ineligibleFound.length,
    unknownCount,
    statusRows,
    packageSummary,
    boxCount: source.operation.mode === "repack" ? finalBoxes.length : verifiedParentBoxes.size,
    barcodeValue: metadata.inventoryNumber,
    signatures: [
      "Председатель комиссии",
      "Член комиссии",
      "Член комиссии",
      "Материально ответственное лицо",
    ],
  };
}

export async function generateInventoryActPdf(
  source: InventoryResultSource,
  metadata: InventoryDocumentGenerationMetadata,
): Promise<InventoryDocumentGeneratedPart[]> {
  const model = buildInventoryActViewModel(source, metadata);
  const [logo, barcode] = await Promise.all([
    svgDataUri(logoSvg, 1120),
    svgDataUri(renderCode128Svg(model.barcodeValue, { includeText: false }), 900),
  ]);
  const timestamp = new Date(metadata.fileDateTime);
  const pdf = await renderToBuffer(
    <Document
      title={`Акт об инвентаризации № ${model.inventoryNumber}`}
      creationDate={timestamp}
      modificationDate={timestamp}
    >
      <Page size="A4" style={styles.page} wrap={false}>
        <View style={styles.headerRule} />
        <Image style={styles.logo} src={logo} cache={false} />
        <Text style={styles.documentKind}>АКТ ОБ ИНВЕНТАРИЗАЦИИ</Text>
        <Text style={styles.documentMeta}>
          № {model.inventoryNumber} · {model.documentDate}
        </Text>

        <SectionLabel>ОБЪЕКТ И ПАРАМЕТРЫ</SectionLabel>
        <ParameterRow
          label="Организация"
          value={model.organizationName}
          right={`ИНН ${model.organizationInn}`}
        />
        <ParameterRow label="Продукция" value={model.productName} />
        <View style={styles.twoColumns}>
          <Parameter label="GTIN" value={model.gtin14} />
          <Parameter label="Линия" value={model.lineName} />
          <Parameter label="Способ" value={model.mode} />
        </View>
        <View style={styles.twoColumns}>
          <Parameter label="Даты производства" value={model.productionDateRange} wide />
          <Parameter label="Начата" value={model.startedAt} />
          <Parameter label="Закрыта" value={model.closedAt} />
        </View>
        <View style={styles.twoColumns}>
          <Parameter label="Тип закрытия" value={model.closeType} wide />
          <Parameter label="Снимок ЧЗ" value={model.snapshot} wide />
        </View>

        <SectionLabel>ИТОГ ИНВЕНТАРИЗАЦИИ</SectionLabel>
        <View style={styles.metrics}>
          <Metric value={model.expectedCount} label="ожидалось" />
          <Metric value={model.verifiedCount} label="подтверждено" accent />
          <Metric value={model.missingCount} label="не обнаружено" />
          <Metric value={model.verifiedPercent} label="подтверждено" last />
        </View>
        <Text style={styles.resultNote}>
          <Text style={styles.semibold}>Расхождение: {formatCount(model.missingCount)}.</Text> Не
          обнаруженные коды являются кандидатами на списание, а не фактом списания.
        </Text>

        <SectionLabel>РЕЗУЛЬТАТЫ И РЕШЕНИЯ</SectionLabel>
        <ResultTable model={model} />

        <SectionLabel>СТАТУСЫ ЧЕСТНОГО ЗНАКА</SectionLabel>
        <StatusTable rows={model.statusRows} />

        <SectionLabel>УПАКОВКИ</SectionLabel>
        <Text style={styles.packageSummary}>{model.packageSummary}</Text>

        <SectionLabel>ЗАКЛЮЧЕНИЕ КОМИССИИ</SectionLabel>
        <Text style={styles.conclusion}>
          Фактическое наличие сопоставлено с зафиксированным снимком. Перечни кодов и сформированные
          документы являются приложениями к настоящему акту.
        </Text>
        <View style={styles.signatures}>
          <View style={styles.signatureList}>
            {model.signatures.map((label, index) => (
              <SignatureRow key={`${label}-${index}`} label={label} />
            ))}
          </View>
          <View style={styles.stamp}>
            <Text style={styles.stampText}>М. П.</Text>
          </View>
        </View>

        <View style={styles.footer}>
          <View>
            <Image style={styles.barcode} src={barcode} cache={false} />
            <Text style={styles.barcodeCaption}>{model.barcodeValue}</Text>
          </View>
          <View style={styles.footerMeta}>
            <Text>Сформировано в Markiro · ревизия результата {source.resultRevision}</Text>
            <Text>Страница 1 из 1</Text>
          </View>
        </View>
      </Page>
    </Document>,
  );

  return [
    {
      partNumber: 1,
      filename: `${inventoryDocumentFilenamePrefix(metadata.inventoryNumber)}-act.pdf`,
      mimeType: "application/pdf",
      bytes: new Uint8Array(pdf),
      rowCount: 1,
      codeCount: model.expectedCount,
      boxCount: model.boxCount,
    },
  ];
}

const colors = {
  ink: "#181a18",
  green: "#2f6d50",
  muted: "#727870",
  rule: "#c9cdc6",
  strong: "#92998f",
  fill: "#f0f1ee",
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 88,
    paddingHorizontal: 32,
    paddingBottom: 58,
    backgroundColor: "#ffffff",
    color: colors.ink,
    fontFamily: "IBM Plex Sans",
    fontSize: 7.6,
  },
  headerRule: {
    position: "absolute",
    top: 28,
    left: 32,
    right: 32,
    height: 47,
    borderBottomWidth: 0.7,
    borderBottomColor: colors.strong,
  },
  logo: { position: "absolute", top: 28, left: 32, width: 113.4, height: 25.9 },
  documentKind: {
    position: "absolute",
    top: 28,
    right: 32,
    fontSize: 7.5,
    fontWeight: 600,
    letterSpacing: 1,
    color: "#565b54",
  },
  documentMeta: {
    position: "absolute",
    top: 49,
    right: 32,
    fontSize: 8.5,
    fontWeight: 600,
  },
  sectionLabel: {
    marginTop: 7,
    marginBottom: 4,
    fontSize: 6.8,
    fontWeight: 600,
    letterSpacing: 0.9,
    color: "#626861",
  },
  parameterRow: {
    minHeight: 20,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 0.5,
    borderBottomColor: colors.rule,
  },
  parameterLabel: { width: 78, color: colors.muted },
  parameterValue: { flex: 1, fontWeight: 600, fontSize: 8.2 },
  parameterRight: { marginLeft: 10, fontSize: 8 },
  twoColumns: {
    minHeight: 20,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 0.5,
    borderBottomColor: colors.rule,
  },
  parameter: { flex: 1, flexDirection: "row", alignItems: "center" },
  parameterWide: { flex: 1.45 },
  parameterInlineLabel: { marginRight: 7, color: colors.muted },
  parameterInlineValue: { flex: 1, fontWeight: 600, fontSize: 7.8 },
  metrics: {
    minHeight: 51,
    flexDirection: "row",
    borderTopWidth: 0.7,
    borderBottomWidth: 0.5,
    borderColor: colors.strong,
    paddingVertical: 7,
  },
  metric: { flex: 1, borderRightWidth: 0.5, borderRightColor: colors.rule, paddingLeft: 0 },
  metricLast: { borderRightWidth: 0 },
  metricValue: { fontSize: 18, fontWeight: 600, lineHeight: 1 },
  metricAccent: { color: colors.green },
  metricLabel: { marginTop: 3, color: colors.muted },
  resultNote: { marginTop: 5, marginBottom: 1, lineHeight: 1.25 },
  semibold: { fontWeight: 600 },
  table: { borderBottomWidth: 0.7, borderBottomColor: colors.strong },
  tableRow: {
    minHeight: 18,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 0.5,
    borderBottomColor: colors.rule,
  },
  tableHeader: { minHeight: 18, backgroundColor: colors.fill },
  cell: { paddingHorizontal: 7, paddingVertical: 4 },
  categoryCell: { flex: 1 },
  countCell: { width: 72, textAlign: "right" },
  decisionCell: { width: 150 },
  statusCell: { flex: 1 },
  statusTotalCell: { width: 78, textAlign: "right" },
  statusCheckedCell: { width: 78, textAlign: "right" },
  statusResultCell: { width: 94, textAlign: "right" },
  headerText: { fontSize: 6.2, fontWeight: 600 },
  movingNote: { marginTop: 4, color: colors.muted, fontSize: 6.6 },
  packageSummary: {
    paddingBottom: 5,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.rule,
    fontWeight: 600,
  },
  conclusion: { lineHeight: 1.3, maxWidth: 390 },
  signatures: { marginTop: 8, flexDirection: "row", alignItems: "flex-start" },
  signatureList: { width: 365 },
  signatureRow: { height: 28, flexDirection: "row", alignItems: "center" },
  signatureLabel: { width: 128, color: colors.muted, fontSize: 6.6 },
  signatureLine: { width: 65, borderBottomWidth: 0.5, borderBottomColor: colors.rule },
  signatureNameLine: {
    width: 140,
    marginLeft: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: colors.rule,
  },
  stamp: {
    width: 72,
    height: 72,
    marginLeft: "auto",
    borderWidth: 0.7,
    borderStyle: "dashed",
    borderColor: "#a7aca5",
    alignItems: "center",
    justifyContent: "center",
  },
  stampText: { color: colors.muted, fontSize: 8.5, fontWeight: 600 },
  footer: {
    position: "absolute",
    left: 32,
    right: 32,
    bottom: 13,
    height: 39,
    paddingTop: 5,
    borderTopWidth: 0.5,
    borderTopColor: colors.rule,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  barcode: { width: 148, height: 16 },
  barcodeCaption: { marginTop: 1, fontSize: 5.8, fontWeight: 600, letterSpacing: 0.3 },
  footerMeta: { alignItems: "flex-end", gap: 3, color: colors.muted, fontSize: 6.2 },
});

function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function ParameterRow({ label, value, right }: { label: string; value: string; right?: string }) {
  return (
    <View style={styles.parameterRow}>
      <Text style={styles.parameterLabel}>{label}</Text>
      <Text style={styles.parameterValue}>{value}</Text>
      {right ? <Text style={styles.parameterRight}>{right}</Text> : null}
    </View>
  );
}

function Parameter({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <View style={[styles.parameter, ...(wide ? [styles.parameterWide] : [])]}>
      <Text style={styles.parameterInlineLabel}>{label}</Text>
      <Text style={styles.parameterInlineValue}>{value}</Text>
    </View>
  );
}

function Metric({
  value,
  label,
  accent = false,
  last = false,
}: {
  value: number | string;
  label: string;
  accent?: boolean;
  last?: boolean;
}) {
  return (
    <View style={[styles.metric, ...(last ? [styles.metricLast] : [])]}>
      <Text style={[styles.metricValue, ...(accent ? [styles.metricAccent] : [])]}>
        {typeof value === "number" ? formatCount(value) : value}
      </Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function ResultTable({ model }: { model: InventoryActViewModel }) {
  const rows = [
    ["Фактический остаток · INTRODUCED", model.verifiedCount, "Принять к текущему учёту"],
    ["Не обнаружено при проверке", model.missingCount, "Кандидаты на списание"],
    ["В отгрузке · MOVING_BY_UD", model.protectedCount, "Исключено"],
    ["Неподходящий статус", model.ineligibleCount, "Проверить администратору"],
    ["Неизвестные коды", model.unknownCount, "Проверить статус в ЧЗ"],
  ] as const;
  return (
    <View style={styles.table}>
      <View style={[styles.tableRow, styles.tableHeader]}>
        <Text style={[styles.cell, styles.categoryCell, styles.headerText]}>КАТЕГОРИЯ</Text>
        <Text style={[styles.cell, styles.countCell, styles.headerText]}>КОЛИЧЕСТВО</Text>
        <Text style={[styles.cell, styles.decisionCell, styles.headerText]}>РЕШЕНИЕ</Text>
      </View>
      {rows.map(([label, count, decision]) => (
        <View style={styles.tableRow} key={label}>
          <Text style={[styles.cell, styles.categoryCell]}>{label}</Text>
          <Text style={[styles.cell, styles.countCell]}>{formatCount(count)}</Text>
          <Text
            style={[
              styles.cell,
              styles.decisionCell,
              ...(decision === "Исключено" ? [styles.semibold] : []),
            ]}
          >
            {decision}
          </Text>
        </View>
      ))}
      <Text style={styles.movingNote}>
        MOVING_BY_UD не включается в остаток и не передаётся на последующее списание.
      </Text>
    </View>
  );
}

function StatusTable({ rows }: { rows: readonly InventoryActStatusRow[] }) {
  return (
    <View style={styles.table}>
      <View style={[styles.tableRow, styles.tableHeader]}>
        <Text style={[styles.cell, styles.statusCell, styles.headerText]}>СТАТУС</Text>
        <Text style={[styles.cell, styles.statusTotalCell, styles.headerText]}>В ВЫПИСКАХ</Text>
        <Text style={[styles.cell, styles.statusCheckedCell, styles.headerText]}>ПРОВЕРЕНО</Text>
        <Text style={[styles.cell, styles.statusResultCell, styles.headerText]}>РЕЗУЛЬТАТ</Text>
      </View>
      {rows.map((row) => (
        <View style={styles.tableRow} key={row.code}>
          <Text style={[styles.cell, styles.statusCell]}>
            {row.label} · {row.code}
          </Text>
          <Text style={[styles.cell, styles.statusTotalCell]}>{formatCount(row.total)}</Text>
          <Text style={[styles.cell, styles.statusCheckedCell]}>{formatCount(row.checked)}</Text>
          <Text style={[styles.cell, styles.statusResultCell]}>{row.result}</Text>
        </View>
      ))}
    </View>
  );
}

function SignatureRow({ label }: { label: string }) {
  return (
    <View style={styles.signatureRow}>
      <Text style={styles.signatureLabel}>{label}</Text>
      <View style={styles.signatureLine} />
      <View style={styles.signatureNameLine} />
    </View>
  );
}

async function svgDataUri(svg: string, width: number): Promise<string> {
  const png = await sharp(Buffer.from(svg), { density: 600 }).resize({ width }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function signedDifference(value: number): string {
  if (value === 0) return "0";
  return value < 0 ? `−${formatCount(Math.abs(value))}` : `+${formatCount(value)}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value).replaceAll(" ", " ");
}

function formatCivilDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Moscow",
  })
    .format(new Date(value))
    .replace(",", "");
}
