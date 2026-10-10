import { useTranslation } from "react-i18next";
import { PALLET_SHEET_FIELDS, type SheetNode } from "@markiro/domain";
import { Checkbox, Input, Select, Textarea } from "@markiro/ui";
export type SheetNodePatch = Record<string, unknown>;
export function SheetNodeInspector({
  node,
  onChange,
}: {
  node: SheetNode;
  onChange: (patch: SheetNodePatch) => void;
}) {
  const { t } = useTranslation();
  const key = (value: string) => t(`pages.labels.sheet.editor.${value}`);
  const numeric = (property: string, value: number | undefined, min = 0, max = 300) => (
    <Input
      type="number"
      label={key(property)}
      value={value ?? ""}
      min={min}
      max={max}
      step="0.1"
      onChange={(e) =>
        onChange({ [property]: e.target.value === "" ? undefined : Number(e.target.value) })
      }
    />
  );
  const fields = PALLET_SHEET_FIELDS.map((field) => ({
    value: field,
    label: key(`fields.${field.replaceAll(".", "_")}`),
  }));
  return (
    <fieldset className="sheet-inspector">
      <legend>
        {key("properties")} · {node.id}
      </legend>
      {node.kind === "text" ? (
        <Textarea
          label={key("text")}
          value={node.text}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      ) : null}
      {"field" in node ? (
        <Select
          label={key("field")}
          value={node.field}
          options={fields}
          onValueChange={(value) => onChange({ field: value })}
        />
      ) : null}
      {node.kind === "field_row" ? (
        <Input
          label={key("label")}
          value={node.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      ) : null}
      {"fontSizePt" in node ? (
        <>
          {numeric("fontSizePt", node.fontSizePt, 4, 72)}
          <Select
            label={key("fontFamily")}
            value={node.fontFamily ?? "IBM Plex Sans"}
            options={[
              { value: "IBM Plex Sans", label: "IBM Plex Sans" },
              { value: "IBM Plex Mono", label: "IBM Plex Mono" },
            ]}
            onValueChange={(value) => onChange({ fontFamily: value })}
          />
          <Checkbox
            label={key("bold")}
            checked={node.bold ?? false}
            onCheckedChange={(value) => onChange({ bold: value })}
          />
          <Select
            label={key("align")}
            value={node.align ?? "left"}
            options={["left", "center", "right"].map((value) => ({ value, label: key(value) }))}
            onValueChange={(value) => onChange({ align: value })}
          />
          {numeric("maxLines", node.maxLines ?? 1, 1, 16)}
          {numeric("reservedLines", node.reservedLines, 1, 16)}
        </>
      ) : null}
      {node.kind === "field_row"
        ? numeric("labelFontSizePt", node.labelFontSizePt ?? 8, 4, 72)
        : null}
      {node.kind === "organization_logo" ? numeric("maxHeightMm", node.maxHeightMm, 0.1, 50) : null}
      {node.kind === "line" || node.kind === "box"
        ? numeric("thicknessMm", node.thicknessMm, 0.1, 5)
        : null}
      {node.kind === "box" ? (
        <Checkbox
          label={key("filled")}
          checked={node.filled ?? false}
          onCheckedChange={(value) => onChange({ filled: value })}
        />
      ) : null}
      {numeric("widthMm", node.widthMm, 0.1)}
      {numeric("heightMm", node.heightMm, 0.1)}
      {numeric("xMm", node.xMm)}
      {numeric("yMm", node.yMm)}
      {numeric("grow", node.grow, 0.1, 100)}
      {"gapMm" in node ? numeric("gapMm", node.gapMm) : null}
      {"children" in node ? (
        <fieldset>
          <legend>{key("padding")}</legend>
          {(["top", "right", "bottom", "left"] as const).map((edge) => (
            <Input
              key={edge}
              type="number"
              label={key(edge)}
              value={node.paddingMm?.[edge] ?? 0}
              min={0}
              max={300}
              step="0.1"
              onChange={(e) =>
                onChange({
                  paddingMm: {
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0,
                    ...node.paddingMm,
                    [edge]: Number(e.target.value),
                  },
                })
              }
            />
          ))}
        </fieldset>
      ) : null}
      <Select
        label={key("condition")}
        value={node.when?.field ?? ""}
        options={[{ value: "", label: key("always") }, ...fields]}
        onValueChange={(value) =>
          onChange({ when: value ? { field: value, op: "present" } : undefined })
        }
      />
    </fieldset>
  );
}
