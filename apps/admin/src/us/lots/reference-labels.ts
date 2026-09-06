import type { TraceabilityLot } from "@markiro/platform-contracts";
import { UsClientError, type UsBrowserClient } from "../client.js";

/** Current reference labels, never frozen event evidence or a cross-tenant cache. */
export async function loadLotReferenceLabels(
  client: UsBrowserClient,
  lots: readonly TraceabilityLot[],
) {
  const products = [...new Set(lots.map((lot) => lot.productId))];
  const locations = [
    ...new Set(
      lots.flatMap((lot) =>
        lot.source
          ? [lot.source.kind === "location" ? lot.source.locationId : lot.source.resolvedLocationId]
          : [],
      ),
    ),
  ];
  const labels: Record<string, string> = {};
  const results = await Promise.allSettled([
    ...products.map(async (id) => {
      const record = await client.getProduct(id);
      if (record.id !== id) throw new UsClientError("invalid_response");
      labels[`product:${id}`] = record.name;
    }),
    ...locations.map(async (id) => {
      const record = await client.getLocation(id);
      if (record.id !== id) throw new UsClientError("invalid_response");
      labels[`location:${id}`] = record.name;
    }),
  ]);
  // A fast reference-data failure must not hide a later session/permission denial.
  // Each underlying request has the client's bounded deadline.
  const failures: UsClientError[] = [];
  for (const result of results) {
    if (result.status !== "rejected") continue;
    const error: unknown = result.reason;
    failures.push(error instanceof UsClientError ? error : new UsClientError("unavailable"));
  }
  for (const code of ["session_required", "forbidden"]) {
    const denial = failures.find((error) => error.code === code);
    if (denial) throw denial;
  }
  const failure = failures[0];
  if (failure) throw failure;
  return labels;
}
