import { useEffect, useRef, useState } from "react";
import { Button, Checkbox } from "@markiro/ui";
import type {
  UsPlanDetailResponse,
  UsPlanApproveBody,
  UsPlanValidationResponse,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { planCopy } from "./copy.js";
import { sectionIds, type SectionId } from "./section-fields.js";

type Draft = Extract<UsPlanDetailResponse, { status: "draft" }>;
type Confirmations = UsPlanApproveBody["confirmations"];
const confirmationIds = ["procedures", "backupAndRecovery", "contact", "nonFarmScope"] as const;
const emptyConfirmations: Confirmations = {
  procedures: false,
  backupAndRecovery: false,
  contact: false,
  nonFarmScope: false,
};
export type PlanInspectionProps = {
  client: UsBrowserClient;
  draft: Draft;
  dirty: boolean;
  saving: boolean;
  canValidate: boolean;
  canExport: boolean;
  onReload: () => Promise<void>;
  onSection?: (section: SectionId | "plan") => void;
  onOpenLocations: () => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
};

export function PlanInspection(props: PlanInspectionProps) {
  const { t } = useTranslation();
  const [confirmations, setConfirmations] = useState<Confirmations>(emptyConfirmations);
  const [validation, setValidation] = useState<UsPlanValidationResponse | null>(null);
  const [announceIssues, setAnnounceIssues] = useState(false);
  const [preview, setPreview] = useState<{ url: string; revision: number } | null>(null);
  const [pending, setPending] = useState<"validate" | "preview" | "reload" | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState({ validate: false, preview: false });
  const previousAccess = useRef({ validate: props.canValidate, preview: props.canExport });
  const generation = useRef(0);
  const busy = useRef(false);
  const objectUrl = useRef<string | null>(null);
  const alive = useRef(true);
  const blocked = props.dirty || props.saving;

  function releasePreview() {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    // Only a new authoritative draft read/save resolves the conflict. Typing,
    // access recovery and failed reloads must not re-enable the stale revision.
    setStale(false);
  }, [props.draft]);
  useEffect(() => {
    // The workspace supplies true only after a successful access read, excluding
    // pending/error states. Clear only the denial whose capability was restored;
    // a void onForbidden result alone cannot establish successful recovery.
    const before = previousAccess.current;
    const restoredValidation = !before.validate && props.canValidate;
    const restoredPreview = !before.preview && props.canExport;
    if (restoredValidation || restoredPreview)
      setDenied((current) => ({
        validate: restoredValidation ? false : current.validate,
        preview: restoredPreview ? false : current.preview,
      }));
    previousAccess.current = { validate: props.canValidate, preview: props.canExport };
  }, [props.canValidate, props.canExport]);
  useEffect(() => {
    // A saved revision, local edits or access transition invalidates all in-flight
    // inspection results. Requests may finish, but cannot publish stale state.
    generation.current += 1;
    busy.current = false;
    setPending(null);
    setValidation(null);
    setError(null);
    setPreview(null);
    releasePreview();
    setConfirmations(emptyConfirmations);
    return () => {
      generation.current += 1;
      releasePreview();
    };
  }, [props.draft.id, props.draft.draftRevision, blocked, props.canExport, props.canValidate]);

  async function inspect(operation: "validate" | "preview") {
    if (
      blocked ||
      stale ||
      busy.current ||
      denied[operation] ||
      (operation === "validate" ? !props.canValidate : !props.canExport)
    )
      return;
    const request = ++generation.current;
    busy.current = true;
    setPending(operation);
    setError(null);
    const { id, draftRevision } = props.draft;
    if (operation === "validate") setValidation(null);
    try {
      if (operation === "validate") {
        const result = await props.client.validatePlan(id, {
          expectedRevision: draftRevision,
          confirmations,
        });
        if (request !== generation.current) return;
        if (result.versionId !== id || result.draftRevision !== draftRevision)
          throw new UsClientError("us_plan_revision_conflict");
        setValidation(result);
        setAnnounceIssues(true);
      } else {
        const result = await props.client.previewPlanPdf(id, { expectedRevision: draftRevision });
        if (request !== generation.current) return;
        if (result.draftRevision !== draftRevision)
          throw new UsClientError("us_plan_revision_conflict");
        const url = URL.createObjectURL(new Blob([result.bytes], { type: "application/pdf" }));
        releasePreview();
        objectUrl.current = url;
        setPreview({ url, revision: result.draftRevision });
      }
    } catch (value) {
      if (request !== generation.current) return;
      if (operation === "preview") {
        releasePreview();
        setPreview(null);
      }
      if (value instanceof UsClientError && value.code === "forbidden") {
        setDenied((current) => ({ ...current, [operation]: true }));
        setError("usPlan.inspectionForbidden");
        await props.onForbidden();
      } else if (value instanceof UsClientError && value.code === "session_required") {
        setDenied({ validate: true, preview: true });
        setValidation(null);
        releasePreview();
        setPreview(null);
        props.onSessionLost();
      } else {
        const conflict =
          value instanceof UsClientError &&
          (value.code === "us_plan_revision_conflict" || value.code === "us_plan_not_draft");
        if (conflict) {
          setStale(true);
          setValidation(null);
          releasePreview();
          setPreview(null);
        }
        setError(
          conflict
            ? "usPlan.inspectionStale"
            : operation === "validate"
              ? "usPlan.validationError"
              : "usPlan.previewError",
        );
      }
    } finally {
      if (request === generation.current) {
        busy.current = false;
        setPending(null);
      }
    }
  }
  async function reload() {
    if (busy.current || props.saving) return;
    busy.current = true;
    setPending("reload");
    setError(null);
    try {
      // The editor owns its unsaved text; this explicit action delegates both
      // the read and replacement to it. Read-only detail uses the same list/detail
      // reconciliation, including publication and discard by another session.
      await props.onReload();
    } catch (value) {
      if (!alive.current) return;
      if (value instanceof UsClientError && value.code === "forbidden") {
        setDenied({ validate: true, preview: true });
        setError("usPlan.forbidden");
        await props.onForbidden();
      } else if (value instanceof UsClientError && value.code === "session_required") {
        props.onSessionLost();
      } else setError("usPlan.detailError");
    } finally {
      if (alive.current) {
        busy.current = false;
        setPending(null);
      }
    }
  }
  return (
    <section className="us-plan-inspection" aria-label={t("usPlan.inspection")}>
      <h3>{t("usPlan.inspection")}</h3>
      <p>{t("usPlan.inspectionHelp")}</p>
      {blocked ? <p role="status">{t("usPlan.inspectionSaveFirst")}</p> : null}
      {props.canValidate ? (
        <fieldset
          className="us-plan-confirmations"
          disabled={blocked || stale || Boolean(pending) || denied.validate}
        >
          <legend>{t("usPlan.advisoryConfirmations")}</legend>
          <p>{t("usPlan.advisoryHelp")}</p>
          {confirmationIds.map((id) => (
            <Checkbox
              key={id}
              label={t(`usPlan.checks.${id}`)}
              checked={confirmations[id]}
              disabled={blocked || stale || Boolean(pending) || denied.validate}
              onCheckedChange={(value) => {
                setConfirmations((current) => ({ ...current, [id]: value }));
                setValidation(null);
              }}
            />
          ))}
        </fieldset>
      ) : null}
      <div className="us-plan-links">
        {props.canValidate ? (
          <Button
            disabled={blocked || stale || Boolean(pending) || denied.validate}
            onClick={() => void inspect("validate")}
          >
            {t("usPlan.validateSaved")}
          </Button>
        ) : null}
        {props.canExport ? (
          <Button
            variant="secondary"
            disabled={blocked || stale || Boolean(pending) || denied.preview}
            onClick={() => void inspect("preview")}
          >
            {t("usPlan.previewSaved")}
          </Button>
        ) : null}
      </div>
      {pending ? (
        <p role="status">
          {t(
            pending === "reload"
              ? "usPlan.detailLoading"
              : pending === "validate"
                ? "usPlan.validating"
                : "usPlan.previewing",
          )}
        </p>
      ) : null}
      {error ? <p role="alert">{t(error)}</p> : null}
      {stale ? (
        <Button
          variant="secondary"
          disabled={props.saving || Boolean(pending)}
          onClick={() => void reload()}
        >
          {t(props.dirty ? "usPlan.reloadDiscard" : "usPlan.reloadSaved")}
        </Button>
      ) : null}
      {validation ? (
        <div {...(validation.issues.length && announceIssues ? { role: "alert" } : {})}>
          <p>{t("usPlan.validatedRevision", { revision: validation.draftRevision })}</p>
          {validation.issues.length ? (
            <ul className="us-plan-issues">
              {validation.issues.map((issue, index) => {
                const section = sectionIds.find((id) => id === issue.section) ?? "plan";
                const code = Object.hasOwn(planCopy["en-US"].issues, issue.code)
                  ? issue.code
                  : "unknown";
                const label = `${t(section === "plan" ? "usPlan.title" : `usPlan.fields.${section}`)}: ${t(`usPlan.issues.${code}`)}`;
                const navigate =
                  issue.code === "tlc_source_location_required"
                    ? props.onOpenLocations
                    : props.onSection
                      ? () => props.onSection?.(section)
                      : null;
                return (
                  <li key={index}>
                    {navigate ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setAnnounceIssues(false);
                          navigate();
                        }}
                      >
                        {label}
                      </Button>
                    ) : (
                      label
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p role="status">{t("usPlan.noValidationIssues")}</p>
          )}
        </div>
      ) : null}
      {preview && !blocked && props.canExport ? (
        <div className="us-plan-preview" role="status">
          <h3 lang="en">DRAFT — not effective</h3>
          <p>{t("usPlan.previewRevision", { revision: preview.revision })}</p>
          {props.draft.provenance === "trusted_synthetic" ? <p>{t("usPlan.synthetic")}</p> : null}
          <p>{t("usPlan.previewHelp")}</p>
          <div className="us-plan-links">
            <a href={preview.url} target="_blank" rel="noopener noreferrer">
              {t("usPlan.openPreview")}
            </a>
            <Button
              variant="secondary"
              onClick={() => {
                if (pending === "preview") {
                  generation.current += 1;
                  busy.current = false;
                  setPending(null);
                }
                releasePreview();
                setPreview(null);
              }}
            >
              {t("usPlan.closePreview")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
