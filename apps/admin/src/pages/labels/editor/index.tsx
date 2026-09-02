/**
 * The `/labels/new` / `/labels/:id` template page after the visual editor's
 * removal (spec 2026-08-20): a settings form (name, size, dpi) + the
 * code-import dialog as the ONLY way to set label content + the read-only
 * "предпросмотр = печать" pane. The drag-and-drop canvas, the element palette
 * and the per-element properties panel are gone -- nothing on this page
 * composes a label element by hand any more; `ImportCodeDialog` parses real
 * ZPL/TSPL into a whole spec and replaces it atomically.
 *
 * WHY THERE IS NO «ЯЗЫК» CONTROL: a `LabelTemplateSpec` is language-NEUTRAL.
 * Code is imported in ZPL or TSPL, parsed into a positional model, and the
 * station generates whichever language ITS printer needs
 * (`apps/station/src/lib/print-label.ts` reads the station's
 * `hardware-config` printer language and deliberately ignores
 * `spec.language`). One template serves Zebra and TSC alike, so the settings
 * panel must not claim otherwise: both downloads are always offered, and
 * `spec.language` survives only as the import dialog's initial format.
 *
 * WHY name IS NOT PART OF THE SPEC STATE: `name` isn't a `LabelTemplateSpec`
 * field at all (it lives on the template's DB row / `LabelTemplateDto`, see
 * `packages/domain/src/labels/model.ts`), so it stays plain component state
 * next to `useSpecState`'s reducer-managed spec.
 *
 * INJECTABLE GENERATION/RASTERIZATION (hard rule): `rasterizeText` and
 * `checkFamilyCoverage` are props of `LabelEditorPage` itself, defaulting to
 * the real browser implementations (`labels/rasterizer.ts`,
 * `labels/fontCoverage.ts`) -- both the download handler below AND
 * `PreviewPane` receive the SAME injected values, so a test can swap in a
 * fake for either (or both) without touching jsdom's canvas-less
 * environment at all.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import {
  EGAIS_PRODUCT_GROUP_CODE,
  generateTspl,
  generateZpl,
  labelTemplateUsesField,
  sampleLabelData,
  type LabelImportResult,
  type LabelTemplateSpec,
  type RasterizeTextFn,
} from "@markiro/domain";
import { Alert, Button, Checkbox, Input, Modal, RadioGroup, Select, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../../api/client.js";
import {
  type LabelFontFamily,
  checkFamilyCoverage as realCheckFamilyCoverage,
} from "../../../labels/fontCoverage.js";
import { rasterizeText as realRasterizeText } from "../../../labels/rasterizer.js";
import { toast } from "../../../lib/toast.js";
import { useChzProductGroups } from "../../catalog/api.js";
import { useCreateLabelTemplate, useLabelTemplate, useUpdateLabelTemplate } from "../api.js";
import { describeDefaultConflict } from "../scope.js";
import "./editor.css";
import { buildTsplBlob, buildZplBlob, downloadBlob, safeFileName } from "./download.js";
import { ImportCodeDialog } from "./ImportCodeDialog.js";
import { PreviewPane } from "./PreviewPane.js";
import { useSpecState } from "./useSpecState.js";

const DEFAULT_SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [],
};

const SIZE_PRESETS = [
  { key: "58x40", widthMm: 58, heightMm: 40 },
  { key: "60x40", widthMm: 60, heightMm: 40 },
  { key: "75x120", widthMm: 75, heightMm: 120 },
  { key: "100x100", widthMm: 100, heightMm: 100 },
  { key: "100x150", widthMm: 100, heightMm: 150 },
] as const;

function matchPresetKey(widthMm: number, heightMm: number): string | null {
  const preset = SIZE_PRESETS.find((p) => p.widthMm === widthMm && p.heightMm === heightMm);
  return preset ? preset.key : null;
}

/**
 * The bounds `labelTemplateSpecSchema` puts on `widthMm`/`heightMm`
 * (`packages/domain/src/labels/model.ts`). Checked HERE, before dispatching a
 * resize, so that an out-of-range or non-numeric entry is reported as what it
 * is instead of reaching `fitSpecElements`, whose only vocabulary is
 * `ELEMENT_TOO_LARGE` -- a different failure that would be a lie about e.g. an
 * empty field on a label with no elements at all.
 */
const MIN_SIZE_MM = 10;
const MAX_SIZE_MM = 300;

const DPI_OPTIONS = ["203", "300"];

