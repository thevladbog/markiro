import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input } from "@markiro/ui";

import {
  WAREHOUSE_SUBJECT_KINDS,
  type PalletSheets,
  type WarehouseSubjectKind,
} from "../../host/protocol.js";
import { drawLabel, paintCodeRasters } from "../../office/templates/label-renderer.js";
import { useLabelRendering } from "../../office/templates/label-rendering.js";
import { labelRenderOptions, labelSampleData } from "../../office/templates/label-samples.js";
import type { ScanSource } from "../scan-source.js";
import { WarehousePanel } from "./WarehousePanel.js";
import type { WarehouseTemplates } from "./warehouse-store.js";
import { SHEET_AUTO, sheetChoiceName, sheetChoiceOf } from "./warehouse-sheet.js";
import {
  isChoosable,
  KIND_PURPOSE,
  type PalletPaper,
  type WarehouseTemplate,
} from "./warehouse-templates.js";
import { realClock, useViewGuard } from "./view-guard.js";

/** The preview's box; the label keeps its own proportions inside it. */
const PREVIEW_PX = 280;

/** A template as the cloud's `label-template-option` row (the kit's button styles inline). */
const OPTION_STYLE: CSSProperties = {
  justifyContent: "flex-start",
  width: "100%",
  minHeight: 80,
  height: "auto",
  padding: "0 16px",
  textAlign: "left",
};
const PICKED_OPTION_STYLE: CSSProperties = {
  border: "1px solid var(--ok-solid)",
  background: "var(--ok-bg)",
};

/**
 * A template drawn with its purpose's sample data, as the office's thumbnail draws it, from
 * the same layout the job would freeze; nothing is drawn in a webview without a canvas.
 */
function TemplatePreview({ template }: { template: WarehouseTemplate | null }) {
  const { t } = useTranslation();
  const { context } = useLabelRendering();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spec = template?.spec ?? null;
  const scale = spec === null ? 0 : Math.min(PREVIEW_PX / spec.widthMm, PREVIEW_PX / spec.heightMm);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || spec === null || template === null) return undefined;
    const drawing = context(canvas);
    if (drawing === null) return undefined;
    const data = labelSampleData(template.purpose);
    const options = labelRenderOptions(template.purpose);
    drawLabel(spec, drawing, scale, data, options);
    let cancelled = false;
    void paintCodeRasters(spec, drawing, scale, data, options, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [context, spec, scale, template]);
  if (template === null || spec === null) {
    return <p className="warehouse-label-preview">{t("floor.warehouse.previewNone")}</p>;
  }
  return (
    <figure className="warehouse-label-preview">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        width={Math.round(spec.widthMm * scale)}
        height={Math.round(spec.heightMm * scale)}
      />
      <figcaption>
        {template.name} ·{" "}
        {t("floor.warehouse.size", { width: spec.widthMm, height: spec.heightMm })}
        <br />
        {t("floor.warehouse.previewSample")}
      </figcaption>
    </figure>
  );
}

/** The host's A4 sheets as the picker has them (beta 3.2). */
export type SheetsState =
  { kind: "loading" } | { kind: "failed" } | { kind: "ready"; sheets: PalletSheets };

export interface TemplatePickerProps {
  templates: readonly WarehouseTemplate[];
  /**
   * What the printer assigned to pallets prints (beta 3.2): the pallets' tab offers the host's A4
   * sheets for a printer of sheets, the label templates for a label printer, and says so when
   * there is no printer.
   */
  palletPaper?: PalletPaper;
  /** The host's sheets, for the pallets' tab on a printer of sheets. */
  sheets?: SheetsState;
  /** «Повторить» of a list of sheets the host did not give. */
  onReloadSheets?: () => void;
  chosen: WarehouseTemplates;
  source: ScanSource;
  onApply: (templates: WarehouseTemplates) => void;
  onCancel: () => void;
  /** Milliseconds from a clock that does not go back; the guard after a change of view reads it. */
  clock?: () => number;
}

/**
 * The templates of a reprint session (the cloud's `TemplateChoiceList`): one kind of
 * label at a time, its enabled templates found by name, the chosen one previewed with
 * sample data (said so). A choice of one kind is kept while another is chosen;
 * «Отмена» keeps the session's templates. While the search takes typing the scanner
 * is quiet (`setManualTextEntryActive`), and it is given back on blur and when the
 * picker goes. A press just after the view changed (another kind of label) does nothing.
 */
