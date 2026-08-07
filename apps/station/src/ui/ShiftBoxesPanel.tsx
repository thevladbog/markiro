import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Pager } from "@markiro/ui";
import type { ClosedBoxSummary } from "../lib/boxes.js";

const BOXES_PER_PAGE = 4;

export interface ShiftBoxesPanelProps {
  boxes: ClosedBoxSummary[];
  selectedBoxId: string | null;
  onSelectionChange: (box: ClosedBoxSummary | null) => void;
}

/** Bounded target picker for boxes produced by this terminal during the current shift. */
export function ShiftBoxesPanel({ boxes, selectedBoxId, onSelectionChange }: ShiftBoxesPanelProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(boxes.length / BOXES_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * BOXES_PER_PAGE;
  const pageBoxes = boxes.slice(offset, offset + BOXES_PER_PAGE);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  useEffect(() => {
    if (selectedBoxId && !boxes.some((box) => box.boxId === selectedBoxId)) {
      onSelectionChange(null);
    }
  }, [boxes, onSelectionChange, selectedBoxId]);

  return (
    <section className="shift-boxes" aria-labelledby="closed-boxes-title">
      <h2 id="closed-boxes-title">{t("box.selectTarget")}</h2>
      {boxes.length === 0 ? (
        <p className="shift-boxes__empty">{t("box.closedEmpty")}</p>
      ) : (
        <div className="shift-boxes__list" role="list">
          {pageBoxes.map((box) => (
            <div key={box.boxId} role="listitem">
              <Button
                type="button"
                size="floor"
                variant={selectedBoxId === box.boxId ? "primary" : "secondary"}
                className="shift-boxes__row"
                aria-pressed={selectedBoxId === box.boxId}
                onClick={() => onSelectionChange(box)}
              >
                <strong>SSCC {box.sscc}</strong>
                <span>{t("box.closedItems", { count: box.itemCount })}</span>
              </Button>
            </div>
          ))}
        </div>
      )}
      <Pager
        page={currentPage}
        pageCount={pageCount}
        onPageChange={setPage}
        ariaLabel={t("box.pagination")}
        previousLabel={t("box.previousPage")}
        nextLabel={t("box.nextPage")}
        pageLabel={(activePage, count) => t("box.page", { page: activePage, pageCount: count })}
      />
    </section>
  );
}
