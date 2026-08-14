import { Button, Card } from "@markiro/ui";
import type { SqlExecutor, StationProductImageDescriptor } from "../lib/mirror.js";
import { ProductImage } from "./ProductImage.js";

export interface ShiftCardProps {
  plannedDate?: string | null;
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

/** A fixed-height floor card; the parent supplies a bounded page of at most three. */
export function ShiftCard({
  productName,
  plannedDate,
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
  return (
    <Card className="shift-card" padding="var(--sp-3)">
      <div className="shift-card__body">
        {productId && image !== null ? (
          <ProductImage
            exec={exec}
            productId={productId}
            productName={productName}
            image={image}
            refreshKey={imageRefreshKey}
          />
        ) : null}
        <div className="shift-card__product">{productName ?? "—"}</div>
        <div className="shift-card__meta">
          {plannedDate ? `${plannedDate} · ` : ""}
          {modeLabel ?? mode}
          {plannedQty !== null && plannedQty !== undefined
            ? ` · ${plannedLabel ?? "plan"} ${plannedQty}`
            : ` · ${noPlanLabel ?? "no plan"}`}
        </div>
        <div className="shift-card__status">{statusLabel ?? status}</div>
        <div className="shift-card__counterparty">
          {counterpartyName ? `${counterpartyLabel} ${counterpartyName}` : null}
        </div>
      </div>
      <Button
        size="floor"
        variant={active ? "primary" : "secondary"}
        fullWidth
        disabled={disabled}
        onClick={onSelect}
      >
        {actionLabel}
      </Button>
    </Card>
  );
}
