import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type {
  UsPlanApprovedEvidence,
  UsPlanFactSource,
  UsPlanFactSourceManifest,
  UsPlanSnapshot,
} from "@markiro/domain";
import {
  buildUsPlanApprovedEvidence,
  buildUsPlanDraftFactSources,
  buildUsPlanSnapshot,
  canonicalExportDigest,
} from "@markiro/domain";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const US_PLAN_PDF_RENDERER_VERSION = "us-plan-pdf-v1";
const SYNTHETIC_MARKER = "Synthetic demo — not an operational record";
const DRAFT_MARKER = "DRAFT — not effective";

Font.register({
  family: "US IBM Plex Sans",
  fonts: [
    { src: join(__dirname, "assets/IBMPlexSans-Regular.ttf"), fontWeight: 400 },
    { src: join(__dirname, "assets/IBMPlexSans-Bold.ttf"), fontWeight: 700 },
  ],
});

export interface UsPlanPublishedPdfModel {
  versionNumber: number;
  approvedBy: string;
  approvedAt: string;
  changeSummary: string;
  evidence: UsPlanApprovedEvidence;
}

export interface UsPlanDraftPdfModel {
  versionNumber: number;
  changeSummary: string;
  snapshot: UsPlanSnapshot;
  factSources: UsPlanFactSourceManifest;
}

export interface UsPlanPdfResult {
  bytes: Buffer;
  sha256: string;
  byteSize: number;
  rendererVersion: typeof US_PLAN_PDF_RENDERER_VERSION;
}

type RenderModel = {
  versionNumber: number;
  changeSummary: string;
  snapshot: UsPlanSnapshot;
  factSources: UsPlanFactSourceManifest;
  approval?: {
    approvedBy: string;
    approvedAt: string;
    confirmations: UsPlanApprovedEvidence["confirmations"];
  };
};

/** Bound every value before React PDF allocates its layout tree. */
function assertBounded(model: RenderModel): void {
  let totalBytes = 0;
  let nodes = 0;
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): void {
    nodes += 1;
    if (nodes > 40_000 || depth > 20) throw new TypeError("us_plan_pdf_input_limit");
    if (typeof value === "string") {
      const bytes = Buffer.byteLength(value, "utf8");
      totalBytes += bytes;
      if (
        bytes > 4_096 ||
        totalBytes > 512_000 ||
        Array.from(value).some((character) => {
          const code = character.codePointAt(0);
          return code !== undefined && (code <= 8 || (code >= 11 && code <= 31));
        })
      )
        throw new TypeError("us_plan_pdf_input_limit");
    } else if (Array.isArray(value)) {
      if (value.length > 5_000 || seen.has(value)) throw new TypeError("us_plan_pdf_input_limit");
      seen.add(value);
      value.forEach((item) => visit(item, depth + 1));
      seen.delete(value);
    } else if (value !== null && typeof value === "object") {
      if (seen.has(value)) throw new TypeError("us_plan_pdf_input_limit");
      seen.add(value);
      Object.entries(value).forEach(([key, item]) => {
        visit(key, depth + 1);
        visit(item, depth + 1);
      });
      seen.delete(value);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("us_plan_pdf_input_limit");
    } else if (typeof value !== "boolean" && value !== null) {
      throw new TypeError("us_plan_pdf_input_limit");
    }
  }
  visit(model, 0);
  const record = model.snapshot.sections.recordMaintenance;
  if (
    record.formats.length > 50 ||
    record.recordLocations.length > 50 ||
    record.responsibleRoles.length > 50 ||
    record.narrative.length > 50 ||
    model.snapshot.configured.tlcSourceLocations.length > 200 ||
    model.snapshot.configured.productProfiles.length > 200
  )
    throw new TypeError("us_plan_pdf_input_limit");
  const contact = model.snapshot.sections.pointOfContact;
  if (
    contact.name.length > 200 ||
    contact.title.length > 200 ||
    contact.phone.length > 80 ||
    (contact.email !== null && contact.email.length > 254)
  )
    throw new TypeError("us_plan_pdf_input_limit");
  if (
    !Number.isSafeInteger(model.versionNumber) ||
    model.versionNumber < 1 ||
    model.snapshot.schemaVersion !== 1 ||
    (model.snapshot.provenance !== "operational" &&
      model.snapshot.provenance !== "trusted_synthetic") ||
    model.snapshot.configured.profileCode !== "US_FSMA204_PROCESSOR" ||
    model.snapshot.sections.farmActivity.status !== "no" ||
    model.factSources.schemaVersion !== 1 ||
    (model.approval && !model.approval.approvedBy.trim())
  )
    throw new TypeError("us_plan_pdf_input_invalid");
  try {
    const snapshot = buildUsPlanSnapshot(
      model.snapshot.configured,
      model.snapshot.sections,
      model.snapshot.provenance,
    );
    if (canonicalExportDigest(snapshot) !== canonicalExportDigest(model.snapshot))
      throw new TypeError("snapshot_mismatch");
    const draftSources = buildUsPlanDraftFactSources(
      model.snapshot.configured,
      model.snapshot.sections,
    );
    const expectedSources = model.approval
      ? buildUsPlanApprovedEvidence(model.snapshot, draftSources, {
          kind: model.snapshot.provenance === "trusted_synthetic" ? "synthetic" : "operational",
          actorId: model.approval.approvedBy,
          confirmedAt: model.approval.approvedAt,
          confirmations: {
            procedures: true,
            backupAndRecovery: true,
            contact: true,
            nonFarmScope: true,
          },
          ...(model.approval.confirmations.procedures.origin === "synthetic_fixture"
            ? { trustedSeed: model.approval.confirmations.procedures.trustedSeed }
            : {}),
        })
      : null;
    if (
      canonicalExportDigest(model.factSources) !==
        canonicalExportDigest(expectedSources?.factSources ?? draftSources) ||
      (expectedSources &&
        canonicalExportDigest(model.approval?.confirmations) !==
          canonicalExportDigest(expectedSources.confirmations))
    )
      throw new TypeError("source_mismatch");
  } catch {
    throw new TypeError("us_plan_pdf_input_invalid");
  }
}

function civilDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const value = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value;
  return [value("year"), value("month"), value("day")].join("-");
}

function describeSource(source: UsPlanFactSource | undefined): string {
  switch (source?.origin) {
    case "configured":
      return "configured";
    case "application_policy":
      return "application policy v" + source.version;
    case "operator_pending":
      return "operator statement pending approval";
    case "operator_confirmed":
      return "operator confirmed by " + source.actorId + " at " + source.confirmedAt;
    case "synthetic_fixture":
      return (
        "synthetic fixture " +
        source.trustedSeed.seedId +
        ", verified by " +
        source.trustedSeed.verifiedBy +
        " at " +
        source.trustedSeed.verifiedAt
      );
    default:
      return "source unavailable";
  }
}

function sourceAt(model: RenderModel, path: string): string {
  return describeSource(model.factSources.entries.find((entry) => entry.path === path)?.source);
}

const styles = StyleSheet.create({
  page: {
    fontFamily: "US IBM Plex Sans",
    fontSize: 9.5,
    color: "#173047",
    paddingTop: 82,
    paddingBottom: 65,
    paddingHorizontal: 50,
    lineHeight: 1.42,
  },
  running: { position: "absolute", top: 30, left: 50, right: 50, fontSize: 8, color: "#476375" },
  rule: {
    position: "absolute",
    top: 47,
    left: 50,
    right: 50,
    height: 2,
    backgroundColor: "#0B6370",
  },
  marker: {
    position: "absolute",
    top: 53,
    left: 50,
    right: 50,
    fontSize: 9,
    fontWeight: 700,
    color: "#A24623",
  },
  title: { fontSize: 23, fontWeight: 700, color: "#102A43", marginBottom: 15 },
  subtitle: { fontSize: 10, color: "#476375", marginBottom: 12 },
  summary: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#CAD6DE",
    paddingVertical: 7,
    marginBottom: 12,
  },
  section: { marginTop: 14 },
  heading: { fontSize: 13, fontWeight: 700, color: "#0B6370", marginBottom: 4 },
  label: { fontWeight: 700 },
  body: { marginTop: 3 },
  item: { marginLeft: 12, marginTop: 2 },
  provenance: { fontSize: 8, color: "#476375", marginTop: 5 },
});

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Text style={styles.body}>
      <Text style={styles.label}>{label}: </Text>
      {value}
    </Text>
  );
}

function Items({ values }: { values: readonly string[] }): React.JSX.Element {
  return (
    <View>
      {values.map((value, index) => (
        <Text key={index} style={styles.item}>
          • {value}
        </Text>
      ))}
    </View>
  );
}

