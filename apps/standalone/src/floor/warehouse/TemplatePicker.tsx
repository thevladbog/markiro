import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Input } from "@markiro/ui";

import { WAREHOUSE_SUBJECT_KINDS, type WarehouseSubjectKind } from "../../host/protocol.js";
import { drawLabel, paintCodeRasters } from "../../office/templates/label-renderer.js";
import { useLabelRendering } from "../../office/templates/label-rendering.js";
import { labelRenderOptions, labelSampleData } from "../../office/templates/label-samples.js";
import type { ScanSource } from "../scan-source.js";
import type { WarehouseTemplates } from "./warehouse-store.js";
import { isChoosable, KIND_PURPOSE, type WarehouseTemplate } from "./warehouse-templates.js";
import { realClock, useViewGuard } from "./view-guard.js";

/** The preview's box; the label keeps its own proportions inside it. */
const PREVIEW_PX = 280;

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
    return <p className="warehouse-picker__preview">{t("floor.warehouse.previewNone")}</p>;
  }
  return (
    <figure className="warehouse-picker__preview">
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

export interface TemplatePickerProps {
  templates: readonly WarehouseTemplate[];
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
  const { viewRef, settled } = useViewGuard<HTMLElement>(`picker:${kind}`, clock);
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
  return (
    <section
      className="standalone-form warehouse-picker"
      aria-labelledby="warehouse-picker-title"
      tabIndex={-1}
      ref={viewRef}
    >
      <h3 id="warehouse-picker-title">{t("floor.warehouse.templatesTitle")}</h3>
      <div
        className="warehouse__choices"
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
      <Input
        size="floor"
        label={t("floor.warehouse.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => source.setManualTextEntryActive(true)}
        onBlur={() => source.setManualTextEntryActive(false)}
      />
      <div className="warehouse-picker__body">
        <div>
          {choosable.length === 0 ? (
            <p>{t("floor.warehouse.noTemplates")}</p>
          ) : listed.length === 0 ? (
            <p>{t("floor.warehouse.noMatch")}</p>
          ) : (
            <ul className="warehouse-picker__list">
              {listed.map((template) => (
                <li key={template.id}>
                  <Button
                    size="floor"
                    variant={template.id === draft[kind] ? "primary" : "secondary"}
                    aria-pressed={template.id === draft[kind]}
                    {...press(() => setDraft({ ...draft, [kind]: template.id }))}
                  >
                    {template.spec === null
                      ? template.name
                      : `${template.name} · ${t("floor.warehouse.size", {
                          width: template.spec.widthMm,
                          height: template.spec.heightMm,
                        })}`}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <TemplatePreview
          template={selected !== null && selected.purpose === KIND_PURPOSE[kind] ? selected : null}
        />
      </div>
      <div className="standalone-form__actions">
        <Button size="floor" {...press(() => onApply(draft))}>
          {t("floor.warehouse.apply")}
        </Button>
        <Button size="floor" variant="secondary" {...press(onCancel)}>
          {t("floor.warehouse.cancel")}
        </Button>
      </div>
    </section>
  );
}
