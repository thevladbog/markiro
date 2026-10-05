import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertUsRequestReportModel } from "./us-request-package-inputs";
import {
  US_REQUEST_PACKAGE_LIMITS,
  US_REQUEST_REPORT_PDF_VERSION,
  type UsRequestPackageByteFile,
  type UsRequestReportModel,
} from "./us-request-package-types";

const family = "US Request IBM Plex Sans";
let registered = false;
const renderFailed = () =>
  new ServiceUnavailableException({ code: "us_request_report_render_failed" });
const styles = StyleSheet.create({
  page: {
    fontFamily: family,
    fontSize: 9.5,
    lineHeight: 1.4,
    paddingHorizontal: 42,
    paddingTop: 90,
    paddingBottom: 55,
    color: "#172E3B",
  },
  header: {
    position: "absolute",
    top: 27,
    left: 42,
    right: 42,
    borderBottomWidth: 1,
    borderColor: "#CAD6DE",
    paddingBottom: 8,
  },
  brand: { fontSize: 10, fontWeight: 700, color: "#0B6370" },
  provenance: { fontSize: 9, marginTop: 3 },
  title: { fontSize: 21, fontWeight: 700, marginBottom: 10 },
  heading: { fontSize: 12, fontWeight: 700, color: "#0B6370", marginTop: 14, marginBottom: 5 },
  body: { marginBottom: 4 },
  finding: { borderLeftWidth: 2, borderColor: "#CAD6DE", paddingLeft: 8, marginBottom: 9 },
  footer: { position: "absolute", top: 754, left: 42, right: 42, fontSize: 8, color: "#49616C" },
});
type Section = { title: string; rows: string[] };
const noHyphenation = (word: string) => [word];

