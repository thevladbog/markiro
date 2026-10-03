import { useEffect, useRef, useState } from "react";
import { Button, DataTabs, Input, StatusChip } from "@markiro/ui";
import type { UsPlanDetailResponse, UsPlanDraftSaveBody } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { SectionFields, sectionIds, type SectionId } from "./section-fields.js";
import { PlanInspection } from "./inspection.js";

type Draft = Extract<UsPlanDetailResponse, { status: "draft" }>;
export type PlanEditorState = { dirty: boolean; saving: boolean; draftRevision: number };
export type PlanEditorProps = {
  draft: Draft;
  profile: Awaited<ReturnType<UsBrowserClient["profile"]>>;
  canManageQa: boolean;
  actionPending?: boolean;
  inspection?: { client: UsBrowserClient; canExport: boolean };
  onSave: (id: string, body: UsPlanDraftSaveBody) => ReturnType<UsBrowserClient["savePlan"]>;
  onReload: () => Promise<UsPlanDetailResponse | null>;
  onDirtyChange: (dirty: boolean) => void;
  onStateChange?: (state: PlanEditorState) => void;
  onMutationPendingChange?: (pending: boolean) => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
  onOpenProfile: () => void;
  onOpenLocations: () => void;
  onOpenProducts: () => void;
};
export function PlanEditor(props: PlanEditorProps) {
  const { t } = useTranslation();
  const { onDirtyChange, onStateChange, onMutationPendingChange } = props;
  const [acknowledged, setAcknowledged] = useState(props.draft);
  const [sections, setSections] = useState(props.draft.sections);
  const [changeSummary, setChangeSummary] = useState(props.draft.changeSummary);
  const [section, setSection] = useState<SectionId>("recordMaintenance");
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const previousAccess = useRef(props.canManageQa);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLElement>(null);
  const [issueFocus, setIssueFocus] = useState<{ section: SectionId | "plan" } | null>(null);
  const dirty =
    JSON.stringify(sections) !== JSON.stringify(acknowledged.sections) ||
    changeSummary !== acknowledged.changeSummary;
  const disabled = !props.canManageQa || blocked || saving || Boolean(props.actionPending);
  const summaryMissing = acknowledged.versionNumber > 1 && !changeSummary.trim();
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    // Only the workspace's verified access transition restores a denied write.
    // UI action locks and a void refresh callback cannot prove restored access.
    if (!previousAccess.current && props.canManageQa) {
      setBlocked(false);
      setError((current) => (current === "usPlan.writeForbidden" ? null : current));
    }
    previousAccess.current = props.canManageQa;
  }, [props.canManageQa]);
  useEffect(() => {
    if (!issueFocus) return;
    if (issueFocus.section === "plan")
      editor.current?.querySelector<HTMLElement>("#us-plan-change-summary")?.focus();
    else panel.current?.focus();
  }, [issueFocus]);
  useEffect(() => {
    onDirtyChange(dirty || saving);
    onStateChange?.({ dirty, saving, draftRevision: acknowledged.draftRevision });
  }, [dirty, saving, acknowledged.draftRevision, onDirtyChange, onStateChange]);
  useEffect(() => {
    // Saving includes access recovery after a rejection. Release on unmount too:
    // revoked READ or a newly published version can remove this editor first.
    onMutationPendingChange?.(saving);
    return () => onMutationPendingChange?.(false);
  }, [saving, onMutationPendingChange]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty, saving]);
  async function failure(value: unknown) {
    if (value instanceof UsClientError) {
      if (value.code === "forbidden") {
        setBlocked(true);
        setError("usPlan.writeForbidden");
        await props.onForbidden();
        return;
      }
      if (value.code === "session_required") {
        setBlocked(true);
        props.onSessionLost();
        return;
      }
      if (value.code === "us_plan_revision_conflict" || value.code === "us_plan_not_draft") {
        setError("usPlan.staleDraft");
        return;
      }
    }
    setError("usPlan.saveError");
  }
  async function save() {
    if (disabled || busy.current || !dirty || summaryMissing) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await props.onSave(acknowledged.id, {
        expectedRevision: acknowledged.draftRevision,
        sections,
        changeSummary,
      });
      setAcknowledged({ ...result, provenance: acknowledged.provenance });
      setSections(result.sections);
      setChangeSummary(result.changeSummary);
    } catch (value) {
      await failure(value);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  async function reload(reportFailure = true) {
    if (busy.current || props.actionPending) return;
    busy.current = true;
    setSaving(true);
    try {
      const result = await props.onReload();
      if (result?.status !== "draft") {
        setError("usPlan.staleDraft");
        return;
      }
      setAcknowledged(result);
      setSections(result.sections);
      setChangeSummary(result.changeSummary);
      setError(null);
    } catch (value) {
      if (reportFailure) await failure(value);
      else {
        // Inspection owns the error UI/access refresh, but a denied editor read
        // must retain the same write latch as its own reload button.
        if (
          value instanceof UsClientError &&
          (value.code === "forbidden" || value.code === "session_required")
        )
          setBlocked(true);
        throw value;
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  return (
    <article ref={editor} className="us-plan-editor" aria-label={t("usPlan.editDraft")}>
      <h2 ref={heading} tabIndex={-1}>
        v{acknowledged.versionNumber} · {t("usPlan.draftMark")}
      </h2>
      <StatusChip
        status="neutral"
        label={t(
          acknowledged.provenance === "trusted_synthetic"
            ? "usPlan.synthetic"
            : "usPlan.operational",
        )}
      />
      <p role="status">
        {t(saving ? "usPlan.saving" : dirty ? "usPlan.unsaved" : "usPlan.savedRevision", {
          revision: acknowledged.draftRevision,
        })}
      </p>
      <Input
        id="us-plan-change-summary"
        label={t("usPlan.changeSummary")}
        value={changeSummary}
        maxLength={4096}
        disabled={disabled}
        required={acknowledged.versionNumber > 1}
        {...(summaryMissing ? { error: t("usPlan.summaryRequired") } : {})}
        onChange={(event) => setChangeSummary(event.target.value)}
      />
      <section className="us-plan-context" aria-label={t("usPlan.configured")}>
        <h3>{t("usPlan.configured")}</h3>
        <p>{t("usPlan.currentContext")}</p>
        <dl className="us-plan-metadata">
          <div>
            <dt>{t("usPlan.fields.profileCode")}</dt>
            <dd>{t(`usPlan.values.${props.profile.code}`)}</dd>
          </div>
          <div>
            <dt>{t("usPlan.fields.timeZone")}</dt>
            <dd>{props.profile.timeZone}</dd>
          </div>
          <div>
            <dt>{t("usPlan.fields.retentionYears")}</dt>
            <dd>{props.profile.retentionYears}</dd>
          </div>
        </dl>
        <p>{t("usPlan.retentionLimit")}</p>
        <div className="us-plan-links">
          <Button variant="secondary" disabled={saving} onClick={props.onOpenProfile}>
            {t("usPlan.openProfile")}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={props.onOpenLocations}>
            {t("usPlan.openLocations")}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={props.onOpenProducts}>
            {t("usPlan.openProducts")}
          </Button>
        </div>
      </section>
      <h3>{t("usPlan.operator_pending")}</h3>
      <p id="us-plan-operator-help">{t("usPlan.operatorHelp")}</p>
      <DataTabs
        label={t("usPlan.statements")}
        items={sectionIds.map((id) => ({
          id,
          label: t(`usPlan.fields.${id}`),
          panelId: `us-plan-panel-${id}`,
        }))}
        activeId={section}
        onChange={setSection}
      />
      <div
        ref={panel}
        tabIndex={-1}
        role="tabpanel"
        id={`us-plan-panel-${section}`}
        aria-label={t(`usPlan.fields.${section}`)}
        className="us-plan-fields"
      >
        <SectionFields
          section={section}
          sections={sections}
          onChange={setSections}
          disabled={disabled}
        />
      </div>
      {error ? <p role="alert">{t(error)}</p> : null}
      <div className="us-plan-links">
        <Button disabled={disabled || !dirty || summaryMissing} onClick={() => void save()}>
          {t("usPlan.saveDraft")}
        </Button>
        {error ? (
          <Button
            variant="secondary"
            disabled={saving || props.actionPending}
            onClick={() => void reload()}
          >
            {t("usPlan.reloadDiscard")}
          </Button>
        ) : null}
      </div>
      {props.inspection ? (
        <PlanInspection
          key={`${acknowledged.id}:${acknowledged.draftRevision}`}
          client={props.inspection.client}
          draft={acknowledged}
          dirty={dirty}
          saving={saving || Boolean(props.actionPending)}
          canValidate={props.canManageQa && !blocked}
          canExport={props.inspection.canExport}
          onSection={(id) => {
            if (id !== "plan") setSection(id);
            setIssueFocus({ section: id });
          }}
          onOpenLocations={props.onOpenLocations}
          onReload={() => reload(false)}
          onForbidden={props.onForbidden}
          onSessionLost={props.onSessionLost}
        />
      ) : null}
    </article>
  );
}
