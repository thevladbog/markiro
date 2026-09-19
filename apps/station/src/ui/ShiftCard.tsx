import type { CSSProperties } from "react";
import { Badge, Button, Card, StatusChip } from "@markiro/ui";
import type { BadgeTone, TagPhase } from "@markiro/ui";
import { formatShiftPlannedDate, stationDisplayLocale } from "../lib/format-date.js";
import type { SqlExecutor, StationProductImageDescriptor } from "../lib/mirror.js";
import { useProductAccentHue } from "../lib/product-accent.js";
import { ProductImage } from "./ProductImage.js";
import { productMonogram } from "./work/ScanResultInstrument.js";

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
  /**
   * Full catalogue name, shown small beneath the headline. The page passes the
   * catalogue name here only when a print name took over the headline, so a
   * value equal to `productName` is dropped rather than printed twice.
   */
  productFullName?: string | null;
  /** GTIN-14 of the shift's product; seeds the photo panel's fallback accent hue. */
  gtin?: string | null;
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

/**
 * Режимы равноправны, поэтому тона категорийные и равногромкие: первый член
 * объединения получает violet, второй — teal (словарь тегов). Ни `neutral`,
 * ни `ok` здесь недопустимы — они читались бы как «архив» и «успех».
 */
const MODE_TONE: Record<"validation" | "aggregation", BadgeTone> = {
  validation: "violet",
  aggregation: "teal",
};

/** A fixed-height floor card; the parent supplies a bounded page of at most two. */
export function ShiftCard({
  number,
  productName,
  productFullName,
  gtin,
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
  // The panel's hue is derived from the product exactly as the work screen's
  // identity hero derives it: the photo's dominant colour, the GTIN hash as a
  // fallback, and no hue at all when there is neither.
  const hue = useProductAccentHue({ exec, productId, image, gtin, refreshKey: imageRefreshKey });
  const photoStyle = hue === null ? undefined : ({ "--product-hue": String(hue) } as CSSProperties);
  // A full name equal to the headline says nothing twice.
  const fullName = productFullName && productFullName !== productName ? productFullName : null;
  const modeCaption = modeLabel ?? mode ?? null;

  return (
    <Card className="shift-card" padding="var(--sp-1)">
      <div className="shift-card__body">
        <div
          className="shift-card__photo"
          data-accent={hue === null ? undefined : "true"}
          style={photoStyle}
        >
          {productId && image !== null ? (
            <ProductImage
              exec={exec}
              productId={productId}
              productName={productName}
              image={image}
              refreshKey={imageRefreshKey}
            />
          ) : (
            <span className="shift-card__photo-monogram" aria-hidden="true">
              {productMonogram(productName ?? "")}
            </span>
          )}
        </div>
        <div className="shift-card__details">
          <div className="shift-card__heading">
            {number ? (
              <Badge className="shift-card__number" size="office" mono>
                {number}
              </Badge>
            ) : null}
            <StatusChip
              className="shift-card__status"
              size="office"
              phase={SHIFT_CARD_STATUS_TO_PHASE[status ?? "planned"]}
              label={statusLabel ?? status}
            />
          </div>
          <div className="shift-card__product">{productName ?? "—"}</div>
          {fullName ? <div className="shift-card__product-full">{fullName}</div> : null}
          {/* Two parts so the production date wraps whole on a narrow card
              instead of ellipsizing the middle of one combined line. */}
          {formattedDate || formattedProductionDate ? (
            <div className="shift-card__dates">
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
          {/* Facts, not prose: the mode and the pallet flag are tags, the plan
              is plain mono text and never shares a badge with them. */}
          <div className="shift-card__mode">
            {modeCaption ? (
              <Badge
                className="shift-card__mode-badge"
                size="office"
                tone={MODE_TONE[mode ?? "validation"]}
              >
                {modeCaption}
              </Badge>
            ) : null}
            {palletsEnabled ? (
              <Badge className="shift-card__pallets" size="office">
                {palletsLabel ?? "pallets"}
              </Badge>
            ) : null}
            <span className="shift-card__plan">
              {formattedQuantity !== null
                ? `${plannedLabel ?? "plan"} ${formattedQuantity}`
                : (noPlanLabel ?? "no plan")}
            </span>
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
