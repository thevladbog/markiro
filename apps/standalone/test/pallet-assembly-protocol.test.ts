import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createHostApi } from "../src/host/api.js";
import type { HostClient } from "../src/host/client.js";
import {
  boxRegistryPageSchema,
  palletAssemblyCloseIssueSchema,
} from "../src/host/pallet-assembly.js";
import { syncPalletBoxRegistry } from "../src/floor/pallet-assembly/registry-sync.js";

const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

describe("station pallet assembly host contract", () => {
  it("retains all fields of the Rust registry and approved close issue fixtures", () => {
    const registry = fixture("station-box-registry-page.json");
    const issue = fixture("warehouse-pallet-close-issue.json");
    expect(boxRegistryPageSchema.parse(registry)).toEqual(registry);
    expect(palletAssemblyCloseIssueSchema.parse(issue)).toEqual(issue);
  });
  it("walks the box registry as a paired device and keeps the box's source shift", async () => {
    const until = "2026-11-11T08:20:00Z";
    const sscc = "046006820000015024";
    const cursor = `${until}|${sscc}`;
    const page = {
      until,
      items: [{ kind: "upsert", sscc, updatedAt: until, shiftNumber: "СМ-418" }],
    };
    const client: HostClient = {
      request: async (method, path, options) => {
        expect(method).toBe("GET");
        expect(path).toBe(
          `/v1/device/box-registry?until=${encodeURIComponent(until)}&cursor=${encodeURIComponent(cursor)}`,
        );
        expect(options.officeToken).toBeUndefined();
        return options.schema.parse(page);
      },
    };
    await expect(createHostApi(client).getBoxRegistry({ until, cursor })).resolves.toEqual(page);
  });

  it("posts the saved events and keeps the receipt's winning pallet", async () => {
    const records = [{ id: "attempt", kind: "pallet_box_added", data: { boxSscc: "box" } }];
    const receipts = [
      {
        id: "attempt",
        outcome: "rejected",
        code: "box_on_pallet",
        details: { palletSscc: "146006820000000409" },
      },
    ];
    const client: HostClient = {
      request: async (method, path, options) => {
        expect(method).toBe("POST");
        expect(path).toBe("/v1/device/pallet-events");
        expect(options.body).toEqual({ records });
        expect(options.officeToken).toBeUndefined();
        return options.schema.parse({ receipts });
      },
    };
    await expect(createHostApi(client).sendPalletEvents(records)).resolves.toEqual(receipts);
  });
});

describe("station box registry refresh", () => {
  it("restarts with a full walk after a host restore and applies only pages of the new window", async () => {
    const old = "2026-11-11T08:20:00Z";
    const restored = "2026-11-11T08:15:00Z";
    const pages: unknown[] = [];
    const requested: unknown[] = [];
    await syncPalletBoxRegistry({
      state: { until: old, restoreEpoch: "before" },
      getPage: async (query) => {
        requested.push(query);
        return {
          until: restored,
          items: [],
          restoreEpoch: "after",
          ...(query.since === undefined && query.cursor === undefined
            ? { nextCursor: "next" }
            : {}),
        };
      },
      applyPage: async (page, mode) => {
        pages.push({ page, mode });
      },
    });
    expect(requested).toEqual([{ since: old }, {}, { until: restored, cursor: "next" }]);
    expect(pages).toEqual([
      {
        page: { until: restored, items: [], restoreEpoch: "after", nextCursor: "next" },
        mode: { full: true, first: true },
      },
      {
        page: { until: restored, items: [], restoreEpoch: "after" },
        mode: { full: true, first: false },
      },
    ]);
  });
});
