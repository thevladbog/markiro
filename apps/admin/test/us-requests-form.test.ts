import { afterEach, describe, expect, it, vi } from "vitest";
import {
  usTraceRequestScopeV1Schema,
  type UsTraceRequestScopeV1,
} from "@markiro/platform-contracts";
import { parseRequestTiming, type RequestTimingFields } from "../src/us/requests/form.js";
import { parseRequestScope, requestScopeKeys, scopeToFields } from "../src/us/requests/scope.js";
import { deferred, requestDetail, requestRun, requestSummary } from "./us-requests-fixtures.js";

const id = "a0000000-0000-4000-8000-000000000001";
const timing = (overrides: Partial<RequestTimingFields> = {}): RequestTimingFields => ({
  requestNumber: "REQ-1",
  requesterName: "Requester",
  requesterOrganization: "",
  requesterContact: "",
  receivedWall: "2026-03-08T00:30:00.123",
  receivedOffsetSeconds: null,
  duePolicy: "default",
  dueWall: "",
  dueOffsetSeconds: null,
  alternateDeadlineReason: "",
  ...overrides,
});
const parse = (overrides: Partial<RequestTimingFields> = {}) =>
  parseRequestTiming(timing(overrides), "America/Los_Angeles");

describe("pure timing form policy", () => {
  it("serializes receipt in the tenant zone and an exact elapsed default", () => {
    expect(parse()).toEqual({
      ok: true,
      body: {
        requestNumber: "REQ-1",
        requesterName: "Requester",
        requesterOrganization: null,
        requesterContact: null,
        receivedAt: "2026-03-08T08:30:00.123Z",
        dueAt: "2026-03-09T08:30:00.123Z",
        alternateDeadlineReason: null,
      },
    });
  });
  it("recomputes only default policy, retaining an explicitly edited alternative", () => {
    const alternative = {
      duePolicy: "alternative" as const,
      dueWall: "2026-03-10T01:30:00.123",
      alternateDeadlineReason: "Agreed extension",
    };
    const first = parse(alternative);
    const changed = parse({ ...alternative, receivedWall: "2026-03-09T00:30:00.123" });
    expect(first.ok && first.body.dueAt).toBe("2026-03-10T08:30:00.123Z");
    expect(changed.ok && changed.body.dueAt).toBe("2026-03-10T08:30:00.123Z");
    const defaultChanged = parse({ receivedWall: "2026-03-09T00:30:00.123" });
    expect(defaultChanged.ok && defaultChanged.body.dueAt).toBe("2026-03-10T07:30:00.123Z");
  });
  it("does not mutate an invalid alternative policy", () => {
    const fields = timing({ duePolicy: "alternative", dueWall: "bad" });
    const before = { ...fields };
    expect(parseRequestTiming(fields, "America/Los_Angeles").ok).toBe(false);
    expect(fields).toEqual(before);
  });
  it("rejects a receipt without room for its elapsed default but permits a due at the instant maximum", () => {
    const fields = timing({ receivedWall: "9999-12-31T00:00:00.000" });
    expect(parseRequestTiming(fields, "UTC")).toEqual({
      ok: false,
      fields: { receivedWall: "invalid" },
    });
    const result = parseRequestTiming(
      timing({
        receivedWall: "9999-12-30T00:00:00.000",
        duePolicy: "alternative",
        dueWall: "9999-12-31T23:59:59.999",
        alternateDeadlineReason: "Agreed extension",
      }),
      "UTC",
    );
    expect(result.ok && result.body.dueAt).toBe("9999-12-31T23:59:59.999Z");
  });
  it.each([null, -18_000])(
    "requires a valid explicit fold offset, got %s",
    (receivedOffsetSeconds) => {
      expect(parse({ receivedWall: "2026-11-01T01:30:00.123", receivedOffsetSeconds }).ok).toBe(
        false,
      );
    },
  );
  it.each([
    [-25_200, "2026-11-01T08:30:00.123Z"],
    [-28_800, "2026-11-01T09:30:00.123Z"],
  ])("selects receipt fold offset %i", (receivedOffsetSeconds, instant) => {
    const result = parse({ receivedWall: "2026-11-01T01:30:00.123", receivedOffsetSeconds });
    expect(result.ok && result.body.receivedAt).toBe(instant);
  });
  it("requires explicit selection for an alternative deadline fold too", () => {
    const fields = {
      duePolicy: "alternative" as const,
      dueWall: "2026-11-01T01:30:00.123",
      alternateDeadlineReason: "Agreed extension",
    };
    expect(parse(fields).ok).toBe(false);
    const selected = parse({ ...fields, dueOffsetSeconds: -28_800 });
    expect(selected.ok && selected.body.dueAt).toBe("2026-11-01T09:30:00.123Z");
  });
  it.each(["receivedWall", "dueWall"] as const)("rejects a DST gap in %s", (field) => {
    const result = parse({
      duePolicy: "alternative",
      dueWall: "2026-03-09T01:30:00.123",
      alternateDeadlineReason: "Agreed extension",
      [field]: "2026-03-08T02:30:00.000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fields[field]).toBe("gap");
  });
  it.each(["2026-03-08T00:29:59.123", "2026-03-08T00:30:00.123"])(
    "rejects due at/before receipt %s",
    (dueWall) => {
      const result = parse({
        duePolicy: "alternative",
        dueWall,
        alternateDeadlineReason: "Agreed extension",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fields.dueWall).toBe("deadlineOrder");
    },
  );
  it.each([
    [2, false],
    [3, true],
    [2000, true],
    [2001, false],
  ] as const)("bounds reason length %i", (length, ok) => {
    expect(
      parse({
        duePolicy: "alternative",
        dueWall: "2026-03-10T00:30:00.123",
        alternateDeadlineReason: "x".repeat(length),
      }).ok,
    ).toBe(ok);
  });
  it("allows an explicit alternative equal to default without a reason", () => {
    const result = parse({ duePolicy: "alternative", dueWall: "2026-03-09T01:30:00.123" });
    expect(result.ok && result.body.alternateDeadlineReason).toBe(null);
  });
  it.each([
    "requestNumber",
    "requesterName",
    "requesterOrganization",
    "requesterContact",
    "alternateDeadlineReason",
  ] as const)("rejects whitespace in %s without silently trimming", (field) => {
    expect(parse({ [field]: " " }).ok).toBe(false);
    expect(parse({ [field]: " padded " }).ok).toBe(false);
  });
});

describe("all scope selectors", () => {
  afterEach(() => vi.unstubAllGlobals());
  const full: UsTraceRequestScopeV1 = {
    productId: id,
    productText: "日本の製品",
    tlc: "0001-日本",
    tlcs: ["0001-日本", "0002-Ó"],
    tlcFrom: "0000",
    tlcTo: "0099",
    lotId: id,
    locationIds: [id],
    sourceReferenceValue: "https://example.test/source",
    documentNumber: "文書-001",
    eventDateFrom: "2024-02-29",
    eventDateTo: "2026-10-05",
  };
  it("round-trips all twelve selectors preserving identifiers and AND combinations", () => {
    const fields = scopeToFields(full);
    expect(Object.keys(fields)).toHaveLength(12);
    expect(new Set(requestScopeKeys)).toEqual(
      new Set(Object.keys(usTraceRequestScopeV1Schema.shape)),
    );
    expect(fields.tlcs).toBe("0001-日本\n0002-Ó");
    expect(parseRequestScope(fields)).toEqual({ success: true, data: full });
  });
  it("initializes every empty control and requires at least one selector", () => {
    const fields = scopeToFields(null);
    expect(Object.values(fields)).toEqual(Array<string>(12).fill(""));
    expect(parseRequestScope(fields).success).toBe(false);
  });
  it.each(["tlcs", "locationIds"] as const)(
    "retains the 50-value limit and duplicate detection for %s",
    (field) => {
      const values = Array.from({ length: 51 }, (_, index) =>
        field === "tlcs"
          ? `000${index}`
          : `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      const fields = scopeToFields(null);
      fields[field] = values.slice(0, 50).join("\n");
      expect(parseRequestScope(fields).success).toBe(true);
      fields[field] = values.join("\n");
      expect(parseRequestScope(fields).success).toBe(false);
      fields[field] = `${values[0]}\n${values[0]}`;
      const duplicate = parseRequestScope(fields);
      expect(duplicate.success).toBe(false);
      if (!duplicate.success) expect(duplicate.error.issues[0]?.path).toEqual([field]);
    },
  );
  it.each([
    { tlcFrom: "Z", tlcTo: "A" },
    { eventDateFrom: "2026-10-06", eventDateTo: "2026-10-05" },
    { eventDateFrom: "2026-02-29" },
    { tlc: " padded " },
    { tlcs: "0001\n\n0002" },
    { productText: " " },
  ])("rejects invalid scope %j", (values) => {
    expect(parseRequestScope({ ...scopeToFields(null), ...values }).success).toBe(false);
  });
  it("rejects invalid source URLs without fetching even valid source URLs", () => {
    const fetcher = vi.fn(() => {
      throw new Error("No fetch permitted");
    });
    vi.stubGlobal("fetch", fetcher);
    expect(
      parseRequestScope({ ...scopeToFields(null), sourceReferenceValue: "javascript:alert(1)" })
        .success,
    ).toBe(false);
    expect(parseRequestScope(scopeToFields(full)).success).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("schema-checked test fixtures", () => {
  it("builds independent real summary/detail/frozen run shapes", () => {
    expect(requestSummary().status).toBe("open");
    expect(requestDetail().requesterOrganization).toBe(null);
    expect(requestRun().request.id).toBe(requestRun().requestId);
    expect(requestRun().runId).toBe("b0000000-0000-4000-8000-000000000002");
    expect(() => requestSummary({ status: "closed", closedAt: null })).toThrow();
    expect(() => requestDetail({ scope: {} })).toThrow();
    expect(() => requestRun({ requestId: "c0000000-0000-4000-8000-000000000003" })).toThrow();
  });
  it("supports explicit deferred resolution and rejection", async () => {
    const resolved = deferred<number>();
    resolved.resolve(42);
    await expect(resolved.promise).resolves.toBe(42);
    const rejected = deferred<number>();
    rejected.reject(new Error("synthetic failure"));
    await expect(rejected.promise).rejects.toThrow("synthetic failure");
  });
});
