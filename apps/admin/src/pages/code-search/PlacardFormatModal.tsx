/**
 * The A4 / A5 choice before a placard document opens in a new tab. Shared by
 * the pallet card (one pallet) and the shift panel (every closed pallet of the
 * shift): the only thing the two ask is the paper size, and the printed pages
 * are the same, so the dialog is the same.
 *
 * `@markiro/ui` has no menu/popover component (spec 2026-09-18 §4); a compact
 * modal keeps the choice keyboard-operable without new infrastructure.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Modal, RadioGroup } from "@markiro/ui";

export type PlacardFormat = "a4" | "a5";

/** The viewer's own zone, sent for symmetry with the other reports. */
export function placardQuery(format: PlacardFormat): string {
  return new URLSearchParams({
    format,
    timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).toString();
}

export function PlacardFormatModal({
  open,
  title,
  onClose,
  onOpen,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Called with the chosen size; the caller opens its own URL and closes. */
  onOpen: (format: PlacardFormat) => void;
}) {
  const { t } = useTranslation();
  // Sticky across openings on purpose: a warehouse printing a run of A5
  // placards should not have to pick A5 every time.
  const [format, setFormat] = useState<PlacardFormat>("a4");

  return (
    <Modal
      open={open}
      title={title}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={() => onOpen(format)}>
            {t("pages.codeSearch.palletCard.placard.open")}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <RadioGroup
          label={t("pages.codeSearch.palletCard.placard.formatLabel")}
          name="pallet-placard-format"
          value={format}
          onValueChange={(value) => setFormat(value === "a5" ? "a5" : "a4")}
          options={[
            { value: "a4", label: t("pages.codeSearch.palletCard.placard.format.a4") },
            { value: "a5", label: t("pages.codeSearch.palletCard.placard.format.a5") },
          ]}
        />
        <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
          {t("pages.codeSearch.palletCard.placard.hint")}
        </span>
      </div>
    </Modal>
  );
}
