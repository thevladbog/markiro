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
import { IconButton } from "@markiro/ui";

export interface PaletteProps {
  /** The label's own size -- new elements are centered within it. */
  labelWidthMm: number;
  labelHeightMm: number;
  onAdd: (element: LabelElement) => void;
}

interface PaletteButtonDef {
  /** i18n key under `pages.labels.editor.palette`. */
  labelKey: string;
  icon: string;
  build: (centerXMm: number, centerYMm: number, defaultText: string) => LabelElement;
}

const PALETTE_BUTTONS: PaletteButtonDef[] = [
  {
    labelKey: "text",
    icon: "T",
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
    icon: "ƒ",
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
    icon: "▦",
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
    icon: "▤",
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
    icon: "▥",
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
    icon: "▧",
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
    icon: "╱",
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
    icon: "□",
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
        <IconButton
          key={button.labelKey}
          aria-label={t(`pages.labels.editor.palette.${button.labelKey}`)}
          icon={<span aria-hidden="true">{button.icon}</span>}
          title={t(`pages.labels.editor.palette.${button.labelKey}`)}
          onClick={() =>
            onAdd(button.build(centerXMm, centerYMm, t("pages.labels.editor.defaultText")))
          }
        />
      ))}
    </div>
  );
}
