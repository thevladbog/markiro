import { useContext, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useBeforeUnload, UNSAFE_DataRouterContext } from "react-router";
import {
  buildPalletSheetPresets,
  serializeStoredLabelJson,
  type PalletSheetSpecV2,
  type RasterizeTextFn,
  sheetNodeSchema,
} from "@markiro/domain";
import { Alert, Button, Checkbox, Input, Modal, PageHeader, Textarea } from "@markiro/ui";
import { ApiRequestError } from "../../../../api/client.js";
import { useCreateLabelTemplate, useUpdateLabelTemplate } from "../../api.js";
import { buildJsonBlob, downloadBlob, safeFileName } from "../download.js";
import { SheetNavigationGuard } from "./SheetNavigationGuard.js";
import { SheetEditor } from "./SheetEditor.js";
import { SheetCanvas } from "./SheetCanvas.js";
import { loadCabinetSheetBranding } from "./sheet-branding.js";
import {
  useSheetSpecState,
  findSheetNode,
  replaceSheetNode,
  sheetNodeParent,
} from "./useSheetSpecState.js";
import { rasterizeText as realRasterizeText } from "../../../../labels/rasterizer.js";
import { SheetScopePicker } from "./SheetScopePicker.js";
import { analyzeSheetImport, type SheetImportValue } from "./sheet-import.js";
export interface SheetTemplateRecord {
  id: string;
  name: string;
  spec: PalletSheetSpecV2;
  revision: number;
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
}
export interface SheetTemplatePageProps {
  template?: SheetTemplateRecord;
  initialPresetKey?: string;
  rasterizeText?: RasterizeTextFn;
}
function startingSheet(key?: string): SheetImportValue {
  const presets = buildPalletSheetPresets();
  const preset = presets.find((p) => p.key === key) ?? presets[0];
  if (!preset) throw new Error("Missing A4 preset");
  return {
    name: key === "blank" ? "Палета А4" : preset.name,
    purpose: "pallet",
    spec: key === "blank" ? { ...preset.spec, body: [] } : preset.spec,
  };
}
export function SheetTemplatePage({
  template,
  initialPresetKey,
  rasterizeText = realRasterizeText,
}: SheetTemplatePageProps) {
  const { t } = useTranslation(),
    navigate = useNavigate();
  const initial = template ?? startingSheet(initialPresetKey);
  const [name, setName] = useState(initial.name);
  const editor = useSheetSpecState(initial.spec);
  const spec = editor.spec;
  const setSpec = editor.change;
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
  const [scope, setScope] = useState<number[] | null>(template?.chzProductGroupCodes ?? null);
  const [revision, setRevision] = useState(template?.revision ?? 1);
  const [copying, setCopying] = useState(false),
    [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [conflict, setConflict] = useState(false);
  const [importOpen, setImportOpen] = useState(false),
    [source, setSource] = useState("");
  const [importValue, setImportValue] = useState<SheetImportValue | null>(null);
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const importEpoch = useRef(0);
  const navigationAllowed = useRef(false);
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  useBeforeUnload((event) => {
    if (!navigationAllowed.current && dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  const create = useCreateLabelTemplate(),
    update = useUpdateLabelTemplate();
  async function save() {
    setError(null);
    setConflict(false);
    try {
      const payload = {
        name: name.trim(),
        purpose: "pallet" as const,
        format: "pallet_sheet_v2" as const,
        spec,
        enabled,
        chzProductGroupCodes: scope,
      };
      if (scope !== null && scope.length === 0) throw new Error(t("pages.labels.sheet.scopeEmpty"));
      serializeStoredLabelJson(payload);
      const saved =
        template && !copying
          ? await update.mutateAsync({
              id: template.id,
              input: { ...payload, expectedRevision: revision },
            })
          : await create.mutateAsync(payload);
      navigationAllowed.current = true;
      setDirty(false);
      setCopying(false);
      setRevision(saved.revision ?? 1);
      await navigate(`/labels/${saved.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      if (caught instanceof ApiRequestError && caught.code === "LABEL_TEMPLATE_REVISION_CONFLICT")
        setConflict(true);
    } finally {
      navigationAllowed.current = false;
    }
  }
  function closeImport() {
    importEpoch.current += 1;
    setImportOpen(false);
  }
  function exportJson() {
    try {
      downloadBlob(buildJsonBlob({ name, purpose: "pallet", spec }), `${safeFileName(name)}.json`);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  function openImport() {
    importEpoch.current += 1;
    setImportOpen(true);
    setSource("");
    setIssues([]);
    setImportValue(null);
  }
  function checkImport() {
    const result = analyzeSheetImport(source);
    setImportValue(result.ok ? result.value : null);
    setIssues(result.ok ? [] : result.issues);
  }
  function applyImport() {
    if (!importValue) return;
    setSpec(importValue.spec);
    setName(importValue.name);
    setDirty(true);
    closeImport();
  }
  function chooseCopy() {
    setCopying(true);
    setName(`${name} (${t("pages.labels.sheet.copySuffix")})`);
    setDirty(true);
    setConflict(false);
  }
  return (
    <div className="label-sheet-page">
      {dataRouter ? (
        <SheetNavigationGuard
          dirty={dirty}
          busy={create.isPending || update.isPending}
          allowed={navigationAllowed}
        />
      ) : null}
      <PageHeader
        title={t("pages.labels.sheet.title")}
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                if (dirty) setLeaveOpen(true);
                else void navigate("/labels");
              }}
            >
              {t("common.back")}
            </Button>
            <Button type="button" variant="secondary" onClick={chooseCopy}>
              {t("pages.labels.sheet.copy")}
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              loading={create.isPending || update.isPending}
            >
              {t("pages.labels.sheet.save")}
            </Button>
          </>
        }
      />
      <Input
        label={t("pages.labels.sheet.name")}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setDirty(true);
        }}
      />
      <Checkbox
        label={t("pages.labels.sheet.enabled")}
        checked={enabled}
        onCheckedChange={(value) => {
          setEnabled(value);
          setDirty(true);
        }}
      />
      <SheetScopePicker
        value={scope}
        onChange={(value) => {
          setScope(value);
          setDirty(true);
        }}
      />
      <div className="label-sheet-actions">
        <Button type="button" variant="secondary" onClick={openImport}>
          {t("pages.labels.sheet.import")}
        </Button>
        <Button type="button" variant="secondary" onClick={exportJson}>
          {t("pages.labels.sheet.export")}
        </Button>
      </div>
      <Alert tone="info">{t("pages.labels.sheet.windowsOnly")}</Alert>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {conflict ? (
        <div>
          <p>{t("pages.labels.sheet.conflict")}</p>
          <Button type="button" onClick={chooseCopy}>
            {t("pages.labels.sheet.copy")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setLeaveOpen(true)}>
            {t("pages.labels.sheet.reload")}
          </Button>
        </div>
      ) : null}
      <div className="sheet-history">
        <Button
          type="button"
          variant="secondary"
          disabled={!editor.canUndo}
          onClick={() => {
            editor.undo();
            setDirty(true);
          }}
        >
          {t("pages.labels.sheet.editor.undo")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!editor.canRedo}
          onClick={() => {
            editor.redo();
            setDirty(true);
          }}
        >
          {t("pages.labels.sheet.editor.redo")}
        </Button>
      </div>
      <div className="sheet-workspace">
        <SheetEditor
          value={spec}
          selectedId={editor.selectedId}
          onSelect={editor.select}
          onChange={(next) => {
            setSpec(next);
            setDirty(true);
          }}
        />
        <SheetCanvas
          spec={spec}
          rasterizeText={rasterizeText}
          loadBranding={loadCabinetSheetBranding}
          selectedId={editor.selectedId}
          onSelect={editor.select}
          onMove={(id, dx, dy) => {
            const node = findSheetNode(spec, id);
            const x = node?.xMm,
              y = node?.yMm;
            if (!node || x === undefined || y === undefined || (!dx && !dy)) return;
            const parent = sheetNodeParent(spec, id);
            if (!parent || findSheetNode(spec, parent)?.kind !== "canvas") return;
            try {
              setSpec(
                replaceSheetNode(spec, id, (old) =>
                  sheetNodeSchema.parse({
                    ...old,
                    xMm: Math.round((x + dx) * 10) / 10,
                    yMm: Math.round((y + dy) * 10) / 10,
                  }),
                ),
              );
              setDirty(true);
              setError(null);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        />
      </div>
      <Modal
        open={importOpen}
        title={t("pages.labels.sheet.import")}
        onClose={closeImport}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={closeImport}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="secondary" onClick={checkImport}>
              {t("pages.labels.sheet.checkJson")}
            </Button>
            <Button type="button" disabled={!importValue} onClick={applyImport}>
              {t("pages.labels.sheet.apply")}
            </Button>
          </>
        }
      >
        <Input
          type="file"
          accept=".json,application/json"
          aria-label={t("pages.labels.sheet.jsonFile")}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setImportValue(null);
            setIssues([]);
            const epoch = ++importEpoch.current;
            if (file.size > 256 * 1024) {
              setIssues([{ path: "file", message: t("pages.labels.sheet.fileLimit") }]);
              return;
            }
            void file.text().then(
              (text) => {
                if (epoch === importEpoch.current) setSource(text);
              },
              () => {
                if (epoch === importEpoch.current)
                  setIssues([{ path: "file", message: t("pages.labels.sheet.fileReadError") }]);
              },
            );
          }}
        />
        <Textarea
          label={t("pages.labels.sheet.json")}
          value={source}
          onChange={(e) => {
            importEpoch.current += 1;
            setSource(e.target.value);
            setImportValue(null);
            setIssues([]);
          }}
        />
        {issues.map((issue, i) => (
          <Alert key={`${issue.path}-${i}`} tone="error">
            <code>{issue.path}</code> {issue.message}
          </Alert>
        ))}
        {importValue ? (
          <p>
            {importValue.name} · A4 · {importValue.spec.page.copies}
          </p>
        ) : null}
      </Modal>
      <Modal
        open={leaveOpen}
        title={t("pages.labels.sheet.unsaved")}
        onClose={() => setLeaveOpen(false)}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setLeaveOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                navigationAllowed.current = true;
                if (conflict) window.location.reload();
                else void navigate("/labels");
              }}
            >
              {t("pages.labels.sheet.discard")}
            </Button>
          </>
        }
      >
        <p>{t("pages.labels.sheet.unsavedHint")}</p>
      </Modal>
    </div>
  );
}
