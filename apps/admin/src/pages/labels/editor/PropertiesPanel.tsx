/**
 * Plan 04 Task 10: label editor chrome -- the right "properties" sidebar.
 *
 * Shows the SELECTED element's own properties (position, always; plus
 * kind-specific fields) per the handoff's right panel. Renders a placeholder
 * hint when nothing is selected. Label-level settings (name, size preset,
 * dpi, language) live in the top toolbar (`index.tsx`) instead of here --
 * see that file's doc comment for why.
 *
 * Every control here dispatches through a single `onChange(id, patch)`
 * callback matching `useEditorState`'s `setElement(id, patch)` signature
 * exactly, so this component stays a dumb, fully-controlled view with no
 * state of its own -- easy to test by asserting the `onChange` calls it
 * makes, and easy to compose with the real reducer in the actual editor page.
 */
import type { ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import { LABEL_FIELDS, type LabelElement } from "@markiro/domain";
import { Button, Checkbox, Input, Select } from "@markiro/ui";

const ALIGN_OPTIONS: Array<{ value: "left" | "center" | "right"; labelKey: string }> = [
  { value: "left", labelKey: "alignLeft" },
  { value: "center", labelKey: "alignCenter" },
  { value: "right", labelKey: "alignRight" },
];

export interface PropertiesPanelProps {
  element: LabelElement | null;
  onChange: (id: string, patch: Partial<LabelElement>) => void;
  onDelete: (id: string) => void;
  onCollapse?: () => void;
  geometryError?: "ELEMENT_TOO_LARGE" | null;
}

function numberFromInput(event: ChangeEvent<HTMLInputElement>): number {
  const value = Number(event.target.value);
  return Number.isFinite(value) ? value : 0;
}

export function PropertiesPanel({
  element,
  onChange,
  onDelete,
  onCollapse,
  geometryError,
}: PropertiesPanelProps) {
  const { t } = useTranslation();

  if (!element) {
    return <div className="label-editor__properties-empty">{t("pages.labels.editor.properties.none")}</div>;
  }

  const kindLabel = t(`pages.labels.editor.kinds.${element.kind}`);
  const patch = (fields: Partial<LabelElement>) => onChange(element.id, fields);

  return (
    <section className="label-editor__properties-panel" aria-labelledby="label-editor-properties-title">
      <header className="label-editor__properties-header">
        <span id="label-editor-properties-title" className="label-editor__eyebrow">
          {t("pages.labels.editor.properties.selected", { kind: kindLabel })}
        </span>
        {onCollapse && (
          <Button
            type="button"
            variant="secondary"
            size="compact"
            className="label-editor__collapse-button"
            onClick={onCollapse}
          >
            {t("pages.labels.editor.properties.collapse")}
          </Button>
        )}
      </header>
      <div className="label-editor__properties-content">

      <div className="label-editor__property-row">
        <Input
          label={t("pages.labels.editor.properties.x")}
          type="number"
          mono
          value={element.xMm}
          onChange={(event) => patch({ xMm: numberFromInput(event) })}
        />
        <Input
          label={t("pages.labels.editor.properties.y")}
          type="number"
          mono
          value={element.yMm}
          onChange={(event) => patch({ yMm: numberFromInput(event) })}
        />
      </div>

      {(element.kind === "text" || element.kind === "field") && (
        <div className="label-editor__property-section">
          {element.kind === "text" && (
            <Input
              label={t("pages.labels.editor.properties.text")}
              value={element.text}
              onChange={(event) => patch({ text: event.target.value })}
            />
          )}
          {element.kind === "field" && (
            <Select
              label={t("pages.labels.editor.properties.field")}
              options={LABEL_FIELDS.map((field) => ({
                value: field,
                label: t(`pages.labels.editor.fields.${field}`),
              }))}
              value={element.field}
              onValueChange={(value) => patch({ field: value })}
            />
          )}
          <div className="label-editor__property-row">
            <Input
              label={t("pages.labels.editor.properties.fontSize")}
              type="number"
              mono
              value={element.fontSizePt}
              onChange={(event) => patch({ fontSizePt: numberFromInput(event) })}
            />
            <Select
              label={t("pages.labels.editor.properties.align")}
              options={ALIGN_OPTIONS.map((option) => ({
                value: option.value,
                label: t(`pages.labels.editor.properties.${option.labelKey}`),
              }))}
              value={element.align ?? "left"}
              onValueChange={(value) => patch({ align: value })}
            />
          </div>
          <Checkbox
            label={t("pages.labels.editor.properties.bold")}
            checked={element.bold ?? false}
            onCheckedChange={(bold) => patch({ bold })}
          />
          <Input
            label={t("pages.labels.editor.properties.maxWidth")}
            type="number"
            mono
            value={element.maxWidthMm ?? 0}
            onChange={(event) => {
              const value = numberFromInput(event);
              patch({ maxWidthMm: value > 0 ? value : undefined });
            }}
          />
        </div>
      )}

      {element.kind === "barcode" && (
        <div className="label-editor__property-section">
          <Input
            label={t("pages.labels.editor.properties.size")}
            type="number"
            mono
            value={element.sizeMm}
            onChange={(event) => patch({ sizeMm: numberFromInput(event) })}
          />
          <Select
            label={t("pages.labels.editor.properties.source")}
            options={[
              { value: "field", label: t("pages.labels.editor.properties.sourceField") },
              { value: "literal", label: t("pages.labels.editor.properties.sourceLiteral") },
            ]}
            value={typeof element.data === "string" ? "field" : "literal"}
            onValueChange={(value) =>
              patch({
                data: value === "field" ? "product.gtin" : { literal: "" },
              })
            }
          />
          {typeof element.data === "string" ? (
            <Select
              label={t("pages.labels.editor.properties.field")}
              options={LABEL_FIELDS.map((field) => ({
                value: field,
                label: t(`pages.labels.editor.fields.${field}`),
              }))}
              value={element.data}
              onValueChange={(value) => patch({ data: value })}
            />
          ) : (
            <Input
              label={t("pages.labels.editor.properties.literal")}
              value={element.data.literal}
              onChange={(event) => patch({ data: { literal: event.target.value } })}
            />
          )}
        </div>
      )}

      {element.kind === "line" && (
        <div className="label-editor__property-row">
          <Input
            label={t("pages.labels.editor.properties.x2")}
            type="number"
            mono
            value={element.x2Mm}
            onChange={(event) => patch({ x2Mm: numberFromInput(event) })}
          />
          <Input
            label={t("pages.labels.editor.properties.y2")}
            type="number"
            mono
            value={element.y2Mm}
            onChange={(event) => patch({ y2Mm: numberFromInput(event) })}
          />
          <Input
            label={t("pages.labels.editor.properties.thickness")}
            type="number"
            mono
            value={element.thicknessMm}
            onChange={(event) => patch({ thicknessMm: numberFromInput(event) })}
          />
        </div>
      )}

      {element.kind === "box" && (
        <div className="label-editor__property-row">
          <Input
            label={t("pages.labels.editor.properties.width")}
            type="number"
            mono
            value={element.widthMm}
            onChange={(event) => patch({ widthMm: numberFromInput(event) })}
          />
          <Input
            label={t("pages.labels.editor.properties.height")}
            type="number"
            mono
            value={element.heightMm}
            onChange={(event) => patch({ heightMm: numberFromInput(event) })}
          />
          <Input
            label={t("pages.labels.editor.properties.thickness")}
            type="number"
            mono
            value={element.thicknessMm}
            onChange={(event) => patch({ thicknessMm: numberFromInput(event) })}
          />
        </div>
      )}

      <Button
        type="button"
        variant="destructive"
        size="compact"
        onClick={() => onDelete(element.id)}
      >
        {t("pages.labels.editor.properties.delete")}
      </Button>
      {geometryError && (
        <div className="label-editor__geometry-error" role="alert">
          {t("pages.labels.editor.properties.geometryError")}
        </div>
      )}
      </div>
    </section>
  );
}
