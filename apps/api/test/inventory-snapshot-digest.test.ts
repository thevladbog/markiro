import { describe, expect, it } from "vitest";

import { inventorySnapshotCombinedDigest } from "../src/modules/inventories/inventory-snapshot.service";

describe("inventory snapshot combined digest", () => {
  it("uses versioned canonical JSON and exact inventory status order", () => {
    const evidence = [
      {
        status: "DISAGGREGATION" as const,
        importId: "00000000-0000-4000-8000-000000000006",
        sha256: "6".repeat(64),
        byteSize: 6,
        containerKind: "xlsx" as const,
      },
      {
        status: "WRITTEN_OFF" as const,
        importId: "00000000-0000-4000-8000-000000000005",
        sha256: "5".repeat(64),
        byteSize: 5,
        containerKind: "zip" as const,
      },
      {
        status: "RETIRED" as const,
        importId: "00000000-0000-4000-8000-000000000004",
        sha256: "4".repeat(64),
        byteSize: 4,
        containerKind: "csv" as const,
      },
      {
        status: "APPLIED" as const,
        importId: "00000000-0000-4000-8000-000000000003",
        sha256: "3".repeat(64),
        byteSize: 3,
        containerKind: "xlsx" as const,
      },
      {
        status: "INTRODUCED" as const,
        importId: "00000000-0000-4000-8000-000000000002",
        sha256: "2".repeat(64),
        byteSize: 2,
        containerKind: "zip" as const,
      },
      {
        status: "EMITTED" as const,
        importId: "00000000-0000-4000-8000-000000000001",
        sha256: "1".repeat(64),
        byteSize: 1,
        containerKind: "csv" as const,
      },
    ];

    expect(inventorySnapshotCombinedDigest(evidence)).toBe(
      "934cf000600593cae0aa247a4d9425d86e4453d22881b63b959826fa4daa5cc9",
    );
  });
});
