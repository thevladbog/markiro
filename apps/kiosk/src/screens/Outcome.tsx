import type { CreateOrderResultDto } from "../api/types.js";
import type { CartState } from "../session/cart.js";
import type { StoredKioskOutcome } from "../store/outcomes.js";
import { Done } from "./Done.js";

export interface OutcomeProps {
  storedOutcome?: StoredKioskOutcome | undefined;
  result: CreateOrderResultDto | null;
  cart: Pick<CartState, "lines" | "reason">;
  showPrices: boolean;
  onReset: () => void;
}

export function Outcome({
  storedOutcome,
  result,
  cart,
  showPrices,
  onReset,
}: OutcomeProps): React.JSX.Element {
  if (!storedOutcome || result !== null) {
    return <Done result={result} cart={cart} showPrices={showPrices} onReset={onReset} />;
  }
  const restoredResult: CreateOrderResultDto = {
    orderNo: storedOutcome.orderNo ?? "",
    status: "pending",
    itemCount: storedOutcome.acceptedCount,
    conflicts: storedOutcome.rejected
      .filter((line) => line.kind === "loose")
      .map((line) => ({ rawKm: line.kind === "loose" ? line.codeTail : "", reason: line.reason })),
    boxConflicts: storedOutcome.rejected
      .filter((line) => line.kind === "box")
      .map((line) =>
        line.kind === "box"
          ? { sscc: line.sscc, bottleCount: line.bottleCount, reason: line.reason }
          : { sscc: "", bottleCount: null, reason: "unknown_box" },
      ),
    acceptedBoxes: storedOutcome.acceptedBoxes,
  };
  return (
    <Done
      result={restoredResult}
      cart={{ lines: [], reason: cart.reason }}
      showPrices={false}
      onReset={onReset}
    />
  );
}
