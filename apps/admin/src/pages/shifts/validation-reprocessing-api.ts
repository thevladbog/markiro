import { useInfiniteQuery } from "@tanstack/react-query";
import { validationReprocessingDetailsSchema } from "@markiro/domain";
import { apiFetch } from "../../api/client.js";

export function useValidationReprocessings(shiftId: string) {
  return useInfiniteQuery({
    queryKey: ["validation-reprocessings", shiftId],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      validationReprocessingDetailsSchema.parse(
        await apiFetch<unknown>(
          `/shifts/${encodeURIComponent(shiftId)}/reprocessings?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
          { signal },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
