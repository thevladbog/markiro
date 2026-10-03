import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, StatusChip } from "@markiro/ui";
import type { UsPlanDetailResponse, UsPlanListResponse } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { planCopy } from "./copy.js";
import { planDate } from "./versions.js";
import { UsClientError, type UsBrowserClient } from "../client.js";

type Published = Extract<UsPlanDetailResponse, { status: "effective" | "superseded" }>;
type Source = Published["factSources"]["entries"][number]["source"];
type Links = { onOpenProfile: () => void; onOpenLocations: () => void; onOpenProducts: () => void };
type DownloadProps = {
  client: UsBrowserClient;
  canExport: boolean;
  availability: UsPlanListResponse["publicationAvailability"];
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
};

function PublishedDownload({ detail, ...props }: DownloadProps & { detail: Published }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [denied, setDenied] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const previousAccess = useRef(props.canExport);
  const downloadUrl = useRef<string | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function release() {
    if (releaseTimer.current) clearTimeout(releaseTimer.current);
    releaseTimer.current = null;
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = null;
  }
  useEffect(() => {
    if (!previousAccess.current && props.canExport) setDenied(false);
    previousAccess.current = props.canExport;
    generation.current += 1;
    busy.current = false;
    setPending(false);
    return () => {
      generation.current += 1;
      release();
    };
  }, [detail.id, props.canExport, props.availability]);
  const storageUnavailable = props.availability !== "available" || unavailable;
  async function download() {
    if (busy.current || !props.canExport || denied || storageUnavailable) return;
    const request = ++generation.current;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await props.client.downloadPlanPdf(detail.id);
      if (request !== generation.current) return;
      const digest = await crypto.subtle.digest("SHA-256", result.bytes);
      if (request !== generation.current) return;
      const sha256 = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      if (result.bytes.byteLength !== detail.artifact.byteSize || sha256 !== detail.artifact.sha256)
        throw new UsClientError("invalid_response");
      release();
      const url = URL.createObjectURL(new Blob([result.bytes], { type: "application/pdf" }));
      downloadUrl.current = url;
      const link = document.createElement("a");
      link.href = url;
      link.download = `traceability-plan-v${detail.versionNumber}.pdf`;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
      // Let the browser consume the click, then release the temporary bytes.
      releaseTimer.current = setTimeout(release, 0);
    } catch (value) {
      if (request !== generation.current) return;
      release();
      if (value instanceof UsClientError && value.code === "forbidden") {
        setDenied(true);
        setError("usPlan.inspectionForbidden");
        await props.onForbidden();
      } else if (value instanceof UsClientError && value.code === "session_required") {
        setDenied(true);
        setError("usPlan.session");
        props.onSessionLost();
      } else if (
        value instanceof UsClientError &&
        value.code === "us_plan_artifact_storage_unconfigured"
      ) {
        setUnavailable(true);
        setError("usPlan.publicationUnavailable");
      } else setError("usPlan.downloadError");
    } finally {
      if (request === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  return (
    <div className="us-plan-download">
      {props.canExport ? (
        <Button disabled={pending || denied || storageUnavailable} onClick={() => void download()}>
          {t("usPlan.downloadPublished")}
        </Button>
      ) : null}
      {pending ? <p role="status">{t("usPlan.downloading")}</p> : null}
      {storageUnavailable && !error ? <p>{t("usPlan.publicationUnavailable")}</p> : null}
      {error ? <p role="alert">{t(error)}</p> : null}
    </div>
  );
}

export function PlanCurrentImpact({
  impact,
  version,
}: {
  impact: NonNullable<UsPlanListResponse["effectiveImpact"]>;
  version?: number;
}) {
  const { t } = useTranslation();
  const title =
    version === undefined ? t("usPlan.effectiveImpact") : t("usPlan.currentImpact", { version });
  return (
    <section aria-label={title} className="us-plan-impact">
      <h2>{title}</h2>
      <p>{t("usPlan.impactHelp")}</p>
      {impact.changedSections.length ? (
        <Alert
          tone="warn"
          title={t(
            version === undefined
              ? "usPlan.configurationChanged"
              : "usPlan.versionConfigurationChanged",
          )}
        >
          <ul>
            {impact.changedSections.map((section) => (
              <li key={section}>{t(`usPlan.fields.${section}`)}</li>
            ))}
          </ul>
        </Alert>
      ) : (
        <p>{t("usPlan.noChanges")}</p>
      )}
      {(["changedLocationIds", "changedProductIds"] as const).map((key) =>
        impact[key].length ? (
          <div key={key}>
            <h3>
              {t(
                key === "changedLocationIds" ? "usPlan.changedLocations" : "usPlan.changedProducts",
              )}
            </h3>
            <ul>
              {impact[key].map((id) => (
                <li key={id}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  );
}
function FactSource({ source }: { source: Source | undefined }) {
  const { t, i18n } = useTranslation();
  return (
    <small className="us-plan-source">
      {t("usPlan.sources")}: {source ? t(`usPlan.${source.origin}`) : t("usPlan.sourceMissing")}
      {source?.origin === "operator_confirmed" ? (
        <>
          {" "}
          · {t("usPlan.actor")}: <code>{source.actorId}</code> · {t("usPlan.confirmedAt")}:{" "}
          <time dateTime={source.confirmedAt}>
            {planDate(source.confirmedAt, i18n.language, "UTC", true)}
          </time>
        </>
      ) : null}
      {source?.origin === "application_policy" ? (
        <>
          {" "}
          · {t("usPlan.policyVersion")}: {source.version}
        </>
      ) : null}
    </small>
  );
}

// Walk only typed snapshot data. Labels and enum copy come from a fixed allowlist;
// arbitrary manifest paths are never used as translation keys or displayed as prose.
function SnapshotFacts({
  value,
  path,
  sources,
  field = "",
}: {
  value: unknown;
  path: string;
  sources: Published["factSources"]["entries"];
  field?: string;
}) {
  const { t } = useTranslation();
  const source = sources.find((entry) => entry.path === path)?.source;
  if (Array.isArray(value))
    return (
      <div className="us-plan-facts">
        <FactSource source={source} />
        {value.length ? (
          value.map((item: unknown, index) => {
            const segment =
              item !== null &&
              typeof item === "object" &&
              "id" in item &&
              typeof item.id === "string"
                ? item.id
                : item !== null &&
                    typeof item === "object" &&
                    "productId" in item &&
                    typeof item.productId === "string"
                  ? item.productId
                  : String(index);
            return (
              <div className="us-plan-fact-item" key={segment}>
                <SnapshotFacts
                  value={item}
                  path={`${path}/${segment}`}
                  sources={sources}
                  field={field}
                />
              </div>
            );
          })
        ) : (
          <p>{t("usPlan.notRecorded")}</p>
        )}
      </div>
    );
  if (value !== null && typeof value === "object")
    return (
      <dl className="us-plan-facts">
        {Object.entries(value).map(([key, item]: [string, unknown]) =>
          Object.hasOwn(planCopy["en-US"].fields, key) ? (
            <div key={key}>
              <dt>{t(`usPlan.fields.${key}`)}</dt>
              <dd>
                <SnapshotFacts value={item} path={`${path}/${key}`} sources={sources} field={key} />
              </dd>
            </div>
          ) : null,
        )}
      </dl>
    );
  const enums = new Set([
    "profileCode",
    "addressKind",
    "coverageStatus",
    "status",
    "reviewMode",
    "coverageStatuses",
    "positiveCoverageStatuses",
    "coverageChangeAuthority",
    "reviewerAttribution",
    "reviewTimeAttribution",
    "reviewCadenceSource",
  ]);
  const content =
    typeof value === "boolean"
      ? t(value ? "usPlan.values.yes" : "usPlan.values.no")
      : typeof value === "string" && enums.has(field)
        ? Object.hasOwn(planCopy["en-US"].values, value)
          ? t(`usPlan.values.${value}`)
          : t("usPlan.values.unknown")
        : typeof value === "string" && field === "positiveCoverageEvidenceFields"
          ? Object.hasOwn(planCopy["en-US"].fields, value)
            ? t(`usPlan.fields.${value}`)
            : t("usPlan.values.unknown")
          : typeof value === "string" || typeof value === "number"
            ? String(value) || t("usPlan.notRecorded")
            : t("usPlan.notRecorded");
  return (
    <>
      <span
        className={/^(id|partyId|productId)$/.test(field) ? "us-plan-literal" : "us-plan-value"}
      >
        {content}
      </span>
      <FactSource source={source} />
    </>
  );
}

export function PlanDetail({
  detail,
  onClose,
  download,
  ...links
}: { detail: UsPlanDetailResponse; onClose: () => void; download?: DownloadProps } & Links) {
  const { t, i18n } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [detail.id]);
  return (
    <article className="us-plan-detail">
      <div className="us-plan-heading">
        <h2 ref={heading} tabIndex={-1}>
          v{detail.versionNumber} · {t(`usPlan.${detail.status}`)}
        </h2>
        <Button variant="secondary" onClick={onClose}>
          {t("usPlan.close")}
        </Button>
      </div>
      <StatusChip
        status="neutral"
        label={t(
          detail.provenance === "trusted_synthetic" ? "usPlan.synthetic" : "usPlan.operational",
        )}
      />
      <h3>{t("usPlan.changeSummary")}</h3>
      <p className="us-plan-value">{detail.changeSummary || t("usPlan.notRecorded")}</p>
      {detail.status === "draft" ? (
        <>
          <Alert tone="warn" title={t("usPlan.draftMark")}>
            {t("usPlan.draftUnavailable")}
          </Alert>
          <SnapshotFacts value={detail.sections} path="/sections" sources={[]} />
        </>
      ) : (
        <>
          <section aria-label={t("usPlan.approval")}>
            <Card>
              <h3>{t("usPlan.approval")}</h3>
              <dl className="us-plan-metadata">
                <div>
                  <dt>{t("usPlan.approvedBy")}</dt>
                  <dd>
                    <code>{detail.approvedBy}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t("usPlan.approvedAt")}</dt>
                  <dd>
                    <time dateTime={detail.approvedAt}>
                      {planDate(detail.approvedAt, i18n.language, "UTC", true)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>{t("usPlan.sha256")}</dt>
                  <dd>
                    <code>{detail.artifact.sha256}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t("usPlan.renderer")}</dt>
                  <dd>{detail.artifact.rendererVersion}</dd>
                </div>
                <div>
                  <dt>{t("usPlan.byteSize")}</dt>
                  <dd>{detail.artifact.byteSize.toLocaleString(i18n.language)}</dd>
                </div>
                {detail.supersededAt ? (
                  <div>
                    <dt>{t("usPlan.supersededAt")}</dt>
                    <dd>
                      <time dateTime={detail.supersededAt}>
                        {planDate(detail.supersededAt, i18n.language, "UTC", true)}
                      </time>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t("usPlan.retention")}</dt>
                  <dd>
                    {detail.status === "effective"
                      ? t("usPlan.noExpiry")
                      : detail.retainThrough
                        ? planDate(`${detail.retainThrough}T12:00:00Z`, i18n.language)
                        : t(
                            detail.retentionIndefiniteReason === "hold"
                              ? "usPlan.hold"
                              : detail.retentionIndefiniteReason === "date_range_exceeded"
                                ? "usPlan.dateRange"
                                : "usPlan.indefinite",
                          )}
                  </dd>
                </div>
              </dl>
            </Card>
          </section>
          {download ? <PublishedDownload key={detail.id} {...download} detail={detail} /> : null}
          <section aria-label={t("usPlan.frozen")}>
            <h2>{t("usPlan.frozen")}</h2>
            <p>{t("usPlan.frozenHelp")}</p>
            <h3>{t("usPlan.configured")}</h3>
            <div className="us-plan-links">
              <Button variant="secondary" onClick={links.onOpenProfile}>
                {t("usPlan.openProfile")}
              </Button>
              <Button variant="secondary" onClick={links.onOpenLocations}>
                {t("usPlan.openLocations")}
              </Button>
              <Button variant="secondary" onClick={links.onOpenProducts}>
                {t("usPlan.openProducts")}
              </Button>
            </div>
            <SnapshotFacts
              value={detail.snapshot.configured}
              path="/configured"
              sources={detail.factSources.entries}
            />
            <h3>{t("usPlan.statements")}</h3>
            <SnapshotFacts
              value={detail.snapshot.sections}
              path="/sections"
              sources={detail.factSources.entries}
            />
            <h3>{t("usPlan.workflow")}</h3>
            <SnapshotFacts
              value={detail.snapshot.ftlReviewWorkflow}
              path="/ftlReviewWorkflow"
              sources={detail.factSources.entries}
            />
            <h3>{t("usPlan.confirmations")}</h3>
            <p>{t("usPlan.confirmationHelp")}</p>
            <dl className="us-plan-facts">
              {Object.entries(detail.confirmations).map(([name, source]) => (
                <div key={name}>
                  <dt>{t(`usPlan.fields.${name}`)}</dt>
                  <dd>
                    <FactSource source={source} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <PlanCurrentImpact
            impact={detail.comparisonAgainstCurrentConfiguredFacts}
            version={detail.versionNumber}
          />
        </>
      )}
    </article>
  );
}
