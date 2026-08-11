/**
 * Plan 04 Task 10: label editor chrome -- the full `/labels/new` /
 * `/labels/:id` editor page. Composes Task 9's `LabelCanvas`/`useEditorState`
 * with this task's `Palette` (left), `PropertiesPanel` (right), `PreviewPane`
 * (the "предпросмотр = печать" WYSIWYG pane), a top toolbar (back link,
 * name, label-level size/dpi/language settings, download, save), and a
 * dirty-guard confirm modal on the back action.
 *
 * WHY LABEL-LEVEL SETTINGS (name/size/dpi/language) LIVE HERE, NOT IN
 * `PropertiesPanel.tsx`: the handoff prototype puts them in the top toolbar
 * (name + size/dpi pill + language pill), visually separate from the right
 * sidebar's per-ELEMENT properties -- this file mirrors that split. `name`
 * in particular isn't even part of `LabelTemplateSpec` (it lives on the
 * template's DB row / `LabelTemplateDto`, not the domain model -- see
 * `packages/domain/src/labels/model.ts`), so it can't live inside the
 * reducer-managed spec at all; `widthMm`/`heightMm`/`dpi`/`language` ARE
 * spec fields and are changed here via `useEditorState`'s existing
 * `replaceSpec` action (no new reducer action needed).
 *
 * INJECTABLE GENERATION/RASTERIZATION (hard rule): `rasterizeText` and
 * `checkFamilyCoverage` are props of `LabelEditorPage` itself, defaulting to
 * the real browser implementations (`labels/rasterizer.ts`,
 * `labels/fontCoverage.ts`) -- both the download handler below AND
 * `PreviewPane` receive the SAME injected values, so a test can swap in a
 * fake for either (or both) without touching jsdom's canvas-less
 * environment at all.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import {
  generateTspl,
  generateZpl,
  sampleLabelData,
  type LabelElement,
  type LabelImportResult,
  type LabelTemplateSpec,
  type RasterizeTextFn,
} from "@markiro/domain";
import { Alert, Button, Input, Modal, Select, Spinner } from "@markiro/ui";

import { ApiRequestError } from "../../../api/client.js";
import {
  type LabelFontFamily,
  checkFamilyCoverage as realCheckFamilyCoverage,
} from "../../../labels/fontCoverage.js";
import { rasterizeText as realRasterizeText } from "../../../labels/rasterizer.js";
import { toast } from "../../../lib/toast.js";
import { useCreateLabelTemplate, useLabelTemplate, useUpdateLabelTemplate } from "../api.js";
import "./editor.css";
import { buildTsplBlob, buildZplBlob, downloadBlob, safeFileName } from "./download.js";
import { LabelCanvas } from "./LabelCanvas.js";
import { ImportCodeDialog } from "./ImportCodeDialog.js";
import { Palette } from "./Palette.js";
import { PreviewPane } from "./PreviewPane.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { useEditorState } from "./useEditorState.js";

const DEFAULT_SPEC: LabelTemplateSpec = {
  widthMm: 100,
  heightMm: 100,
  dpi: 203,
  language: "zpl",
  elements: [],
};

const SIZE_PRESETS = [
  { key: "58x40", widthMm: 58, heightMm: 40 },
  { key: "100x100", widthMm: 100, heightMm: 100 },
  { key: "100x150", widthMm: 100, heightMm: 150 },
] as const;

function matchPresetKey(widthMm: number, heightMm: number): string | null {
  const preset = SIZE_PRESETS.find((p) => p.widthMm === widthMm && p.heightMm === heightMm);
  return preset ? preset.key : null;
}

const DPI_OPTIONS = ["203", "300"];
const LANGUAGE_OPTIONS: Array<{ value: LabelTemplateSpec["language"]; label: string }> = [
  { value: "zpl", label: "ZPL" },
  { value: "tspl", label: "TSPL" },
];

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
  rasterizeText: RasterizeTextFn;
  checkFamilyCoverage: (family: LabelFontFamily) => Promise<boolean>;
}

function LabelEditorContent({
  mode,
  id,
  initialName,
  initialSpec,
  rasterizeText,
  checkFamilyCoverage,
}: LabelEditorContentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const editor = useEditorState(initialSpec);
  const [name, setName] = useState(initialName);
  const [dirty, setDirty] = useState(false);
  const [showDirtyConfirm, setShowDirtyConfirm] = useState(false);
  const [customSize, setCustomSize] = useState(
    () => matchPresetKey(initialSpec.widthMm, initialSpec.heightMm) === null,
  );
  const [propertiesCollapsed, setPropertiesCollapsed] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);

  const createMutation = useCreateLabelTemplate();
  const updateMutation = useUpdateLabelTemplate();

  const spec = editor.state.spec;
  const selectedElement = spec.elements.find((el) => el.id === editor.state.selectedId) ?? null;

  function markDirty(): void {
    setDirty(true);
  }

  function handleAddElement(element: LabelElement): void {
    editor.addElement(element);
    markDirty();
  }

  function handlePropertyChange(elementId: string, patch: Partial<LabelElement>): void {
    editor.setElement(elementId, patch);
    markDirty();
  }

  function handleDeleteElement(elementId: string): void {
    editor.removeElement(elementId);
    markDirty();
  }

  function handleMoveBy(elementId: string, dxMm: number, dyMm: number): void {
    editor.moveBy(elementId, dxMm, dyMm);
    markDirty();
  }

  function handleNameChange(value: string): void {
    setName(value);
    markDirty();
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
    editor.select(null);
    markDirty();
    setShowImportDialog(false);
  }

  function handleSizePresetChange(value: string): void {
    if (value === "custom") {
      setCustomSize(true);
      return;
    }
    const preset = SIZE_PRESETS.find((p) => p.key === value);
    if (!preset) return;
    setCustomSize(false);
    handleLabelResize(preset.widthMm, preset.heightMm);
  }

  async function handleSave(): Promise<void> {
    try {
      if (mode === "edit" && id) {
        await updateMutation.mutateAsync({ id, input: { name, spec } });
        toast("ok", t("pages.labels.editor.toasts.updateSuccess"));
        setDirty(false);
      } else {
        const created = await createMutation.mutateAsync({ name, spec });
        toast("ok", t("pages.labels.editor.toasts.createSuccess"));
        setDirty(false);
        void navigate(`/labels/${created.id}`, { replace: true });
      }
    } catch (error) {
      const fallback =
        mode === "edit"
          ? t("pages.labels.editor.toasts.updateError")
          : t("pages.labels.editor.toasts.createError");
      toast("error", error instanceof ApiRequestError ? error.message : fallback);
    }
  }

  async function handleDownload(): Promise<void> {
    const sample = sampleLabelData();
    try {
      if (spec.language === "zpl") {
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
          style={{ width: 220 }}
        />
        <Select
          aria-label={t("pages.labels.editor.sizePresetLabel")}
          options={[
            ...SIZE_PRESETS.map((preset) => ({
              value: preset.key,
              label: `${preset.widthMm}×${preset.heightMm}`,
            })),
            { value: "custom", label: t("pages.labels.editor.customSizeOption") },
          ]}
          value={customSize ? "custom" : (matchPresetKey(spec.widthMm, spec.heightMm) ?? "custom")}
          onValueChange={handleSizePresetChange}
          style={{ width: 140 }}
        />
        {customSize && (
          <>
            <Input
              aria-label={t("pages.labels.editor.widthLabel")}
              type="number"
              mono
              value={spec.widthMm}
              onChange={(event) =>
                handleLabelResize(Number(event.target.value) || 0, spec.heightMm)
              }
              style={{ width: 90 }}
            />
            <Input
              aria-label={t("pages.labels.editor.heightLabel")}
              type="number"
              mono
              value={spec.heightMm}
              onChange={(event) => handleLabelResize(spec.widthMm, Number(event.target.value) || 0)}
              style={{ width: 90 }}
            />
          </>
        )}
        <Select
          aria-label={t("pages.labels.editor.dpiLabel")}
          options={DPI_OPTIONS}
          value={String(spec.dpi)}
          onValueChange={(value) =>
            handleReplaceSpec({ ...spec, dpi: value === "300" ? 300 : 203 })
          }
          style={{ width: 100 }}
        />
        <Select
          aria-label={t("pages.labels.editor.languageLabel")}
          options={LANGUAGE_OPTIONS}
          value={spec.language}
          onValueChange={(value) => handleReplaceSpec({ ...spec, language: value })}
          style={{ width: 100 }}
        />
        <span style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={() => setShowImportDialog(true)}>
          {t("pages.labels.editor.import.open")}
        </Button>
        <Button type="button" variant="secondary" onClick={() => void handleDownload()}>
          {t("pages.labels.editor.download", { format: spec.language.toUpperCase() })}
        </Button>
        <Button type="button" loading={isSaving} onClick={() => void handleSave()}>
          {t("pages.labels.editor.save")}
        </Button>
      </div>

      <div
        className={`label-editor__body${propertiesCollapsed ? " label-editor__body--properties-collapsed" : ""}`}
      >
        <aside
          className="label-editor__palette-region"
          aria-label={t("pages.labels.editor.palette.title")}
        >
          <Palette
            labelWidthMm={spec.widthMm}
            labelHeightMm={spec.heightMm}
            onAdd={handleAddElement}
          />
        </aside>

        <main
          className="label-editor__workspace"
          aria-label={t("pages.labels.editor.workspaceLabel")}
        >
          <LabelCanvas
            spec={spec}
            selectedId={editor.state.selectedId}
            onSelect={editor.select}
            onMoveBy={handleMoveBy}
            onDelete={handleDeleteElement}
          />
          <PreviewPane
            spec={spec}
            rasterizeText={rasterizeText}
            checkFamilyCoverage={checkFamilyCoverage}
          />
        </main>

        <aside
          className="label-editor__properties"
          aria-label={t("pages.labels.editor.properties.title")}
        >
          {propertiesCollapsed ? (
            <Button
              type="button"
              variant="secondary"
              size="compact"
              className="label-editor__reopen-properties"
              aria-label={t("pages.labels.editor.properties.expand")}
              onClick={() => setPropertiesCollapsed(false)}
            >
              {t("pages.labels.editor.properties.expand")}
            </Button>
          ) : (
            <PropertiesPanel
              element={selectedElement}
              onChange={handlePropertyChange}
              onDelete={handleDeleteElement}
              onCollapse={() => setPropertiesCollapsed(true)}
              geometryError={editor.state.geometryError}
            />
          )}
        </aside>
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