export interface LabelEditorPageProps {
  rasterizeText?: RasterizeTextFn;
  checkFamilyCoverage?: (family: LabelFontFamily) => Promise<boolean>;
}

/** Guarded root: resolves route mode (create vs. edit) and the fetch/loading/error states, then hands off to `LabelEditorContent` once the initial spec is known. */
export function LabelEditorPage({
  rasterizeText = realRasterizeText,
  checkFamilyCoverage = realCheckFamilyCoverage,
}: LabelEditorPageProps) {
  const { t } = useTranslation();
  const { id: routeId } = useParams<{ id?: string }>();
  const id = routeId ?? null;
  const templateQuery = useLabelTemplate(id);

  if (id !== null) {
    if (templateQuery.isPending) {
      return (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner label={t("common.loading")} />
        </div>
      );
    }
    if (templateQuery.isError || !templateQuery.data) {
      return (
        <div style={{ padding: "28px 32px" }}>
          <Alert tone="error">{t("pages.labels.editor.loadError")}</Alert>
        </div>
      );
    }
    return (
      <LabelEditorContent
        key={id}
        mode="edit"
        id={id}
        initialName={templateQuery.data.name}
        initialSpec={templateQuery.data.spec}
        initialEnabled={templateQuery.data.enabled}
        initialProductGroupCodes={templateQuery.data.chzProductGroupCodes}
        rasterizeText={rasterizeText}
        checkFamilyCoverage={checkFamilyCoverage}
      />
    );
  }

  return (
    <LabelEditorContent
      key="new"
      mode="create"
      initialName={t("pages.labels.editor.defaultName")}
      initialSpec={DEFAULT_SPEC}
      initialEnabled
      initialProductGroupCodes={null}
      rasterizeText={rasterizeText}
      checkFamilyCoverage={checkFamilyCoverage}
    />
  );
}

interface LabelEditorContentProps {
  mode: "create" | "edit";
  id?: string;
  initialName: string;
  initialSpec: LabelTemplateSpec;
  initialEnabled: boolean;
  /** `null` = every category (see `LabelTemplateDto.chzProductGroupCodes`). */
  initialProductGroupCodes: number[] | null;
  rasterizeText: RasterizeTextFn;
  checkFamilyCoverage: (family: LabelFontFamily) => Promise<boolean>;
}

