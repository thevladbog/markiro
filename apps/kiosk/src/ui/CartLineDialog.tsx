import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@markiro/ui";
import type { KioskCartLine } from "../session/cart.js";
import { ItemKindIcon } from "./ItemKindIcon.js";

export interface CartLineDialogProps {
  line: KioskCartLine | null;
  onClose: () => void;
  onRemove: (line: KioskCartLine) => void;
}

export function CartLineDialog({
  line,
  onClose,
  onRemove,
}: CartLineDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => setConfirming(false), [line]);
  if (line === null) return <></>;

  const box = line.kind === "box";
  const count = line.bottleCount;
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t("cart.close")}
      className="kiosk-line-dialog"
      width={560}
      title={
        confirming ? t(box ? "cart.confirmRemoveBoxTitle" : "cart.confirmRemoveKmTitle") : line.name
      }
      footer={
        confirming ? (
          <>
            <button
              className="kiosk-control kiosk-dialog-button"
              type="button"
              onClick={() => setConfirming(false)}
            >
              {t("cart.cancel")}
            </button>
            <button
              className="kiosk-control kiosk-dialog-button kiosk-dialog-button--danger"
              type="button"
              onClick={() => onRemove(line)}
            >
              {t(box ? "cart.confirmRemoveBox" : "cart.confirmRemoveKm", { count })}
            </button>
          </>
        ) : (
          <button
            className="kiosk-control kiosk-dialog-button kiosk-dialog-button--danger"
            type="button"
            onClick={() => setConfirming(true)}
          >
            {t(box ? "cart.removeBox" : "cart.removeKm")}
          </button>
        )
      }
    >
      <div className="kiosk-line-dialog__body">
        <ItemKindIcon kind={line.kind} />
        <p className="kiosk-line-dialog__name">{line.name}</p>
        <dl className="kiosk-line-dialog__details">
          <div>
            <dt>{t("cart.quantity")}</dt>
            <dd>{t("cart.bottles", { count })}</dd>
          </div>
          <div>
            <dt>{t("cart.code")}</dt>
            <dd>{line.kind === "km" ? line.serial : line.sscc}</dd>
          </div>
        </dl>
        {box ? <p className="kiosk-line-dialog__hint">{t("cart.boxAtomicHint")}</p> : null}
      </div>
    </Modal>
  );
}
