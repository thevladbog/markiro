import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PagedLines } from "../ui/PagedLines.js";
import { CancelOperation } from "../ui/CancelOperation.js";

export interface WriteoffReasonProps {
  reasons: readonly { id: string; name: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
  onCancel: () => void;
}

export function WriteoffReason({
  reasons,
  selectedId,
  onSelect,
  onContinue,
  onBack,
  onCancel,
}: WriteoffReasonProps): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const selectedIsActive = reasons.some((reason) => reason.id === selectedId);

  return (
    <main className="kiosk-screen kiosk-flow kiosk-reasons">
      <header className="kiosk-flow__header">
        <button className="kiosk-control kiosk-flow__back" type="button" onClick={onBack}>
          {t("flow.back")}
        </button>
        <div>
          <span className="kiosk-flow__eyebrow">{t("reason.eyebrow")}</span>
          <h1>{t("reason.title")}</h1>
        </div>
        <CancelOperation onConfirm={onCancel} />
      </header>

      <section
        className="kiosk-reasons__grid"
        aria-label={t("reason.title")}
        style={{ overflow: "hidden" }}
      >
        <PagedLines
          items={reasons}
          pageSize={6}
          page={page}
          onPageChange={setPage}
          renderItem={(reason) => (
            <button
              className="kiosk-control kiosk-reason"
              type="button"
              role="radio"
              aria-checked={selectedId === reason.id}
              onClick={() => onSelect(reason.id)}
              title={reason.name}
            >
              {reason.name}
            </button>
          )}
        />
      </section>

      <footer className="kiosk-flow__footer">
        <span>{selectedIsActive ? t("reason.selected") : t("reason.required")}</span>
        <button
          className="kiosk-control kiosk-flow__primary"
          type="button"
          disabled={!selectedIsActive}
          onClick={onContinue}
        >
          {t("flow.continue")}
        </button>
      </footer>
    </main>
  );
}