// Break long tokens explicitly without inserting hyphens or dropping characters.
// Text remains lossless when extracted; line breaks have only layout meaning.
function wrapTokens(value: string): string {
  return value.replace(/\S{61,}/gu, (token) => {
    const characters = Array.from(token);
    const lines: string[] = [];
    for (let start = 0; start < characters.length; start += 45)
      lines.push(characters.slice(start, start + 45).join(""));
    return lines.join("\n");
  });
}
function localInstant(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((item) => item.type === type)?.value;
    if (value === undefined) throw renderFailed();
    return value;
  };
  const zone = part("timeZoneName");
  const offset = zone === "GMT" ? "+00:00" : zone.replace("GMT", "");
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}.${part("fractionalSecond")} (${timeZone}, UTC${offset})`;
}
const summary = (counts: Record<"error" | "warning" | "info", number>) =>
  `error ${counts.error}; warning ${counts.warning}; info ${counts.info}`;

function reportSections(m: UsRequestReportModel): Section[] {
  const timed = (label: string, instant: string) => [
    `${label}: ${localInstant(instant, m.stamps.timeZone)}`,
    `${label} (UTC): ${new Date(instant).toISOString()}`,
  ];
  return [
    {
      title: "Request and frozen identity",
      rows: [
        `Request number: ${m.request.requestNumber}`,
        `Request ID: ${m.identity.requestId}`,
        `Request revision: ${m.identity.requestRevision}`,
        `Run ID: ${m.identity.runId}`,
        `Run revision: ${m.identity.runRevision}`,
        `Tenant ID: ${m.identity.tenantId}`,
        `Preparing actor ID: ${m.identity.preparedBy}`,
        `Frozen requester: ${m.request.requesterName}`,
        `Frozen organization: ${m.request.requesterOrganization ?? "Unavailable"}`,
        `Frozen contact: ${m.request.requesterContact ?? "Unavailable"}`,
        `Alternate-deadline reason: ${m.request.alternateDeadlineReason ?? "None"}`,
      ],
    },
    {
      title: "Frozen request scope",
      rows: Object.entries(m.scope).map(
        ([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
      ),
    },
    {
      title: "Receipt, deadline and preparation timing",
      rows: [
        ...timed("Received", m.request.receivedAt),
        ...timed("Due", m.request.dueAt),
        ...timed("Preparation started", m.timing.preparationStartedAt),
        ...(m.timing.workerStartedAt === null
          ? ["Worker started: Unavailable"]
          : timed("Worker started", m.timing.workerStartedAt)),
        ...timed("Report data prepared at", m.timing.reportDataPreparedAt),
        `Elapsed to report data preparation: ${m.timing.elapsedToReportDataPreparationMs} ms`,
        "Preparation start is the frozen server boundary. Report data preparation is the supplied context boundary.",
      ],
    },
    {
      title: "Captured revisions and workbook summary",
      rows: [
        `Captured revisions: ${m.selectionSummary.capturedRevisionCount}`,
        `Workbook events: ${m.selectionSummary.workbookEventCount}`,
        ...Object.entries(m.selectionSummary.byType).map(([key, count]) => `${key}: ${count}`),
        ...Object.entries(m.selectionSummary.byLifecycle).map(([key, count]) => `${key}: ${count}`),
        "Captured revision counts describe the entire saved set; workbook events describe the actual workbook input. No quantities are summed.",
        `Frozen validation findings: ${summary(m.findingsSummary.validation)}`,
        `XLSX-render findings: ${summary(m.findingsSummary.render)}`,
        "This report is a summary. See lossless validation.json for full frozen findings, source revisions, lifecycle and genealogy.",
        ...(m.warningAcknowledgement
          ? [
              `Warning acknowledgement actor ID: ${m.warningAcknowledgement.actorId}`,
              `Warning acknowledgement at (UTC): ${m.warningAcknowledgement.acknowledgedAt}`,
              `Warning acknowledgement digest: ${m.warningAcknowledgement.digest}`,
              `Warning acknowledgement reason: ${m.warningAcknowledgement.reason}`,
            ]
          : ["Warning acknowledgement: None"]),
      ],
    },
    {
      title: "Named digests and frozen stamps",
      rows: [
        `Scoped-content digest: ${m.digests.scopedContentDigest}`,
        `Workbook-input digest: ${m.digests.inputDigest ?? "Unavailable"}`,
        `Profile: ${m.stamps.profile}`,
        `Tenant timezone: ${m.stamps.timeZone}`,
        `Baseline ID: ${m.stamps.baselineId}`,
        `Registry ID: ${m.stamps.registryId}`,
        `Registry version: ${m.stamps.registryVersion}`,
        `Registry hash: ${m.stamps.registryHash}`,
        `Build API version: ${m.stamps.build.apiVersion}`,
        `Build Git SHA: ${m.stamps.build.gitSha}`,
        `Build dirty: ${m.stamps.build.dirty ? "yes" : "no"}`,
      ],
    },
    {
      title: "Pinned Plan and available pre-report files",
      rows: [
        ...(m.plan
          ? [`Pinned Plan ID: ${m.plan.id}`, `Pinned Plan PDF SHA256: ${m.plan.pdfSha256}`]
          : ["Pinned Plan: Absent"]),
        ...m.preReportFiles.flatMap((file) => [
          `${file.name}: ${file.byteSize} bytes; media type: ${file.mediaType}`,
          `${file.name} SHA256: ${file.sha256}`,
        ]),
        ...m.missingFiles.map((file) => `${file.name}: ${file.code}`),
      ],
    },
  ];
}

function isGlyphFont(value: unknown): value is { hasGlyphForCodePoint(code: number): boolean } {
  return (
    value !== null &&
    typeof value === "object" &&
    "hasGlyphForCodePoint" in value &&
    typeof value.hasGlyphForCodePoint === "function"
  );
}
async function ensureSupportedText(values: readonly string[]): Promise<void> {
  if (!registered) {
    Font.register({
      family,
      fonts: [
        { src: join(__dirname, "../plans/assets/IBMPlexSans-Regular.ttf"), fontWeight: 400 },
        { src: join(__dirname, "../plans/assets/IBMPlexSans-Bold.ttf"), fontWeight: 700 },
      ],
    });
    registered = true;
  }
  for (const fontWeight of [400, 700]) {
    const source = Font.getFont({ fontFamily: family, fontWeight });
    await source.load();
    const font: unknown = source.data;
    if (!isGlyphFont(font)) throw renderFailed();
    for (const value of values)
      for (const character of value) {
        if (character === "\n" || character === "\r") continue;
        const code = character.codePointAt(0);
        if (code === undefined || /\p{Cf}/u.test(character) || !font.hasGlyphForCodePoint(code))
          throw renderFailed();
      }
  }
}

/** Pure report rendering: no clock, source queries, storage or publication. */
export async function renderUsRequestReportPdf(
  model: UsRequestReportModel,
): Promise<UsRequestPackageByteFile<"request-report.pdf">> {
  assertUsRequestReportModel(model);
  // Copy before the first await so caller edits cannot change the rendered snapshot.
  const m = structuredClone(model);
  let output: Buffer;
  try {
    const provenance =
      m.tenantOrigin.result === "trusted_synthetic"
        ? "Synthetic demo — not an operational record"
        : "Tenant origin not attested";
    const mode =
      m.identity.mode === "export_ready" ? "Export-ready" : "Available records — incomplete";
    const sections = reportSections(m);
    const findings = m.renderFindings.map((finding) => [
      `XLSX-render ${finding.severity}: ${finding.code}`,
      `Source record: ${finding.sourceRecord}; event ID: ${finding.eventId ?? "Unavailable"}`,
      `Revision: ${finding.revision ?? "Unavailable"}; line: ${finding.lineNo ?? "Unavailable"}; field: ${finding.fieldKey ?? "Unavailable"}`,
      finding.message,
    ]);
    const limitations = [
      "This report is designed to support applicable FSMA 204 recordkeeping requirements. It does not independently establish regulatory applicability or legal compliance, and does not submit directly to FDA.",
      "Package prepared in the U.S. instance; delivery to the requester is performed by the covered entity",
      "This workflow statement does not attest hosted data residency or evidence of delivery. Internal package bytes do not establish publication.",
      `Origin verification policy: ${m.tenantOrigin.verificationPolicy}`,
      ...(m.tenantOrigin.trustedSeed
        ? [
            `Trusted seed ID: ${m.tenantOrigin.trustedSeed.seedId}; verified by: ${m.tenantOrigin.trustedSeed.verifiedBy}`,
          ]
        : []),
      `Report renderer: ${US_REQUEST_REPORT_PDF_VERSION}`,
    ];
    await ensureSupportedText([
      provenance,
      mode,
      ...sections.flatMap((section) => [section.title, ...section.rows]),
      ...findings.flat(),
      ...limitations,
    ]);
    const paragraph = (value: string, key: string | number) => (
      <Text key={key} style={styles.body} hyphenationCallback={noHyphenation}>
        {wrapTokens(value)}
      </Text>
    );
    output = await renderToBuffer(
      <Document
        title="Markiro US trace request report"
        creator={US_REQUEST_REPORT_PDF_VERSION}
        producer={US_REQUEST_REPORT_PDF_VERSION}
        creationDate={new Date(m.timing.reportDataPreparedAt)}
        modificationDate={new Date(m.timing.reportDataPreparedAt)}
      >
        <Page size="LETTER" style={styles.page} wrap>
          <Text
            style={styles.footer}
            fixed
            wrap={false}
            render={({ pageNumber, totalPages }) =>
              `${US_REQUEST_REPORT_PDF_VERSION} · Page ${pageNumber} of ${totalPages}`
            }
          />
          <View style={styles.header} fixed>
            <Text style={styles.brand}>MARKIRO · US trace request report</Text>
            <Text style={styles.provenance}>{provenance}</Text>
          </View>
          <Text style={styles.title}>{mode}</Text>
          {sections.map((section) => (
            <View key={section.title} wrap>
              <Text style={styles.heading} minPresenceAhead={24}>
                {section.title}
              </Text>
              {section.rows.map(paragraph)}
            </View>
          ))}
          <Text style={styles.heading} minPresenceAhead={24}>
            Full XLSX-render findings
          </Text>
          {findings.length
            ? findings.map((rows, i) => (
                <View key={i} style={styles.finding} wrap>
                  {rows.map(paragraph)}
                </View>
              ))
            : paragraph("No XLSX-render findings.", "no-findings")}
          <Text style={styles.heading} minPresenceAhead={24}>
            Provenance and limitations
          </Text>
          {limitations.map(paragraph)}
        </Page>
      </Document>,
    );
  } catch {
    throw renderFailed();
  }
  if (output.length > US_REQUEST_PACKAGE_LIMITS.report)
    throw new ServiceUnavailableException({ code: "us_request_package_size_limit" });
  const bytes = Buffer.from(output);
  return {
    name: "request-report.pdf",
    mediaType: "application/pdf",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
  };
}
