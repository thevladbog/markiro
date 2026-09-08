import { useInfiniteQuery } from "@tanstack/react-query";
import {
  productLabelHistorySchema,
  productLabelEventHistorySchema,
  type ProductLabelHistoryRow,
} from "@markiro/domain";
import { apiFetch } from "../../api/client.js";

export function useProductLabelHistory(shiftId: string) {
  return useInfiniteQuery({
    queryKey: ["product-label-history", shiftId],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      productLabelHistorySchema.parse(
        await apiFetch<unknown>(
          `/shifts/${encodeURIComponent(shiftId)}/product-labels?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
          { signal },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
export function useProductLabelEvents(
  shiftId: string,
  job: Pick<ProductLabelHistoryRow, "jobId" | "deviceId">,
) {
  return useInfiniteQuery({
    queryKey: ["product-label-events", shiftId, job.deviceId, job.jobId],
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) =>
      productLabelEventHistorySchema.parse(
        await apiFetch<unknown>(
          `/shifts/${encodeURIComponent(shiftId)}/product-labels/${encodeURIComponent(job.jobId)}/events?deviceId=${encodeURIComponent(job.deviceId)}&afterSequence=${pageParam}&limit=100`,
          { signal },
        ),
      ),
    getNextPageParam: (last) => last.nextSequence ?? undefined,
  });
}
