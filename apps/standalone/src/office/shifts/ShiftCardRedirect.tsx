import { Navigate, useParams, useSearchParams } from "react-router";

import { shiftCardPath } from "./shift-card.js";

/**
 * The old address of a shift's card, `/shifts/:id`: the card is a drawer over
 * «Смены» now, so a saved link or a bookmark lands on `/shifts?shift=…` (a
 * `?box=` or `?tab=` goes with it).
 */
export function ShiftCardRedirect() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const box = params.get("box");
  const tab = params.get("tab");
  return (
    <Navigate
      replace
      to={shiftCardPath(id, {
        ...(box === null ? {} : { box }),
        ...(tab === null ? {} : { tab }),
      })}
    />
  );
}
