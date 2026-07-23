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

import type { LabelElement, LabelField } from "@markiro/domain";
import { Button, Input, Select } from "@markiro/ui";

const LABEL_FIELDS: LabelField[] = [
  "product.name",
  "product.gtin",
  "km.code",
  "sscc",
  "shift.no",
  "date",
  "qty",
  "operator",
  "counterparty.name",
];

const ALIGN_OPTIONS: Array<{ value: "left" | "center" | "right"; labelKey: string }> = [
  { value: "left", labelKey: "alignLeft" },
  { value: "center", labelKey: "alignCenter" },
  { value: "right", labelKey: "alignRight" },
];

export interface PropertiesPanelProps {
  element: LabelElement | null;
  onChange: (id: string, patch: Partial<LabelElement>) => void;
  onDelete: (id: string) => void;
}

const ROW_STYLE = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 };
const SECTION_STYLE = { display: "flex", flexDirection: "column" as const, gap: 12 };

function numberFromInput(event: ChangeEvent<HTMLInputElement>): number {
  const value = Number(event.target.value);
  return Number.isFinite(value) ? value : 0;
}

export function PropertiesPanel({ element, onChange, onDelete }: PropertiesPanelProps) {
  const { t } = useTranslation();

  if (!element) {
    return (
      <div style={{ padding: 16 }}>
        <span style={{ font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
          {t("pages.labels.editor.properties.none")}
        </span>
      </div>
    );
  }

  const kindLabel = t(`pages.labels.editor.kinds.${element.kind}`);
  const patch = (fields: Partial<LabelElement>) => onChange(element.id, fields);

  return (
    <div style={{ ...SECTION_STYLE, padding: 16 }}>
      <span
        style={{
          font: "500 11px/1 var(--font-ui)",
          color: "var(--fg-3)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {t("pages.labels.editor.properties.selected", { kind: kindLabel })}
      </span>

      <div style={ROW_STYLE}>
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
        <div style={SECTION_STYLE}>
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
              onChange={(value) => patch({ field: value as LabelField })}
            />
          )}
          <div style={ROW_STYLE}>
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
              onChange={(value) => patch({ align: value as "left" | "center" | "right" })}
            />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={element.bold ?? false}
              onChange={(event) => patch({ bold: event.target.checked })}
            />
            <span style={{ font: "var(--text-body-sm)", color: "var(--fg-2)" }}>
              {t("pages.labels.editor.properties.bold")}
            </span>
          </label>
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
        <div style={SECTION_STYLE}>
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
            onChange={(value) =>
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
              onChange={(value) => patch({ data: value as LabelField })}
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
        <div style={ROW_STYLE}>
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
        <div style={ROW_STYLE}>
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
    </div>
  );
}
