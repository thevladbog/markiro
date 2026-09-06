import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { traceabilityLotSchema } from "@markiro/platform-contracts";
import { loadLotReferenceLabels } from "../src/us/lots/reference-labels.js";

const lot = {
  id: "a0000000-0000-4000-8000-000000000001",
  productId: "b0000000-0000-4000-8000-000000000001",
  tlc: "=Supplier-🍎",
  source: null,
  sourceLockedAt: null,
  assignmentBasis: "imported",
  status: "active",
  revision: 1,
  createdBy: "historical",
  updatedBy: "historical",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
const path = "/api/us/traceability/lots";
const transport = (value: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(value, { status }));
describe("US lot browser boundary", () => {
  it.each([
    [401, "session_required"],
    [403, "forbidden"],
  ] as const)(
    "does not lose a later %s reference denial after a transient failure",
    async (status, code) => {
      let resolveLocation: (value: Response) => void = () => {
        throw new Error("Promise not initialized");
      };
      const locationResponse = new Promise<Response>((resolve) => {
        resolveLocation = resolve;
      });
      const send = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          String(url).includes("/locations/")
            ? locationResponse
            : Response.json({}, { status: 503 }),
        );
      const record = traceabilityLotSchema.parse({
        ...lot,
        source: { kind: "location", locationId: "c0000000-0000-4000-8000-000000000001" },
      });
      const result = loadLotReferenceLabels(createUsBrowserClient(send), [record]);
      void result.catch(() => {});
      // A separate task lets the earlier product failure settle before the auth response.
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      resolveLocation(Response.json({}, { status }));
      await expect(result).rejects.toMatchObject({ code });
    },
  );
  it("uses only scoped collection and UUID command routes with exact revisioned bodies", async () => {
    const send = transport(lot);
    const client = createUsBrowserClient(send);
    expect(await client.getLot(lot.id.toUpperCase())).toEqual(lot);
    await client.createLot({ productId: lot.productId, tlc: "  =Supplier-🍎  ", source: null });
    await client.changeLotSource(lot.id, {
      source: null,
      reason: "  Withdraw incorrect source  ",
      expectedRevision: 1,
    });
    await client.changeLotStatus(lot.id, {
      status: "recalled",
      reason: "QA review",
      expectedRevision: 1,
    });
    expect(send.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${path}/${lot.id}`, "GET"],
      [path, "POST"],
      [`${path}/${lot.id}/source`, "PATCH"],
      [`${path}/${lot.id}/status`, "POST"],
    ]);
    expect(JSON.parse(String(send.mock.calls[1]?.[1]?.body))).toEqual({
      productId: lot.productId,
      tlc: "=Supplier-🍎",
      source: null,
      assignmentBasis: "imported",
    });
    expect(JSON.parse(String(send.mock.calls[2]?.[1]?.body))).toEqual({
      source: null,
      reason: "Withdraw incorrect source",
      expectedRevision: 1,
    });
    expect(send.mock.lastCall?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });
  it("serializes bounded filters without treating product names as TLC search", async () => {
    const send = transport({ items: [lot], limit: 50, offset: 50 });
    await createUsBrowserClient(send).listLots({
      search: "A&B",
      productId: lot.productId,
      status: "active",
      offset: 50,
    });
    const url = new URL(String(send.mock.lastCall?.[0]), "http://localhost");
    expect(url.pathname).toBe(path);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: "A&B",
      productId: lot.productId,
      status: "active",
      limit: "50",
      offset: "50",
    });
  });
  it("rejects forged input and mismatched response identity", async () => {
    const send = transport(lot);
    const client = createUsBrowserClient(send);
    await expect(client.getLot("../profile")).rejects.toMatchObject({ code: "invalid_input" });
    for (const extra of [
      { tlc: "NEW" },
      { productId: lot.productId },
      { sourceLockedAt: null },
      { tenantId: "foreign" },
      { expectedRevision: undefined },
    ]) {
      await expect(
        client.changeLotSource(lot.id, {
          source: null,
          expectedRevision: 1,
          reason: "Correct source",
          ...extra,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(send).not.toHaveBeenCalled();
    await expect(
      createUsBrowserClient(transport({ ...lot, id: lot.productId })).getLot(lot.id),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("retains only validated duplicate identity and never retries or exposes server details", async () => {
    const send = transport({ code: "LOT_DUPLICATE", existingId: lot.id }, 409);
    await expect(
      createUsBrowserClient(send).createLot({
        productId: lot.productId,
        tlc: lot.tlc,
        source: null,
      }),
    ).rejects.toMatchObject({
      code: "lot_duplicate",
      existingId: lot.id,
      message: "lot_duplicate",
    });
    expect(send).toHaveBeenCalledTimes(1);
    for (const existingId of ["../profile", undefined]) {
      await expect(
        createUsBrowserClient(
          transport({ code: "LOT_DUPLICATE", existingId, message: "private" }, 409),
        ).changeLotSource(lot.id, { source: null, expectedRevision: 1, reason: "Correct source" }),
      ).rejects.toMatchObject({ code: "conflict", message: "conflict" });
    }
  });
  it.each(["lot_source_locked", "lot_revision_conflict", "lot_reference_archived"])(
    "returns the safe %s recovery code",
    async (code) => {
      await expect(
        createUsBrowserClient(transport({ code }, 409)).changeLotSource(lot.id, {
          source: null,
          expectedRevision: 1,
          reason: "Correct source",
        }),
      ).rejects.toMatchObject({ code });
    },
  );
});
