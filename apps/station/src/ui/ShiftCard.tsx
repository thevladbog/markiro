import { Button, Card } from "@markiro/ui";
import { formatShiftPlannedDate, stationDisplayLocale } from "../lib/format-date.js";
import type { SqlExecutor, StationProductImageDescriptor } from "../lib/mirror.js";
import { ProductImage } from "./ProductImage.js";

export interface ShiftCardProps {
  number?: string | null;
  plannedDate?: string | null;
  productionDate?: string | null;
  productionDateLabel?: string;
  locale?: string;
  plannedQty?: number | null;
  mode?: "validation" | "aggregation";
  status?: "planned" | "active" | "closed";
  modeLabel?: string;
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

/** A fixed-height floor card; the parent supplies a bounded page of at most two. */
export function ShiftCard({
  number,
  productName,
  plannedDate,
  productionDate,
  productionDateLabel,
  locale = "ru",
  plannedQty,
  mode,
  status,
  modeLabel,
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
            {number ? <div className="shift-card__number">{number}</div> : null}
            <div className="shift-card__status">{statusLabel ?? status}</div>
          </div>
          <div className="shift-card__product">{productName ?? "—"}</div>
          <div className="shift-card__meta">
            {formattedDate || formattedProductionDate ? (
              <div className="shift-card__date">
                {formattedDate ? (
                  <span className="shift-card__date-part">{formattedDate}</span>
                ) : null}
                {formattedProductionDate ? (
                  <span className="shift-card__date-part">
                    {`${productionDateLabel ?? "Производство"}: ${formattedProductionDate}`}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="shift-card__plan">
              {modeLabel ?? mode}
              {formattedQuantity !== null
                ? ` · ${plannedLabel ?? "plan"} ${formattedQuantity}`
                : ` · ${noPlanLabel ?? "no plan"}`}
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
