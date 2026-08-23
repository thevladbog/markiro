import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Pager } from "@markiro/ui";
import type { ClosedBoxSummary } from "../lib/boxes.js";
import { splitSsccForHighlight } from "../lib/sscc-tail-filter.js";

const BOXES_PER_PAGE = 4;

export interface ShiftBoxesPanelProps {
  boxes: ClosedBoxSummary[];
  selectedBoxId: string | null;
  onSelectionChange: (box: ClosedBoxSummary | null) => void;
  /** The typed SSCC tail: emphasized inside each row so the operator sees WHY it matched. */
  highlightTail?: string;
  /** Boxes hidden by the tail filter; printed so a filter never reads as an empty shift. */
  hiddenCount?: number;
}

/** Bounded target picker for boxes produced by this terminal during the current shift. */
export function ShiftBoxesPanel({
  boxes,
  selectedBoxId,
  onSelectionChange,
  highlightTail = "",
  hiddenCount = 0,
}: ShiftBoxesPanelProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(boxes.length / BOXES_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * BOXES_PER_PAGE;
  const pageBoxes = boxes.slice(offset, offset + BOXES_PER_PAGE);
  const filtered = highlightTail !== "";

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
      <header className="shift-boxes__header">
        <h2 id="closed-boxes-title">{t("box.selectTarget")}</h2>
        {filtered ? (
          <span className="shift-boxes__found" data-testid="boxes-found">
            {t("box.foundOf", { matched: boxes.length, total: boxes.length + hiddenCount })}
          </span>
        ) : null}
      </header>
      {boxes.length === 0 ? (
        <p className="shift-boxes__empty">
          {filtered ? t("box.noTailMatches") : t("box.closedEmpty")}
        </p>
      ) : (
        <div className="shift-boxes__list" role="list">
          {pageBoxes.map((box) => {
            const { head, tail } = splitSsccForHighlight(box.sscc, highlightTail);
            return (
              <div key={box.boxId} role="listitem">
                <Button
                  type="button"
                  size="floor"
                  variant={selectedBoxId === box.boxId ? "primary" : "secondary"}
                  className="shift-boxes__row"
                  aria-pressed={selectedBoxId === box.boxId}
                  onClick={() => onSelectionChange(box)}
                >
                  <strong>
                    SSCC {head}
                    {tail !== "" ? <mark className="shift-boxes__match">{tail}</mark> : null}
                  </strong>
                  <span>{t("box.closedItems", { count: box.itemCount })}</span>
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {filtered && hiddenCount > 0 ? (
        <p className="shift-boxes__hidden">{t("box.hiddenByFilter", { count: hiddenCount })}</p>
      ) : null}
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