export function TemplatePicker({
  templates,
  palletPaper = "thermal",
  sheets = { kind: "loading" },
  onReloadSheets,
  chosen,
  source,
  onApply,
  onCancel,
  clock = realClock,
}: TemplatePickerProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<WarehouseSubjectKind>("unit");
  const [draft, setDraft] = useState<WarehouseTemplates>(chosen);
  const [query, setQuery] = useState("");
  const { viewRef, settled } = useViewGuard<HTMLDivElement>(`picker:${kind}`, clock);
  useEffect(() => () => source.setManualTextEntryActive(false), [source]);
  /** Props of a button: a press just after the view changed does nothing. */
  const press = (action: () => void) => ({
    onClick: () => {
      if (settled()) action();
    },
  });
  const choosable = useMemo(
    () => templates.filter((template) => isChoosable(template, kind)),
    [templates, kind],
  );
  const needle = query.trim().toLocaleLowerCase("ru");
  const listed = choosable.filter((template) =>
    template.name.toLocaleLowerCase("ru").includes(needle),
  );
  const selected = templates.find((template) => template.id === draft[kind]) ?? null;
  const kindLabel = t(`floor.warehouse.templateFor.${kind}`);
  // The pallets' tab depends on the pallet printer: sheets for a printer of sheets (beta 3.2).
  const sheetTab = kind === "pallet" && palletPaper === "a4";
  const noPrinterTab = kind === "pallet" && palletPaper === "none";
  const readySheets = sheets.kind === "ready" ? sheets.sheets : null;
  const listedSheets = (readySheets?.sheets ?? []).filter(
    (sheet) => sheet.enabled && sheet.name.toLocaleLowerCase("ru").includes(needle),
  );
  const lineOf = (each: WarehouseSubjectKind): string => {
    if (each === "pallet" && palletPaper === "a4") {
      const named = sheetChoiceName(draft.pallet, readySheets);
      return named === null
        ? t("floor.warehouse.templateNone")
        : named.kind === "auto"
          ? t("floor.warehouse.sheets.lineAuto")
          : named.name === null
            ? t("floor.warehouse.sheets.lineSome")
            : t("floor.warehouse.sheets.line", { name: named.name });
    }
    return (
      templates.find((template) => template.id === draft[each])?.name ??
      t("floor.warehouse.templateNone")
    );
  };
  /** The list of A4 sheets: «по умолчанию товара» first, then the host's enabled ones. */
  const sheetList = () => {
    if (sheets.kind === "loading")
      return <p className="label-template-empty">{t("floor.warehouse.sheets.loading")}</p>;
    if (sheets.kind === "failed") {
      return (
        <Alert
          tone="warn"
          action={
            onReloadSheets === undefined ? undefined : (
              <Button size="floor" variant="secondary" {...press(onReloadSheets)}>
                {t("floor.warehouse.sheets.retry")}
              </Button>
            )
          }
        >
          {t("floor.warehouse.sheets.failed")}
        </Alert>
      );
    }
    if (sheets.sheets.sheets.filter((sheet) => sheet.enabled).length === 0) {
      return <p className="label-template-empty">{t("floor.warehouse.sheets.none")}</p>;
    }
    const pick = (id: string) => ({ ...press(() => setDraft({ ...draft, pallet: id })) });
    const optionStyle = (picked: boolean) =>
      picked ? { ...OPTION_STYLE, ...PICKED_OPTION_STYLE } : OPTION_STYLE;
    return (
      <ul className="label-template-list" aria-label={kindLabel}>
        {needle === "" && (
          <li>
            <Button
              size="floor"
              variant="secondary"
              aria-pressed={draft.pallet === SHEET_AUTO}
              {...pick(SHEET_AUTO)}
              style={optionStyle(draft.pallet === SHEET_AUTO)}
            >
              {t("floor.warehouse.sheets.auto")}
            </Button>
          </li>
        )}
        {listedSheets.map((sheet) => {
          const picked = draft.pallet === sheetChoiceOf(sheet.id);
          return (
            <li key={sheet.id}>
              <Button
                size="floor"
                variant="secondary"
                aria-pressed={picked}
                {...pick(sheetChoiceOf(sheet.id))}
                style={optionStyle(picked)}
              >
                {sheet.name}
              </Button>
            </li>
          );
        })}
      </ul>
    );
  };

  /** What the right column says of the chosen sheet: its name, or what «по умолчанию» means. */
  const sheetPreviewText = (): string => {
    const named = sheetChoiceName(draft.pallet, readySheets);
    if (named === null) return t("floor.warehouse.sheets.kindHint");
    if (named.kind === "auto") return t("floor.warehouse.sheets.autoHint");
    return t("floor.warehouse.sheets.preview", { name: named.name ?? "" });
  };

  return (
    <div className="warehouse-picker" tabIndex={-1} ref={viewRef}>
      <WarehousePanel
        titleId="warehouse-picker-title"
        title={t("floor.warehouse.templatesTitle")}
        backLabel={t("floor.warehouse.cancel")}
        back={press(onCancel)}
        footer={
          <>
            <p className="warehouse-picker__summary">
              {WAREHOUSE_SUBJECT_KINDS.map((each) =>
                t("floor.warehouse.templateLine", {
                  kind: t(`floor.warehouse.templateFor.${each}`),
                  name: lineOf(each),
                }),
              ).join(" · ")}
            </p>
            <Button size="floor" {...press(() => onApply(draft))}>
              {t("floor.warehouse.apply")}
            </Button>
          </>
        }
      >
        <div className="warehouse-template-body">
          <div
            className="warehouse-template-tabs"
            role="group"
            aria-label={t("floor.warehouse.templatesTitle")}
          >
            {WAREHOUSE_SUBJECT_KINDS.map((each) => (
              <Button
                key={each}
                size="floor"
                variant={each === kind ? "primary" : "secondary"}
                aria-pressed={each === kind}
                {...press(() => {
                  setKind(each);
                  setQuery("");
                })}
              >
                {t(`floor.warehouse.templateFor.${each}`)}
              </Button>
            ))}
          </div>
          <div className="warehouse-template-grid">
            <div className="label-template-choices">
              <Input
                size="floor"
                label={t(sheetTab ? "floor.warehouse.sheets.search" : "floor.warehouse.search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => source.setManualTextEntryActive(true)}
                onBlur={() => source.setManualTextEntryActive(false)}
              />
              {noPrinterTab ? (
                <Alert tone="warn">{t("floor.warehouse.noPalletPrinter")}</Alert>
              ) : sheetTab ? (
                sheetList()
              ) : choosable.length === 0 ? (
                <p className="label-template-empty">{t("floor.warehouse.noTemplates")}</p>
              ) : listed.length === 0 ? (
                <p className="label-template-empty">{t("floor.warehouse.noMatch")}</p>
              ) : (
                <ul className="label-template-list" aria-label={kindLabel}>
                  {listed.map((template) => {
                    const picked = template.id === draft[kind];
                    return (
                      <li key={template.id}>
                        <Button
                          size="floor"
                          variant="secondary"
                          aria-pressed={picked}
                          {...press(() => setDraft({ ...draft, [kind]: template.id }))}
                          style={
                            picked ? { ...OPTION_STYLE, ...PICKED_OPTION_STYLE } : OPTION_STYLE
                          }
                        >
                          {template.spec === null
                            ? template.name
                            : `${template.name} · ${t("floor.warehouse.size", {
                                width: template.spec.widthMm,
                                height: template.spec.heightMm,
                              })}`}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="label-template-preview">
              {sheetTab || noPrinterTab ? (
                <p className="warehouse-label-preview">
                  {sheetTab && sheetChoiceName(draft.pallet, readySheets) !== null
                    ? sheetPreviewText()
                    : t(
                        sheetTab
                          ? "floor.warehouse.sheets.kindHint"
                          : "floor.warehouse.previewNone",
                      )}
                </p>
              ) : (
                <TemplatePreview
                  template={
                    selected !== null && selected.purpose === KIND_PURPOSE[kind] ? selected : null
                  }
                />
              )}
            </div>
          </div>
        </div>
      </WarehousePanel>
    </div>
  );
}
