import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@markiro/ui";

export interface CancelOperationProps {
  onConfirm: () => void;
}

export function CancelOperation({ onConfirm }: CancelOperationProps): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="kiosk-control kiosk-flow__cancel"
        type="button"
        onClick={() => setOpen(true)}
      >
        {t("flow.cancel")}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        closeLabel={t("flow.keepWorking")}
        width={560}
        title={t("flow.cancelTitle")}
        footer={
          <div className="kiosk-flow__dialog-actions">
            <button
              className="kiosk-control kiosk-flow__secondary"
              type="button"
              onClick={() => setOpen(false)}
            >
              {t("flow.keepWorking")}
            </button>
            <button className="kiosk-control kiosk-flow__danger" type="button" onClick={onConfirm}>
              {t("flow.cancelConfirm")}
            </button>
          </div>
        }
      >
        <p className="kiosk-flow__dialog-copy">{t("flow.cancelBody")}</p>
      </Modal>
    </>
  );
}
