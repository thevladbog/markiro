import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  const [focusId, setFocusId] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selectedIsActive = reasons.some((reason) => reason.id === selectedId);

  useEffect(() => {
    const selectedIndex = reasons.findIndex((reason) => reason.id === selectedId);
    if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / 6));
  }, [reasons, selectedId]);

  useEffect(() => {
    if (focusId !== null) buttons.current.get(focusId)?.focus();
  }, [focusId, page]);

  const moveSelection = (reasonId: string, event: KeyboardEvent<HTMLButtonElement>) => {
    const directions: Record<string, number> = {
      ArrowLeft: -1,
      ArrowUp: -1,
      ArrowRight: 1,
      ArrowDown: 1,
    };
    const direction = directions[event.key];
    if (direction === undefined || reasons.length === 0) return;
    const current = reasons.findIndex((reason) => reason.id === reasonId);
    if (current < 0) return;
    event.preventDefault();
    const next = reasons[(current + direction + reasons.length) % reasons.length];
    if (!next) return;
    setPage(Math.floor(reasons.indexOf(next) / 6));
    setFocusId(next.id);
    onSelect(next.id);
  };

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
        role="radiogroup"
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
              tabIndex={
                selectedId === reason.id || (!selectedIsActive && reasons[0]?.id === reason.id)
                  ? 0
                  : -1
              }
              ref={(node) => {
                if (node) buttons.current.set(reason.id, node);
                else buttons.current.delete(reason.id);
              }}
              onClick={() => onSelect(reason.id)}
              onKeyDown={(event) => moveSelection(reason.id, event)}
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
