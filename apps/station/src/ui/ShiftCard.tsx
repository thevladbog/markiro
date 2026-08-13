import { Button, Card } from "@markiro/ui";
import type { SqlExecutor, StationProductImageDescriptor } from "../lib/mirror.js";
import { ProductImage } from "./ProductImage.js";

export interface ShiftCardProps {
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
}

/** A fixed-height floor card; the parent supplies a bounded page of at most three. */
export function ShiftCard({
  productName,
  counterpartyName,
  counterpartyLabel,
  actionLabel,
  active,
  disabled,
  onSelect,
  exec,
  productId,
  image,
}: ShiftCardProps) {
  return (
    <Card className="shift-card" padding="var(--sp-3)">
      <div className="shift-card__body">
        {productId ? <ProductImage exec={exec} productId={productId} productName={productName} image={image} /> : null}
        <div className="shift-card__product">{productName ?? "—"}</div>
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