function Section({
  title,
  source,
  children,
}: {
  title: string;
  source: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.section} wrap={title !== "4. Point of contact"}>
      <Text style={styles.heading} minPresenceAhead={20}>
        {title}
      </Text>
      <Text style={styles.provenance}>Source: {source}</Text>
      {children}
    </View>
  );
}

function PlanDocument({ model }: { model: RenderModel }): React.JSX.Element {
  const { configured, sections, ftlReviewWorkflow } = model.snapshot;
  const synthetic = model.snapshot.provenance === "trusted_synthetic";
  const locations = configured.tlcSourceLocations.map(({ id, description }) =>
    [
      description.businessName + " [" + id + "]",
      "Party: " + description.partyId,
      description.phoneNumber ? "Location phone: " + description.phoneNumber : null,
      description.addressKind === "street"
        ? "Street: " + description.streetAddress
        : "Coordinates: " + description.latitude + ", " + description.longitude,
      [
        description.city,
        description.stateOrRegion,
        description.zipOrPostalCode,
        description.countryCode,
      ]
        .filter((part) => part !== null)
        .join(", "),
      "TLC source location",
    ]
      .filter((part) => part !== null)
      .join("; "),
  );
  const products = configured.productProfiles.map(
    ({ productId, revision, coverageStatus }) =>
      productId + ": coverage " + coverageStatus + ", profile revision " + revision,
  );
  const date = model.approval
    ? new Date(model.approval.approvedAt)
    : new Date("2000-01-01T00:00:00.000Z");
  return (
    <Document
      title={"Traceability plan - " + configured.tenantName + " - version " + model.versionNumber}
      author={configured.tenantName}
      subject="US processor traceability plan"
      creator="Markiro US plan renderer"
      producer="Markiro US plan renderer"
      creationDate={date}
      modificationDate={date}
    >
      <Page size="LETTER" style={styles.page}>
        <Text
          fixed
          style={styles.running}
          render={({ pageNumber, totalPages }) =>
            "MARKIRO US / TRACEABILITY PLAN / VERSION " +
            model.versionNumber +
            " / Page " +
            pageNumber +
            " of " +
            totalPages
          }
        />
        <View fixed style={styles.rule} />
        {!model.approval && (
          <Text fixed style={styles.marker}>
            {DRAFT_MARKER}
          </Text>
        )}
        {synthetic && (
          <Text fixed style={{ ...styles.marker, top: model.approval ? 53 : 65 }}>
            {SYNTHETIC_MARKER}
          </Text>
        )}
        <Text style={styles.title}>Traceability plan</Text>
        <Text style={styles.subtitle}>
          {configured.tenantName} · {configured.profileCode} · baseline {configured.baselineVersion}
        </Text>
        <View style={styles.summary}>
          <Field label="Version" value={String(model.versionNumber)} />
          {model.approval ? (
            <>
              <Field
                label="Effective date"
                value={
                  civilDate(model.approval.approvedAt, configured.timeZone) +
                  " (" +
                  configured.timeZone +
                  ")"
                }
              />
              <Field label="Approved by" value={model.approval.approvedBy} />
              <Field label="Approval instant" value={model.approval.approvedAt} />
            </>
          ) : (
            <Field label="Status" value="Draft preview; no effective date or approval" />
          )}
          <Field label="Change summary" value={model.changeSummary || "Initial version"} />
        </View>

        <Section
          title="1. Record maintenance"
          source={sourceAt(model, "/sections/recordMaintenance/systemOfRecord")}
        >
          <Field label="System of record" value={sections.recordMaintenance.systemOfRecord} />
          <Text style={styles.label}>Record formats</Text>
          <Items values={sections.recordMaintenance.formats} />
          <Text style={styles.label}>Record locations</Text>
          <Items values={sections.recordMaintenance.recordLocations} />
          <Text style={styles.label}>Responsible roles</Text>
          <Items values={sections.recordMaintenance.responsibleRoles} />
          <Field
            label="Backup and recovery statement"
            value={sections.recordMaintenance.backupAndRecovery}
          />
          <Items values={sections.recordMaintenance.narrative} />
          <Field
            label="Configured retention period"
            value={String(configured.retentionYears) + " years"}
          />
        </Section>
        <Section
          title="2. FTL identification"
          source={sourceAt(model, "/sections/ftlIdentification/procedure")}
        >
          <Text style={styles.body}>{sections.ftlIdentification.procedure}</Text>
          <Field
            label="Review cadence statement"
            value={sections.ftlIdentification.reviewCadence}
          />
          <Field
            label="Supported workflow"
            value={
              "Manual product coverage review; " +
              ftlReviewWorkflow.coverageChangeAuthority +
              "; " +
              sourceAt(model, "/ftlReviewWorkflow") +
              ". No automatic legal determination."
            }
          />
          <Text style={styles.label}>
            Frozen product profile facts ({sourceAt(model, "/configured/productProfiles")} source)
          </Text>
          <Items values={products} />
        </Section>
        <Section
          title="3. TLC assignment"
          source={sourceAt(model, "/sections/tlcAssignment/procedure")}
        >
          <Text style={styles.body}>{sections.tlcAssignment.procedure}</Text>
          <Text style={styles.label}>
            Frozen TLC-source locations ({sourceAt(model, "/configured/tlcSourceLocations")} source)
          </Text>
          <Items values={locations} />
        </Section>
        <Section
          title="4. Point of contact"
          source={sourceAt(model, "/sections/pointOfContact/name")}
        >
          <Field label="Name" value={sections.pointOfContact.name} />
          <Field label="Title" value={sections.pointOfContact.title} />
          <Field label="Phone" value={sections.pointOfContact.phone} />
          {sections.pointOfContact.email && (
            <Field label="Email" value={sections.pointOfContact.email} />
          )}
        </Section>
        <Section title="5. Farm activity" source={sourceAt(model, "/sections/farmActivity/status")}>
          <Text style={styles.body}>
            This processor reports no growing or raising of applicable FTL food; no farm map is
            included in this processor plan.
          </Text>
          <Text style={styles.body}>{sections.farmActivity.explanation}</Text>
        </Section>
        <Section
          title="6. Review and update"
          source={sourceAt(model, "/sections/reviewAndUpdate/procedure")}
        >
          <Text style={styles.body}>{sections.reviewAndUpdate.procedure}</Text>
          <Text style={styles.body}>
            Retention policy requires previous versions for at least two years after update. The
            configured retention period is {configured.retentionYears} years; a longer hold may
            apply. This note describes policy, not proof of storage or backup enforcement.
          </Text>
        </Section>
        <Section
          title="7. Provenance and limitations"
          source={sourceAt(model, "/ftlReviewWorkflow")}
        >
          <Text style={styles.body}>
            Configured facts are frozen from tenant master data. Operator statements and
            confirmations are attributed assertions. This document does not independently verify
            backup or recovery, regulatory applicability, or legal compliance; it is not FDA
            approval.
          </Text>
          {model.approval ? (
            Object.entries(model.approval.confirmations).map(([name, source]) => (
              <Field key={name} label={name + " confirmation"} value={describeSource(source)} />
            ))
          ) : (
            <Text style={styles.body}>
              No confirmation has been recorded for this draft preview.
            </Text>
          )}
          <Field label="Renderer" value={US_PLAN_PDF_RENDERER_VERSION} />
        </Section>
      </Page>
    </Document>
  );
}

async function render(model: RenderModel): Promise<Buffer> {
  assertBounded(model);
  const bytes = await renderToBuffer(<PlanDocument model={model} />);
  if (bytes.length > 8_000_000) throw new TypeError("us_plan_pdf_output_limit");
  return bytes;
}

/** Exact publishable bytes and digest; no storage or live lookups. */
export async function renderUsPlanPdf(model: UsPlanPublishedPdfModel): Promise<UsPlanPdfResult> {
  if (model.evidence.schemaVersion !== 1) throw new TypeError("us_plan_pdf_input_invalid");
  const bytes = await render({
    versionNumber: model.versionNumber,
    changeSummary: model.changeSummary,
    snapshot: model.evidence.snapshot,
    factSources: model.evidence.factSources,
    approval: {
      approvedBy: model.approvedBy,
      approvedAt: model.approvedAt,
      confirmations: model.evidence.confirmations,
    },
  });
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
    rendererVersion: US_PLAN_PDF_RENDERER_VERSION,
  };
}

/** Preview returns only ephemeral bytes. */
export function renderUsPlanDraftPreview(model: UsPlanDraftPdfModel): Promise<Buffer> {
  return render(model);
}
