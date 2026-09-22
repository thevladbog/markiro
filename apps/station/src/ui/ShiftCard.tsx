import type { CSSProperties } from "react";
import { Badge, Button, Card, StatusChip } from "@markiro/ui";
import type { TagPhase } from "@markiro/ui";
import { formatShiftPlannedDate, stationDisplayLocale } from "../lib/format-date.js";
import type { SqlExecutor, StationProductImageDescriptor } from "../lib/mirror.js";
import { useProductPhotoAccent } from "../lib/product-accent.js";
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
  const monogram = (
    <span className="shift-card__photo-monogram" aria-hidden="true">
      {productMonogram(productName ?? "")}
    </span>
  );
  const { hue, opaque } = useProductPhotoAccent({
    exec,
    productId,
    image,
    gtin,
    refreshKey: imageRefreshKey,
  });
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
          /* Снимок-вырезка стоит прямо на градиенте; у снимка со своей
             подложкой она никуда не денется, поэтому он подаётся КАК снимок —
             скруглённой карточкой с тенью, а не белым прямоугольником. */
          data-photo={opaque ? "opaque" : undefined}
          style={photoStyle}
        >
          {/* `undefined` is an unknown descriptor (a server from before the
              field existed), not a missing photo: ProductImage still consults
              the local cache pointer for it. Only an explicit null skips the
              lookup. Either way a photo that cannot be produced shows the same
              monogram, never the name as text on the gradient. */}
          {productId && image !== null ? (
            <ProductImage
              exec={exec}
              productId={productId}
              productName={productName}
              image={image}
              refreshKey={imageRefreshKey}
              fallback={monogram}
            />
          ) : (
            monogram
          )}
        </div>
        <div className="shift-card__details">
          <div className="shift-card__heading">
            {/* Номер — адрес смены, а не её свойство: тег здесь добавлял
                четвёртую коробку в строку, где и так есть статус. */}
            {number ? <span className="shift-card__number">{number}</span> : null}
            <StatusChip
              className="shift-card__status"
              size="office"
              phase={SHIFT_CARD_STATUS_TO_PHASE[status ?? "planned"]}
              label={statusLabel ?? status}
            />
          </div>
          {/* Без полного имени заголовку достаются и его строки: у товара
              без наименования для печати обрезался единственный текст, по
              которому смену отличают друг от друга. */}
          <div
            className={
              fullName ? "shift-card__product" : "shift-card__product shift-card__product--only"
            }
          >
            {productName ?? "—"}
          </div>
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
          {/* Факты, а не проза: режим и признак паллет — теги, план — просто
              моношрифтовый текст и никогда не делит с ними тег.

              Тона нейтральные у обоих: в принятом макете цвет на карточке
              несёт только статус смены, а режимы различаются словом. Правило
              словаря тегов («двум равноправным режимам — violet и teal»)
              запрещает АСИММЕТРИЮ, из-за которой «Проверка» читалась архивом,
              а «Агрегация» — успехом; два одинаково тихих тега её не создают. */}
          <div className="shift-card__mode">
            {modeCaption ? (
              <Badge className="shift-card__mode-badge" size="office">
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
