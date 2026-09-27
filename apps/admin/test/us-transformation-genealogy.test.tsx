import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { finalizedRecord, renderTransformation } from "./support/us-transformation-ui-fixture.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["cycle", "limit", "origin_gap"] as const)(
  "retains %s diagnostic and incomplete server counts in the text graph",
  async (code) => {
    const record = finalizedRecord();
    const outputLotId = record.snapshot.outputs[0]!.lotId;
    const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
      if (url.includes("/revisions?"))
        return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
      if (url.endsWith("/genealogy/query"))
        return Response.json({
          startLotId: outputLotId,
          direction: "upstream",
          mode: "current",
          selectedRevisionIds: [],
          lots: [{ id: outputLotId, currentOrigin: code !== "origin_gap" }],
          events: [],
          links: [],
          complete: false,
          diagnostics: [{ code, lotId: outputLotId }],
          balance: { state: "unknown", values: [] },
        });
      return Response.json({}, { status: 503 });
    });
    await renderTransformation({ send });
    await screen.findByText("Incomplete");
    const panel = screen.getByRole("region", { name: "Genealogy evidence" });
    expect(within(panel).getByText("Incomplete")).toBeTruthy();
    expect(within(panel).getByText("1 lot · 0 events · 0 links")).toBeTruthy();
    expect(
      within(panel).getByText(
        new RegExp(
          `^${code === "origin_gap" ? "Origin gap" : code === "cycle" ? "Cycle" : "Limit reached"}`,
        ),
      ),
    ).toBeTruthy();
    expect(within(panel).getByRole("list", { name: "Genealogy lots" })).toBeTruthy();
  },
);

it("queries a pinned revision and leaves mixed-unit balance not comparable", async () => {
  const record = finalizedRecord();
  const outputLotId = record.snapshot.outputs[0]!.lotId;
  const inputLotId = record.snapshot.inputs[0]!.lotId;
  const mixedSnapshot = {
    ...record.snapshot,
    outputs: [{ ...record.snapshot.outputs[0]!, quantity: "100", unitOfMeasure: "case" }],
  };
  const requests: unknown[] = [];
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (url.endsWith("/genealogy/query")) {
      const request: unknown = JSON.parse(String(init?.body));
      requests.push(request);
      const { mode, direction } = request as { mode: string; direction: string };
      return Response.json({
        startLotId: outputLotId,
        direction,
        mode,
        selectedRevisionIds: [record.id],
        lots: [
          { id: inputLotId, currentOrigin: false },
          { id: outputLotId, currentOrigin: true },
        ].sort((left, right) => left.id.localeCompare(right.id)),
        events: [
          {
            id: record.id,
            rootId: record.id,
            revision: 1,
            status: "finalized",
            snapshot: mixedSnapshot,
          },
        ],
        links: [{ eventId: record.id, inputLotId, outputLotId }],
        complete: true,
        diagnostics: [],
        balance: {
          state: "unknown",
          values: [
            { side: "input", quantity: "2", unitOfMeasure: "kg" },
            { side: "output", quantity: "100", unitOfMeasure: "case" },
          ],
        },
      });
    }
    return Response.json({}, { status: 503 });
  });
  const { user } = await renderTransformation({ send });
  await screen.findByText("Not comparable");
  expect(
    screen.getByRole("button", { name: "Current revisions" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: "Pinned revision" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(screen.getByRole("button", { name: "Show upstream" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "Show downstream" }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  await user.click(screen.getByRole("button", { name: "Pinned revision" }));
  expect(await screen.findByText("Pinned revision evidence")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pinned revision" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(requests).toContainEqual({
    startLotId: outputLotId,
    direction: "upstream",
    maxDepth: 4,
    maxNodes: 100,
    mode: "pinned",
    pinnedRevisionIds: [record.id],
  });
  expect(screen.getByText("Not comparable")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Show downstream" }));
  expect(screen.getByRole("button", { name: "Show downstream" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(requests).toContainEqual({
    startLotId: outputLotId,
    direction: "downstream",
    maxDepth: 4,
    maxNodes: 100,
    mode: "pinned",
    pinnedRevisionIds: [record.id],
  });
  expect(screen.queryByText(/yield/i)).toBeNull();
});

it("shows a server-selected current upstream genealogy with an accessible evidence list", async () => {
  const record = finalizedRecord();
  const outputLotId = record.snapshot.outputs[0]!.lotId;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (url.includes(`/lots/${outputLotId}/cases?`))
      return Response.json({
        lotId: outputLotId,
        originState: "current",
        activeCount: 0,
        rows: [],
        nextCursor: null,
      });
    if (url.endsWith("/genealogy/query"))
      return Response.json({
        startLotId: outputLotId,
        direction: "upstream",
        mode: "current",
        selectedRevisionIds: [record.id],
        lots: [
          { id: record.snapshot.inputs[0]!.lotId, currentOrigin: false },
          { id: outputLotId, currentOrigin: true },
        ].sort((left, right) => left.id.localeCompare(right.id)),
        events: [
          {
            id: record.id,
            rootId: record.id,
            revision: 1,
            status: "finalized",
            snapshot: record.snapshot,
          },
        ],
        links: [{ eventId: record.id, inputLotId: record.snapshot.inputs[0]!.lotId, outputLotId }],
        complete: true,
        diagnostics: [],
        balance: {
          state: "arithmetic",
          unitOfMeasure: "kg",
          inputQuantity: "2.5",
          outputQuantity: "2.5",
          deltaQuantity: "0",
        },
      });
    return Response.json({}, { status: 503 });
  });
  await renderTransformation({ send });

  expect(await screen.findByText("Complete")).toBeTruthy();
  expect(
    within(screen.getByRole("list", { name: "Genealogy events" })).getByText(new RegExp(record.id)),
  ).toBeTruthy();
  expect(screen.getByText("Complete")).toBeTruthy();
});
