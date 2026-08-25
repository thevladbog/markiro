import { Button } from "@markiro/ui";

import type {
  InventoryBoxPrintResult,
  InventoryPrintErrorCode,
} from "../../lib/inventory-box-printing.js";

export interface InventoryBoxPrintRecoveryProps {
  state: "printing" | "failed" | "printed";
  facts: Pick<InventoryBoxPrintResult, "sscc" | "quantity" | "productionDate">;
  errorCode?: InventoryPrintErrorCode | null;
  busy: boolean;
  onRetry: () => void;
  onSetup?: () => void;
  labels: {
    printing: string;
    printed: string;
    failed: string;
    sscc: string;
    quantity: string;
    productionDate: string;
    retry: string;
    setup: string;
    errors: Record<InventoryPrintErrorCode, string>;
  };
}

export function InventoryBoxPrintRecovery({
  state,
  facts,
  errorCode,
  busy,
  onRetry,
  onSetup,
  labels,
}: InventoryBoxPrintRecoveryProps) {
  return (
    <section className={`inventory-box-print inventory-box-print--${state}`} aria-live="assertive">
      <div className="inventory-box-print__status">
        <span aria-hidden="true">{state === "printed" ? "✓" : state === "failed" ? "!" : "⌁"}</span>
        <div>
          <h2>
            {state === "printed"
              ? labels.printed
              : state === "failed"
                ? labels.failed
                : labels.printing}
          </h2>
          {state === "failed" && errorCode ? <p>{labels.errors[errorCode]}</p> : null}
        </div>
      </div>
      <dl>
        <div>
          <dt>{labels.sscc}</dt>
          <dd>{facts.sscc}</dd>
        </div>
        <div>
          <dt>{labels.quantity}</dt>
          <dd>{facts.quantity}</dd>
        </div>
        <div>
          <dt>{labels.productionDate}</dt>
          <dd>{facts.productionDate}</dd>
        </div>
      </dl>
      {state === "failed" ? (
        <div className="inventory-box-print__actions">
          <Button size="floor" disabled={busy} onClick={onRetry}>
            {labels.retry}
          </Button>
          {onSetup ? (
            <Button size="floor" variant="secondary" disabled={busy} onClick={onSetup}>
              {labels.setup}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
