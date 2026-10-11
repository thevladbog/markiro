import { useState } from "react";
import { useTranslation } from "react-i18next";
import { sheetNodeSchema, type SheetNode, type PalletSheetSpecV2 } from "@markiro/domain";
import { Alert, Button, Checkbox, Input, Select } from "@markiro/ui";
import {
  findSheetNode,
  sheetNodeParent,
  insertSheetNode,
  moveSheetNode,
  removeSheetNode,
  replaceSheetNode,
} from "./useSheetSpecState.js";
import { SheetNodeInspector, type SheetNodePatch } from "./SheetNodeInspector.js";
export interface SheetEditorProps {
  value: PalletSheetSpecV2;
  onChange: (spec: PalletSheetSpecV2) => void;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
}
const kinds = [
  "text",
  "field",
  "field_row",
  "organization_logo",
  "line",
  "box",
  "spacer",
  "stack",
  "row",
  "canvas",
] as const;
function freshNode(kind: SheetNode["kind"], text: string): SheetNode {
  const id = crypto.randomUUID();
  switch (kind) {
    case "text":
      return { id, kind, text, fontSizePt: 12, maxLines: 2 };
    case "field":
      return { id, kind, field: "product.printName", fontSizePt: 12, maxLines: 5 };
    case "field_row":
      return { id, kind, field: "boxCount", label: text, fontSizePt: 14 };
    case "organization_logo":
      return { id, kind, source: "organization", fallback: "markiro", maxHeightMm: 12 };
    case "line":
      return { id, kind, thicknessMm: 0.3 };
    case "box":
      return { id, kind, heightMm: 10, thicknessMm: 0.3 };
    case "spacer":
      return { id, kind, heightMm: 3 };
    case "canvas":
      return {
        id,
        kind,
        heightMm: 30,
        children: [
          {
            id: crypto.randomUUID(),
            kind: "text",
            text,
            fontSizePt: 8,
            xMm: 0,
            yMm: 0,
            widthMm: 30,
          },
        ],
      };
    case "row":
    case "stack":
      return {
        id,
        kind,
        gapMm: 2,
        children: [{ id: crypto.randomUUID(), kind: "text", text, fontSizePt: 8 }],
      };
  }
}
export function SheetEditor({ value, onChange, selectedId, onSelect }: SheetEditorProps) {
  const { t } = useTranslation();
  const key = (name: string) => t(`pages.labels.sheet.editor.${name}`);
  const [localSelected, setLocalSelected] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const selected = selectedId === undefined ? localSelected : selectedId;
  const setSelected = onSelect ?? setLocalSelected;
  const node = selected ? findSheetNode(value, selected) : undefined;
  const run = (change: () => PalletSheetSpecV2) => {
    try {
      onChange(change());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const patch = (patch: SheetNodePatch) => {
    if (selected)
      run(() =>
        replaceSheetNode(value, selected, (old) => sheetNodeSchema.parse({ ...old, ...patch })),
      );
  };
  const containers: Array<{ value: string; label: string }> = [{ value: "", label: key("body") }];
  const collect = (nodes: SheetNode[]) => {
    for (const item of nodes)
      if ("children" in item) {
        containers.push({
          value: item.id,
          label: `${key(item.kind)} · ${item.id}`,
        });
        collect(item.children);
      }
  };
  collect(value.body);
  const tree = (nodes: SheetNode[], parent: string | null) => (
    <ol>
      {nodes.map((item, index) => (
        <li key={item.id}>
          <Button
            type="button"
            variant={selected === item.id ? "primary" : "secondary"}
            onClick={() => setSelected(item.id)}
            aria-pressed={selected === item.id}
          >
            {key(
              item.kind === "field" ? "fieldKind" : item.kind === "text" ? "textKind" : item.kind,
            )}{" "}
            · {item.kind === "text" ? item.text : item.id}
          </Button>
          <Button
            type="button"
            variant="secondary"
            aria-label={`${key("up")} ${item.id}`}
            disabled={index === 0}
            onClick={() => run(() => moveSheetNode(value, item.id, parent, index - 1))}
          >
            ↑
          </Button>
          <Button
            type="button"
            variant="secondary"
            aria-label={`${key("down")} ${item.id}`}
            disabled={index === nodes.length - 1}
            onClick={() => run(() => moveSheetNode(value, item.id, parent, index + 1))}
          >
            ↓
          </Button>
          {"children" in item ? tree(item.children, item.id) : null}
        </li>
      ))}
    </ol>
  );
  return (
    <section className="sheet-editor">
      <fieldset>
        <legend>{key("page")}</legend>
        <Select
          label={key("orientation")}
          value={value.page.orientation}
          options={[
            { value: "portrait", label: key("portrait") },
            { value: "landscape", label: key("landscape") },
          ]}
          onValueChange={(orientation) => {
            if (orientation === "portrait" || orientation === "landscape")
              onChange({
                ...value,
                page: {
                  ...value.page,
                  orientation,
                  ...(orientation === "portrait" ? { copies: 1, cutLine: false } : {}),
                },
              });
          }}
        />
        <Checkbox
          label={key("twoCopies")}
          checked={value.page.copies === 2}
          disabled={value.page.orientation !== "landscape"}
          onCheckedChange={(two) =>
            onChange({
              ...value,
              page: { ...value.page, copies: two ? 2 : 1, cutLine: two && value.page.cutLine },
            })
          }
        />
        <Checkbox
          label={key("cutLine")}
          checked={value.page.cutLine}
          disabled={value.page.copies !== 2}
          onCheckedChange={(cutLine) => onChange({ ...value, page: { ...value.page, cutLine } })}
        />
        {(["top", "right", "bottom", "left"] as const).map((edge) => (
          <Input
            key={edge}
            type="number"
            label={`${key("margin")} ${key(edge)}`}
            value={value.page.marginsMm[edge]}
            min={0}
            max={100}
            step="0.5"
            onChange={(e) =>
              onChange({
                ...value,
                page: {
                  ...value.page,
                  marginsMm: { ...value.page.marginsMm, [edge]: Number(e.target.value) },
                },
              })
            }
          />
        ))}
      </fieldset>
      <div className="sheet-palette">
        {kinds.map((kind) => (
          <Button
            key={kind}
            type="button"
            variant="secondary"
            onClick={() => {
              const added = freshNode(kind, key("newText"));
              run(() => {
                const parent = node && "children" in node ? node : null;
                const nextNode =
                  parent?.kind === "canvas" ? { ...added, xMm: 0, yMm: 0, widthMm: 30 } : added;
                const next = insertSheetNode(value, parent?.id ?? null, nextNode);
                setSelected(added.id);
                return next;
              });
            }}
          >
            {key("add")}:{" "}
            {key(kind === "text" ? "textKind" : kind === "field" ? "fieldKind" : kind)}
          </Button>
        ))}
      </div>
      {tree(value.body, null)}
      {node ? (
        <>
          <SheetNodeInspector node={node} onChange={patch} />
          <Select
            label={key("moveTo")}
            value={sheetNodeParent(value, node.id) ?? ""}
            options={containers}
            onValueChange={(parent) => run(() => moveSheetNode(value, node.id, parent || null, 0))}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => run(() => removeSheetNode(value, node.id))}
          >
            {key("remove")}
          </Button>
        </>
      ) : null}
      <fieldset>
        <legend>SSCC</legend>
        <p>{key("footerHint")}</p>
        <Input
          type="number"
          label={key("barHeightMm")}
          value={value.footer.barHeightMm}
          min={31.75}
          max={100}
          step="0.5"
          onChange={(e) =>
            onChange({ ...value, footer: { ...value.footer, barHeightMm: Number(e.target.value) } })
          }
        />
        <Input
          type="number"
          label={key("moduleDots")}
          value={value.footer.moduleDots}
          min={6}
          max={11}
          onChange={(e) =>
            onChange({ ...value, footer: { ...value.footer, moduleDots: Number(e.target.value) } })
          }
        />
        <Input
          type="number"
          label={key("fallbackModuleDots")}
          value={value.footer.fallbackModuleDots ?? ""}
          min={6}
          max={11}
          onChange={(e) => {
            const footer = { ...value.footer };
            delete footer.fallbackModuleDots;
            onChange({
              ...value,
              footer: {
                ...footer,
                ...(e.target.value ? { fallbackModuleDots: Number(e.target.value) } : {}),
              },
            });
          }}
        />
        <Select
          label={key("align")}
          value={value.footer.align}
          options={["left", "center", "right"].map((align) => ({
            value: align,
            label: key(align),
          }))}
          onValueChange={(align) => {
            if (align === "left" || align === "center" || align === "right")
              onChange({ ...value, footer: { ...value.footer, align } });
          }}
        />
      </fieldset>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </section>
  );
}