function LabelEditorContent({
  mode,
  id,
  initialName,
  initialSpec,
  initialEnabled,
  initialProductGroupCodes,
  rasterizeText,
  checkFamilyCoverage,
}: LabelEditorContentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const editor = useSpecState(initialSpec);
  const [name, setName] = useState(initialName);
  // Selection metadata lives beside `name`, not in the spec state: like the
  // name it is not part of the print model (see the file doc comment).
  const [enabled, setEnabled] = useState(initialEnabled);
  const [scopeMode, setScopeMode] = useState<"all" | "selected">(
    initialProductGroupCodes === null ? "all" : "selected",
  );
  const [selectedCodes, setSelectedCodes] = useState<number[]>(initialProductGroupCodes ?? []);
  const [scopeSearch, setScopeSearch] = useState("");
  const [scopeError, setScopeError] = useState<string | null>(null);
  // The dictionary is only needed once the operator narrows the scope.
  const groupsQuery = useChzProductGroups({ enabled: scopeMode === "selected" });
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);
  const [dirty, setDirty] = useState(false);
  const [showDirtyConfirm, setShowDirtyConfirm] = useState(false);
  const [customSize, setCustomSize] = useState(
    () => matchPresetKey(initialSpec.widthMm, initialSpec.heightMm) === null,
  );
  const [showImportDialog, setShowImportDialog] = useState(false);
  /**
   * WHY THE CUSTOM-SIZE INPUTS ARE DRAFTED, NOT CONTROLLED BY THE SPEC: a
   * resize that cannot fit the imported elements keeps the OLD spec (see
   * `useSpecState`), so a spec-controlled input snaps back mid-typing and a
   * multi-digit number can never be entered at all ("58.1" -> type "4" -> a
   * 4mm label is rejected -> the field reverts). `null` means "no pending
   * edit, show the spec"; a string is what the user has typed so far, and it
   * is committed on blur / Enter -- never per keystroke.
   */
  const [widthDraft, setWidthDraft] = useState<string | null>(null);
  const [heightDraft, setHeightDraft] = useState<string | null>(null);
  /**
   * WHY THE INVALID-DIMENSION FLAG IS PER-AXIS: the drafts are per-axis and a
   * rejected entry deliberately STAYS in its field, so a single shared flag
   * would be cleared by a valid commit on the OTHER axis -- leaving the
   * rejected text on screen with no error next to it, i.e. a field showing a
   * size the spec does not hold and Save would not post.
   */
  const [invalidSizeAxes, setInvalidSizeAxes] = useState<{ width: boolean; height: boolean }>({
    width: false,
    height: false,
  });
  const hasInvalidSize = invalidSizeAxes.width || invalidSizeAxes.height;

  const createMutation = useCreateLabelTemplate();
  const updateMutation = useUpdateLabelTemplate();

  const spec = editor.state.spec;
  const egaisOutsideScope =
    scopeMode === "selected" &&
    !selectedCodes.includes(EGAIS_PRODUCT_GROUP_CODE) &&
    labelTemplateUsesField(spec, "product.egais");
  const visibleGroups = useMemo(() => {
    const needle = scopeSearch.trim().toLocaleLowerCase("ru");
    return needle
      ? groups.filter((group) => group.name.toLocaleLowerCase("ru").includes(needle))
      : groups;
  }, [groups, scopeSearch]);

  function toggleCode(code: number, checked: boolean): void {
    setScopeError(null);
    setDirty(true);
    setSelectedCodes((current) =>
      checked
        ? [...current, code].sort((a, b) => a - b)
        : current.filter((value) => value !== code),
    );
  }

  function markDirty(): void {
    setDirty(true);
  }

  function handleNameChange(value: string): void {
    setName(value);
    markDirty();
  }

  /** Drops any pending (uncommitted) size edit and the invalid-dimension
   * message, so the inputs fall back to whatever the spec now says. */
  function clearSizeDrafts(): void {
    setWidthDraft(null);
    setHeightDraft(null);
    setInvalidSizeAxes({ width: false, height: false });
  }

  function setAxisInvalid(axis: "width" | "height", invalid: boolean): void {
    setInvalidSizeAxes((current) =>
      current[axis] === invalid ? current : { ...current, [axis]: invalid },
    );
  }

  function handleReplaceSpec(nextSpec: LabelTemplateSpec): void {
    editor.replaceSpec(nextSpec);
    markDirty();
  }

  function handleLabelResize(widthMm: number, heightMm: number): void {
    editor.resizeLabel(widthMm, heightMm);
    markDirty();
  }

  function handleImportReplace(result: LabelImportResult): void {
    editor.replaceSpec(result.spec);
    setCustomSize(matchPresetKey(result.spec.widthMm, result.spec.heightMm) === null);
    clearSizeDrafts();
    markDirty();
    setShowImportDialog(false);
  }

  function handleSizePresetChange(value: string): void {
    clearSizeDrafts();
    if (value === "custom") {
      setCustomSize(true);
      return;
    }
    const preset = SIZE_PRESETS.find((p) => p.key === value);
    if (!preset) return;
    setCustomSize(false);
    handleLabelResize(preset.widthMm, preset.heightMm);
  }

  /**
   * Commits one axis of the custom size. An empty, non-numeric or
   * out-of-bounds entry stops here with its own message and leaves the typed
   * text in place to be corrected; a valid one drops the draft (the input goes
   * back to mirroring the spec) and lets the reducer have the final say on
   * whether the elements still fit.
   */
  function commitSize(axis: "width" | "height"): void {
    const raw = axis === "width" ? widthDraft : heightDraft;
    // Nothing typed since the last commit: a bare focus/blur must not
    // re-dispatch a resize (and mark the page dirty) for the value the spec
    // already holds.
    if (raw === null) return;
    const value = Number(raw.trim());
    if (
      raw.trim() === "" ||
      !Number.isFinite(value) ||
      value < MIN_SIZE_MM ||
      value > MAX_SIZE_MM
    ) {
      setAxisInvalid(axis, true);
      return;
    }
    setAxisInvalid(axis, false);
    if (axis === "width") {
      setWidthDraft(null);
      handleLabelResize(value, spec.heightMm);
    } else {
      setHeightDraft(null);
      handleLabelResize(spec.widthMm, value);
    }
  }

  async function handleSave(): Promise<void> {
    // A flagged axis still shows its rejected text in the input (see
    // `invalidSizeAxes`'s doc comment above) -- the spec was never updated,
    // so saving now would silently persist the last COMMITTED size instead
    // of the one on screen. Refuse until the user fixes or clears it.
    if (hasInvalidSize) return;
    if (scopeMode === "selected" && selectedCodes.length === 0) {
      setScopeError(t("pages.labels.editor.scopeEmptyError"));
      return;
    }
    const chzProductGroupCodes = scopeMode === "all" ? null : selectedCodes;
    try {
      if (mode === "edit" && id) {
        await updateMutation.mutateAsync({
          id,
          input: { name, spec, enabled, chzProductGroupCodes },
        });
        toast("ok", t("pages.labels.editor.toasts.updateSuccess"));
        setDirty(false);
      } else {
        const created = await createMutation.mutateAsync({
          name,
          spec,
          enabled,
          chzProductGroupCodes,
        });
        toast("ok", t("pages.labels.editor.toasts.createSuccess"));
        setDirty(false);
        void navigate(`/labels/${created.id}`, { replace: true });
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "LABEL_TEMPLATE_IS_DEFAULT") {
        toast("error", describeDefaultConflict(error.details, groups, t), 8000);
        return;
      }
      const fallback =
        mode === "edit"
          ? t("pages.labels.editor.toasts.updateError")
          : t("pages.labels.editor.toasts.createError");
      toast("error", error instanceof ApiRequestError ? error.message : fallback);
    }
  }

  /**
   * Both downloads are generated from the SAME spec on demand -- nothing on
   * the template picks one language over the other, so neither button is ever
   * disabled or hidden.
   */
  async function handleDownload(format: "zpl" | "tspl"): Promise<void> {
    const sample = sampleLabelData();
    try {
      if (format === "zpl") {
        const text = await generateZpl(spec, sample, { rasterizeText });
        downloadBlob(buildZplBlob(text), `${safeFileName(name)}.zpl`);
      } else {
        const text = await generateTspl(spec, sample, { rasterizeText });
        downloadBlob(buildTsplBlob(text), `${safeFileName(name)}.tspl`);
      }
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    }
  }

  function handleBack(): void {
    if (dirty) {
      setShowDirtyConfirm(true);
    } else {
      void navigate("/labels");
    }
  }

  function handleConfirmDiscard(): void {
    setShowDirtyConfirm(false);
    void navigate("/labels");
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="label-editor">
      <div className="label-editor__toolbar">
        <a
          href="/labels"
          onClick={(event) => {
            event.preventDefault();
            handleBack();
          }}
          style={{
            color: "var(--fg-3)",
            cursor: "pointer",
            textDecoration: "none",
            font: "400 13px/18px var(--font-ui)",
          }}
        >
          {t("pages.labels.editor.back")}
        </a>
        <Input
          aria-label={t("pages.labels.editor.nameLabel")}
          value={name}
          onChange={(event) => handleNameChange(event.target.value)}
          style={{ width: 260 }}
        />
        <span style={{ flex: 1 }} />
        <Button
          type="button"
          loading={isSaving}
          disabled={hasInvalidSize}
          onClick={() => void handleSave()}
        >
          {t("pages.labels.editor.save")}
        </Button>
      </div>

      <div className="label-editor__body">
        <aside
          className="label-editor__settings"
          aria-label={t("pages.labels.editor.settingsTitle")}
        >
          <Select
            label={t("pages.labels.editor.sizePresetLabel")}
            options={[
              ...SIZE_PRESETS.map((preset) => ({
                value: preset.key,
                label: `${preset.widthMm}×${preset.heightMm}`,
              })),
              { value: "custom", label: t("pages.labels.editor.customSizeOption") },
            ]}
            value={
              customSize ? "custom" : (matchPresetKey(spec.widthMm, spec.heightMm) ?? "custom")
            }
            onValueChange={handleSizePresetChange}
          />
          {customSize && (
            <div className="label-editor__size-inputs">
              <Input
                label={t("pages.labels.editor.widthLabel")}
                type="number"
                min={MIN_SIZE_MM}
                max={MAX_SIZE_MM}
                step={0.1}
                mono
                value={widthDraft ?? spec.widthMm.toFixed(1)}
                {...(invalidSizeAxes.width
                  ? { error: t("pages.labels.editor.invalidSizeError") }
                  : {})}
                onChange={(event) => {
                  setWidthDraft(event.target.value);
                  // Retyping answers the complaint; keeping the message up
                  // would have it contradict what the field now reads.
                  setAxisInvalid("width", false);
                }}
                onBlur={() => commitSize("width")}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  commitSize("width");
                }}
              />
              <Input
                label={t("pages.labels.editor.heightLabel")}
                type="number"
                min={MIN_SIZE_MM}
                max={MAX_SIZE_MM}
                step={0.1}
                mono
                value={heightDraft ?? spec.heightMm.toFixed(1)}
                {...(invalidSizeAxes.height
                  ? { error: t("pages.labels.editor.invalidSizeError") }
                  : {})}
                onChange={(event) => {
                  setHeightDraft(event.target.value);
                  setAxisInvalid("height", false);
                }}
                onBlur={() => commitSize("height")}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  commitSize("height");
                }}
              />
            </div>
          )}
          <Select
            label={t("pages.labels.editor.dpiLabel")}
            options={DPI_OPTIONS}
            value={String(spec.dpi)}
            onValueChange={(value) =>
              handleReplaceSpec({ ...spec, dpi: value === "300" ? 300 : 203 })
            }
          />
          <Checkbox
            label={t("pages.labels.editor.enabledLabel")}
            hint={t("pages.labels.editor.enabledHint")}
            checked={enabled}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              setDirty(true);
            }}
          />
          <RadioGroup
            label={t("pages.labels.editor.scopeTitle")}
            value={scopeMode}
            {...(scopeError ? { error: scopeError } : {})}
            onValueChange={(value) => {
              setScopeMode(value === "selected" ? "selected" : "all");
              setScopeError(null);
              setDirty(true);
              if (value !== "selected") setSelectedCodes([]);
            }}
            options={[
              { value: "all", label: t("pages.labels.editor.scopeAll") },
              { value: "selected", label: t("pages.labels.editor.scopeSelected") },
            ]}
          />
          {scopeMode === "selected" ? (
            <div className="label-editor__scope">
              <Input
                aria-label={t("pages.labels.editor.scopeSearch")}
                placeholder={t("pages.labels.editor.scopeSearch")}
                value={scopeSearch}
                onChange={(event) => setScopeSearch(event.target.value)}
              />
              {groupsQuery.isError ? (
                <Alert tone="error">{t("pages.labels.editor.scopeLoadError")}</Alert>
              ) : (
                <div className="label-editor__scope-list">
                  {visibleGroups.map((group) => (
                    <Checkbox
                      key={group.code}
                      label={group.name}
                      checked={selectedCodes.includes(group.code)}
                      onCheckedChange={(checked) => toggleCode(group.code, checked)}
                    />
                  ))}
                </div>
              )}
              {egaisOutsideScope ? (
                <Alert tone="warn">{t("pages.labels.editor.egaisScopeHint")}</Alert>
              ) : null}
            </div>
          ) : null}
          <p className="label-editor__languages-note">
            {t("pages.labels.editor.bothLanguagesNote")}
          </p>
          <Button type="button" onClick={() => setShowImportDialog(true)}>
            {t("pages.labels.editor.import.open")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void handleDownload("zpl")}>
            {t("pages.labels.editor.download", { format: "ZPL" })}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void handleDownload("tspl")}>
            {t("pages.labels.editor.download", { format: "TSPL (TSC)" })}
          </Button>
          {/* The invalid-dimension message wins when it is set: it describes
              the most recent action (a rejected entry never reached the
              reducer, so a stale `geometryError` from an earlier resize must
              not be presented as the reason). */}
          {hasInvalidSize ? (
            <Alert tone="error">{t("pages.labels.editor.invalidSizeError")}</Alert>
          ) : (
            editor.state.geometryError !== null && (
              <Alert tone="error">{t("pages.labels.editor.geometryError")}</Alert>
            )
          )}
        </aside>

        <main
          className="label-editor__workspace"
          aria-label={t("pages.labels.editor.preview.caption")}
        >
          {spec.elements.length === 0 && (
            <p className="label-editor__empty">{t("pages.labels.editor.empty")}</p>
          )}
          <PreviewPane
            spec={spec}
            rasterizeText={rasterizeText}
            checkFamilyCoverage={checkFamilyCoverage}
          />
        </main>
      </div>

      <Modal
        open={showDirtyConfirm}
        onClose={() => setShowDirtyConfirm(false)}
        closeLabel={t("common.close")}
        title={t("pages.labels.editor.dirtyGuard.title")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setShowDirtyConfirm(false)}>
              {t("pages.labels.editor.dirtyGuard.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={handleConfirmDiscard}>
              {t("pages.labels.editor.dirtyGuard.discard")}
            </Button>
          </>
        }
      >
        <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {t("pages.labels.editor.dirtyGuard.body")}
        </p>
      </Modal>

      <ImportCodeDialog
        open={showImportDialog}
        initialLanguage={spec.language}
        initialDpi={spec.dpi}
        currentDirty={dirty}
        onClose={() => setShowImportDialog(false)}
        onReplace={handleImportReplace}
      />
    </div>
  );
}
