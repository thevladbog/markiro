/**
 * Plan 04 Task 10: label editor chrome -- the left "Элементы" palette.
 *
 * Per the plan brief: exactly 8 buttons (Текст, Поле, DataMatrix, Code128,
 * EAN-13, QR, Линия, Рамка). Clicking one ADDS that element to the spec
 * immediately, anchored at the label's own center with kind-appropriate
 * "sane defaults" -- there is no drag-and-drop placement in this MVP (the
 * handoff prototype's `cursor: grab` styling notwithstanding; the plan
 * brief is explicit: "click adds element at label center").
 */
import { useTranslation } from "react-i18next";

import type { LabelElement } from "@markiro/domain";

export interface PaletteProps {
  /** The label's own size -- new elements are centered within it. */
  labelWidthMm: number;
  labelHeightMm: number;
  onAdd: (element: LabelElement) => void;
}

interface PaletteButtonDef {
  /** i18n key under `pages.labels.editor.palette`. */
  labelKey: string;
  build: (centerXMm: number, centerYMm: number, defaultText: string) => LabelElement;
}

const PALETTE_BUTTONS: PaletteButtonDef[] = [
  {
    labelKey: "text",
    build: (xMm, yMm, defaultText) => ({
      kind: "text",
      id: crypto.randomUUID(),
      xMm,
      yMm,
      text: defaultText,
      fontSizePt: 12,
    }),
  },
  {
    labelKey: "field",
    build: (xMm, yMm) => ({
      kind: "field",
      id: crypto.randomUUID(),
      xMm,
      yMm,
      field: "product.name",
      fontSizePt: 12,
    }),
  },
  {
    labelKey: "datamatrix",
    build: (xMm, yMm) => ({
      kind: "barcode",
      id: crypto.randomUUID(),
      xMm,
      yMm,
      format: "datamatrix",
      data: "km.code",
      sizeMm: 0.4,
    }),
  },
  {
    labelKey: "code128",
    build: (xMm, yMm) => ({
      kind: "barcode",
      id: crypto.randomUUID(),
      xMm,
      yMm,
      format: "code128",
      data: "sscc",
      sizeMm: 10,
    }),
  },
  {
    labelKey: "ean13",
    build: (xMm, yMm) => ({
      kind: "barcode",
      id: crypto.randomUUID(),
      xMm,
      yMm,
      format: "ean13",
      data: "product.gtin",
      sizeMm: 10,
    }),
  },
  {
    labelKey: "qr",
    build: (xMm, yMm) => ({
      kind: "barcode",
      id: crypto.randomUUID(),
      xMm,
      yMm,
      format: "qr",
      data: "sscc",
      sizeMm: 0.4,
    }),
  },
  {
    labelKey: "line",
    build: (xMm, yMm) => ({
      kind: "line",
      id: crypto.randomUUID(),
      xMm,
      yMm,
      x2Mm: xMm + 20,
      y2Mm: yMm,
      thicknessMm: 0.5,
    }),
  },
  {
    labelKey: "box",
    build: (xMm, yMm) => ({
      kind: "box",
      id: crypto.randomUUID(),
      xMm,
      yMm,
      widthMm: 20,
      heightMm: 15,
      thicknessMm: 0.5,
    }),
  },
];

const BUTTON_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-2)",
  background: "var(--surface-panel)",
  font: "500 13px/18px var(--font-ui)",
  color: "var(--fg-1)",
  cursor: "pointer",
  textAlign: "left" as const,
  width: "100%",
};

export function Palette({ labelWidthMm, labelHeightMm, onAdd }: PaletteProps) {
  const { t } = useTranslation();
  const centerXMm = Math.round(labelWidthMm / 2);
  const centerYMm = Math.round(labelHeightMm / 2);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "16px 12px" }}>
      <span
        style={{
          font: "500 11px/1 var(--font-ui)",
          color: "var(--fg-3)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          padding: "0 4px 6px 4px",
        }}
      >
        {t("pages.labels.editor.palette.title")}
      </span>
      {PALETTE_BUTTONS.map((button) => (
        <button
          key={button.labelKey}
          type="button"
          style={BUTTON_STYLE}
          onClick={() =>
            onAdd(button.build(centerXMm, centerYMm, t("pages.labels.editor.defaultText")))
          }
        >
          {t(`pages.labels.editor.palette.${button.labelKey}`)}
        </button>
      ))}
    </div>
  );
}
