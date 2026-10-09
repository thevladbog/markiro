import { useQueryClient } from "@tanstack/react-query";

import { HostError } from "../../host/client.js";
import { officeKeys } from "../office-query.js";

/**
 * What a shift dialog calls with a failed write: after a lost answer (a
 * transport failure) the host may have done the work, so every list of shifts
 * is read again and the list behind the dialog shows whether it did. A create
 * has no request id to make a resend repeatable, a change, a delete and a
 * close are only retried by hand. An answer of the host (a refusal) means it
 * did nothing, so the lists are left alone.
 */
export function useRereadShiftsOnLostAnswer(): (error: unknown) => void {
  const queryClient = useQueryClient();
  return (error) => {
    if (error instanceof HostError && error.kind === "transport") {
      void queryClient.invalidateQueries({ queryKey: officeKeys.shifts });
    }
  };
}
