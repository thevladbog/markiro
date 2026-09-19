import { Badge, Button, Card, StatusChip } from "@markiro/ui";
import type { TagPhase } from "@markiro/ui";
import { formatShiftPlannedDate, stationDisplayLocale } from "../lib/format-date.js";
import type { SqlExecutor, StationProductImageDescriptor } from "../lib/mirror.js";
import { ProductImage } from "./ProductImage.js";

export interface ShiftCardProps {
  number?: string | null;
  plannedDate?: string | null;
  /** Caption before the planned date («Смена»); without it the bare date is shown. */
  plannedDateLabel?: string;
  productionDate?: string | null;
  productionDateLabel?: string;
  locale?: string;
  plannedQty?: number | null;
  mode?: "validation" | "aggregation";
  /** Aggregation shift that also builds pallets; shown beside the mode so it is not read as plain box aggregation. */
  palletsEnabled?: boolean;
  status?: "planned" | "active" | "closing" | "closed";
  modeLabel?: string;
  palletsLabel?: string;
  statusLabel?: string;
  noPlanLabel?: string;
  plannedLabel?: string;
  productName: string | null;
  counterpartyName?: string | null;
  counterpartyLabel: string;
  actionLabel: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  exec?: SqlExecutor | undefined;
  productId?: string;
  image?: StationProductImageDescriptor | null | undefined;
  imageRefreshKey?: number;
}

/**
 * `closing` — самостоятельная фаза `running`, а не разновидность ожидания:
 * смена ещё не закрыта, закрытие идёт.
 */
const SHIFT_CARD_STATUS_TO_PHASE: Record<NonNullable<ShiftCardProps["status"]>, TagPhase> = {
  planned: "planned",
  active: "active",
  closing: "running",
  closed: "done",
};

/** A fixed-height floor card; the parent supplies a bounded page of at most two. */
export function ShiftCard({
  number,
  productName,
  plannedDate,
  plannedDateLabel,
  productionDate,
  productionDateLabel,
  locale = "ru",
  plannedQty,
  mode,
  palletsEnabled = false,
  status,
  modeLabel,
  palletsLabel,
  statusLabel,
  noPlanLabel,
  plannedLabel,
  counterpartyName,
  counterpartyLabel,
  actionLabel,
  active,
  disabled,
  onSelect,
  exec,
  productId,
  image,
  imageRefreshKey,
}: ShiftCardProps) {
  const formattedDate = formatShiftPlannedDate(plannedDate, locale);
  const formattedProductionDate = formatShiftPlannedDate(productionDate, locale);
  const formattedQuantity =
    plannedQty !== null && plannedQty !== undefined
      ? new Intl.NumberFormat(stationDisplayLocale(locale)).format(plannedQty)
      : null;

  return (
    <Card className="shift-card" padding="var(--sp-1)">
      <div className="shift-card__body">
        {productId && image !== null ? (
          <ProductImage
            exec={exec}
            productId={productId}
            productName={productName}
            image={image}
            refreshKey={imageRefreshKey}
          />
        ) : (
          <div
            className="product-image product-image--fallback shift-card__image-placeholder"
            aria-hidden="true"
          />
        )}
        <div className="shift-card__details">
          <div className="shift-card__heading">
            {number ? (
              <Badge className="shift-card__number" size="floor" mono>
                {number}
              </Badge>
            ) : null}
            <StatusChip
              className="shift-card__status"
              size="floor"
              phase={SHIFT_CARD_STATUS_TO_PHASE[status ?? "planned"]}
              label={statusLabel ?? status}
            />
          </div>
          <div className="shift-card__product">{productName ?? "—"}</div>
          <div className="shift-card__meta">
            {formattedDate || formattedProductionDate ? (
              <div className="shift-card__date">
                {formattedDate ? (
                  <span className="shift-card__date-part">
                    {plannedDateLabel ? `${plannedDateLabel}: ${formattedDate}` : formattedDate}
                  </span>
                ) : null}
                {formattedProductionDate ? (
                  <span className="shift-card__date-part">
                    {`${productionDateLabel ?? "Производство"}: ${formattedProductionDate}`}
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* Two parts like the dates: on a narrow terminal the plan wraps
                whole onto its own line instead of ellipsizing to «без…». */}
            <div className="shift-card__plan">
              <span className="shift-card__plan-part">
                {modeLabel ?? mode}
                {palletsEnabled ? (
                  <span className="shift-card__pallets">{` · ${palletsLabel ?? "pallets"}`}</span>
                ) : null}
              </span>
              <span className="shift-card__plan-part">
                {formattedQuantity !== null
                  ? `${plannedLabel ?? "plan"} ${formattedQuantity}`
                  : (noPlanLabel ?? "no plan")}
              </span>
            </div>
          </div>
          <div className="shift-card__counterparty">
            {counterpartyName ? `${counterpartyLabel} ${counterpartyName}` : null}
          </div>
          <Button
            className="shift-card__action"
            size="floor"
            variant={active ? "primary" : "secondary"}
            fullWidth
            disabled={disabled}
            onClick={onSelect}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}
