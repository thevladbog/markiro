import { useTranslation } from "react-i18next";
import { CancelOperation } from "../ui/CancelOperation.js";

export interface OperationChoiceProps {
  writeoffAvailable: boolean;
  onChoose: (reason: "buy" | "writeoff") => void;
  onBack: () => void;
  onCancel: () => void;
}

export function OperationChoice({
  writeoffAvailable,
  onChoose,
  onBack,
  onCancel,
}: OperationChoiceProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <main className="kiosk-screen kiosk-flow kiosk-operation">
      <header className="kiosk-flow__header">
        <button className="kiosk-control kiosk-flow__back" type="button" onClick={onBack}>
          {t("flow.back")}
        </button>
        <div>
          <span className="kiosk-flow__eyebrow">{t("operation.eyebrow")}</span>
          <h1>{t("operation.title")}</h1>
        </div>
        <CancelOperation onConfirm={onCancel} />
      </header>

      <section className="kiosk-operation__choices" aria-label={t("operation.title")}>
        <button
          className="kiosk-control kiosk-choice"
          type="button"
          onClick={() => onChoose("buy")}
        >
          <span className="kiosk-choice__icon" aria-hidden="true">
            ₽
          </span>
          <strong>{t("operation.buy.title")}</strong>
          <small>{t("operation.buy.description")}</small>
        </button>
        <button
          className="kiosk-control kiosk-choice"
          type="button"
          disabled={!writeoffAvailable}
          onClick={() => onChoose("writeoff")}
        >
          <span className="kiosk-choice__icon" aria-hidden="true">
            −
          </span>
          <strong>{t("operation.writeoff.title")}</strong>
          <small>{t("operation.writeoff.description")}</small>
        </button>
      </section>
      {!writeoffAvailable ? (
        <p className="kiosk-operation__unavailable" role="status">
          {t("operation.writeoff.unavailable")}
        </p>
      ) : null}
    </main>
  );
}
