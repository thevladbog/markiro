import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  finalizedRecord,
  renderTransformation,
  stamp,
} from "./support/us-transformation-ui-fixture.js";

const linkId = "b0000000-0000-4000-8000-000000000009";
const boxId = "b0000000-0000-4000-8000-000000000010";
const sscc = "000000000000000000";
const row = (lotId: string, originState: "current" | "gap" = "current") => ({
  linkId,
  boxId,
  lotId,
  ssccAtLink: sscc,
  linkSource: "manual" as const,
  provenance: "synthetic_demo" as const,
  linkedAt: stamp,
  linkedBy: "operator-1",
  unlinkedAt: null,
  unlinkedBy: null,
  unlinkReason: null,
  originState,
  ssccState: "consistent" as const,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("refreshes Cases and current genealogy after void in the same mounted editor", async () => {
  const record = finalizedRecord();
  const lotId = record.snapshot.outputs[0]!.lotId;
  const voided = {
    ...record,
    status: "void",
    lifecycle: {
      ...record.lifecycle,
      lifecycleVersion: 3,
      currentEventId: null,
      voidedAt: stamp,
      voidedBy: "qa",
      voidReason: "Incorrect record",
    },
  };
  let accepted = false;
  let resolveCases: ((value: Response) => void) | undefined;
  let resolveGraph: ((value: Response) => void) | undefined;
  const cases = (gap: boolean) => ({
    lotId,
    originState: gap ? "gap" : "current",
    activeCount: 1,
    rows: [row(lotId, gap ? "gap" : "current")],
    nextCursor: null,
  });
  const graph = (gap: boolean) => ({
    startLotId: lotId,
    direction: "upstream",
    mode: "current",
    selectedRevisionIds: [],
    lots: [{ id: lotId, currentOrigin: !gap }],
    events: [],
    links: [],
    complete: !gap,
    diagnostics: gap ? [{ code: "origin_gap", lotId }] : [],
    balance: { state: "unknown", values: [] },
  });
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`)
      return Response.json(accepted ? voided : record);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: accepted ? 3 : 2 });
    if (url.includes("/cases?"))
      return accepted
        ? new Promise<Response>((resolve) => {
            resolveCases = resolve;
          })
        : Response.json(cases(false));
    if (url.endsWith("/genealogy/query"))
      return accepted
        ? new Promise<Response>((resolve) => {
            resolveGraph = resolve;
          })
        : Response.json(graph(false));
    if (url.endsWith("/void")) {
      accepted = true;
      const body = JSON.parse(String(init?.body)) as { operationKey: string };
      return Response.json({
        receiptVersion: 1,
        command: "transformation.void",
        operationKey: body.operationKey,
        inputDigest: "a".repeat(64),
        eventId: record.id,
        record: voided,
      });
    }
    return Response.json({}, { status: 503 });
  });
  const { user } = await renderTransformation({ send, canManageQa: true });
  await screen.findByText("1 linked case");
  await screen.findByText("Complete");
  await user.click(screen.getByRole("button", { name: "Void transformation" }));
  await user.type(screen.getByLabelText("QA reason"), "Incorrect record");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Revision 1 · Void");
  await waitFor(() => {
    expect(resolveCases).toBeTypeOf("function");
    expect(resolveGraph).toBeTypeOf("function");
  });
  expect(screen.queryByRole("button", { name: "Link cases" })).toBeNull();
  expect(
    within(screen.getByRole("region", { name: "Genealogy evidence" })).queryByText("Complete"),
  ).toBeNull();
  await act(async () => {
    resolveCases?.(Response.json(cases(true)));
    resolveGraph?.(Response.json(graph(true)));
  });
  const panel = screen.getByRole("region", { name: "Cases" });
  expect(await within(panel).findByText("No current Transformation origin")).toBeTruthy();
  expect(within(panel).getByText(sscc)).toBeTruthy();
  expect(within(panel).getByRole("button", { name: `Unlink ${sscc}` })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Link cases" })).toBeNull();
  expect(await screen.findByText(`Origin gap · ${lotId}`)).toBeTruthy();
});

it.each(["Start amendment", "Void transformation"])(
  "blocks %s while Cases has unsent input or an uncertain exact command",
  async (action) => {
    const record = finalizedRecord();
    const lotId = record.snapshot.outputs[0]!.lotId;
    const payloads: string[] = [];
    const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
      if (url.includes("/revisions?"))
        return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
      if (url.includes("/cases?"))
        return Response.json({
          lotId,
          originState: "current",
          activeCount: 0,
          rows: [],
          nextCursor: null,
        });
      if (url.endsWith("/cases") && init?.method === "POST") {
        payloads.push(String(init.body));
        if (payloads.length === 1) throw new TypeError("lost response");
        return Response.json({ lotId, created: [], unchanged: [] });
      }
      return Response.json({}, { status: 503 });
    });
    const { user } = await renderTransformation({ send, canManageQa: true });
    await user.type(await screen.findByRole("textbox", { name: "Case SSCC" }), sscc);
    expect(screen.getByRole("button", { name: action })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: action }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Case SSCC" })).toHaveProperty("value", sscc);
    await user.click(screen.getByRole("button", { name: "Link cases" }));
    await screen.findByText(/Case command outcome is unknown/);
    expect(screen.getByRole("button", { name: action })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: action }));
    await user.click(screen.getByRole("button", { name: "Retry same operation" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: action })).toHaveProperty("disabled", false),
    );
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(send.mock.calls.some(([url]) => /\/(amend|void)$/.test(String(url)))).toBe(false);
  },
);

it("links an eligible SSCC and shows provenance, actor, time, and bounded history", async () => {
  const record = finalizedRecord();
  const outputLotId = record.snapshot.outputs[0]!.lotId;
  let linked = false;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (url.includes(`/lots/${outputLotId}/cases?`))
      return Response.json({
        lotId: outputLotId,
        originState: "current",
        activeCount: linked ? 1 : 0,
        rows: linked ? [row(outputLotId)] : [],
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
    if (url.endsWith(`/lots/${outputLotId}/cases`) && init?.method === "POST") {
      linked = true;
      return Response.json({ lotId: outputLotId, created: [row(outputLotId)], unchanged: [] });
    }
    return Response.json({}, { status: 503 });
  });
  const { user } = await renderTransformation({ send, canTransform: true });
  await screen.findByText("0 linked cases");
  await user.type(screen.getByRole("textbox", { name: "Case SSCC" }), sscc);
  await user.click(screen.getByRole("button", { name: "Link cases" }));
  expect(await screen.findByText("1 linked case")).toBeTruthy();
  const panel = screen.getByRole("region", { name: "Cases" });
  expect(within(panel).getByText(sscc)).toBeTruthy();
  expect(within(panel).getByText("Synthetic demo")).toBeTruthy();
  expect(within(panel).getByText("Manual link")).toBeTruthy();
  expect(within(panel).getByText(/operator-1/)).toBeTruthy();
  expect(
    within(screen.getByRole("list", { name: "Server-selected revision IDs" })).getByText(record.id),
  ).toBeTruthy();
  expect(screen.getAllByText("2.5 kg")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Show case history" }));
  expect(send.mock.calls.some(([url]) => String(url).includes("history=true"))).toBe(true);
});

it("keeps void-origin rows visible, blocks new links, and permits reasoned exact-link unlink", async () => {
  const finalized = finalizedRecord();
  const outputLotId = finalized.snapshot.outputs[0]!.lotId;
  const record = {
    ...finalized,
    status: "void",
    lifecycle: {
      ...finalized.lifecycle,
      currentEventId: null,
      lifecycleVersion: 3,
      voidedAt: stamp,
      voidedBy: "qa",
      voidReason: "Correction",
    },
  };
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 3 });
    if (url.includes(`/lots/${outputLotId}/cases?`))
      return Response.json({
        lotId: outputLotId,
        originState: "gap",
        activeCount: 1,
        rows: [row(outputLotId, "gap")],
        nextCursor: null,
      });
    if (url.endsWith(`/${linkId}/unlink`) && init?.method === "POST")
      return Response.json({
        linkId,
        lotId: outputLotId,
        unlinkedAt: stamp,
        unlinkedBy: "operator-1",
        reason: "Wrong link",
      });
    return Response.json({}, { status: 503 });
  });
  const { user } = await renderTransformation({ send, canTransform: true });
  expect(await screen.findByText("No current Transformation origin")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Link cases" })).toBeNull();
  expect(screen.getByText(sscc)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: `Unlink ${sscc}` }));
  await user.type(screen.getByRole("textbox", { name: "Unlink reason" }), "Wrong link");
  await user.click(screen.getByRole("button", { name: "Confirm unlink" }));
  await waitFor(() =>
    expect(
      send.mock.calls.some(
        ([url, init]) => String(url).endsWith(`/${linkId}/unlink`) && init?.method === "POST",
      ),
    ).toBe(true),
  );
  const unlink = send.mock.calls.find(([url]) => String(url).endsWith(`/${linkId}/unlink`));
  expect(JSON.parse(String(unlink?.[1]?.body))).toMatchObject({ reason: "Wrong link" });
});

it("retries an uncertain link with the same operation key and reloads confirmed state", async () => {
  const record = finalizedRecord();
  const outputLotId = record.snapshot.outputs[0]!.lotId;
  let attempts = 0;
  const payloads: string[] = [];
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (url.includes(`/lots/${outputLotId}/cases?`))
      return Response.json({
        lotId: outputLotId,
        originState: "current",
        activeCount: attempts > 1 ? 1 : 0,
        rows: attempts > 1 ? [row(outputLotId)] : [],
        nextCursor: null,
      });
    if (url.endsWith(`/lots/${outputLotId}/cases`) && init?.method === "POST") {
      attempts += 1;
      payloads.push(String(init.body));
      if (attempts === 1) throw new TypeError("connection lost");
      return Response.json({ lotId: outputLotId, created: [], unchanged: [row(outputLotId)] });
    }
    return Response.json({}, { status: 503 });
  });
  const { user } = await renderTransformation({ send });
  await screen.findByText("0 linked cases");
  await user.type(screen.getByRole("textbox", { name: "Case SSCC" }), sscc);
  await user.click(screen.getByRole("button", { name: "Link cases" }));
  expect(await screen.findByText(/Case command outcome is unknown/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Retry same operation" }));
  expect(await screen.findByText("1 linked case")).toBeTruthy();
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toBe(payloads[0]);
  expect(screen.getAllByText("2.5 kg").length).toBeGreaterThan(0);
});

it("gives an auditor read-only evidence and preserves rows after a stale unlink conflict", async () => {
  const record = finalizedRecord();
  const outputLotId = record.snapshot.outputs[0]!.lotId;
  let active = true;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (url.includes(`/lots/${outputLotId}/cases?`))
      return Response.json({
        lotId: outputLotId,
        originState: "current",
        activeCount: active ? 1 : 0,
        rows: active ? [row(outputLotId)] : [],
        nextCursor: null,
      });
    if (url.endsWith(`/${linkId}/unlink`) && init?.method === "POST") {
      active = false;
      return Response.json({ code: "case_link_stale" }, { status: 409 });
    }
    return Response.json({}, { status: 503 });
  });
  const { user, rerender, view } = await renderTransformation({ send, canTransform: false });
  await screen.findByText("1 linked case");
  expect(screen.queryByRole("button", { name: "Link cases" })).toBeNull();
  expect(screen.queryByRole("button", { name: `Unlink ${sscc}` })).toBeNull();
  rerender(view(true));
  await user.click(screen.getByRole("button", { name: `Unlink ${sscc}` }));
  await user.type(screen.getByRole("textbox", { name: "Unlink reason" }), "Wrong link");
  await user.click(screen.getByRole("button", { name: "Confirm unlink" }));
  expect(
    await screen.findByText("Case link changed. Reload case links before another action."),
  ).toBeTruthy();
  expect(screen.getByText(sscc)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload cases" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Reload cases" }));
  expect(await screen.findByText("0 linked cases")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Unlink reason" })).toBeNull();
});

it("shows existing-record provenance and read-only Cases in Spanish", async () => {
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
        activeCount: 1,
        rows: [{ ...row(outputLotId), provenance: "existing_record" }],
        nextCursor: null,
      });
    return Response.json({}, { status: 503 });
  });
  await renderTransformation({ send, canTransform: false, locale: "es-US" });
  expect(await screen.findByText("1 caja vinculada")).toBeTruthy();
  expect(screen.getByText("Registro existente")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Vincular cajas" })).toBeNull();
});

it("keeps finalized case quantity separate from zero active case links", async () => {
  const record = finalizedRecord();
  const output = record.snapshot.outputs[0]!;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`)
      return Response.json({
        ...record,
        snapshot: {
          ...record.snapshot,
          outputs: [{ ...output, quantity: "100.000", unitOfMeasure: "case" }],
        },
      });
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (url.includes(`/lots/${output.lotId}/cases?`))
      return Response.json({
        lotId: output.lotId,
        originState: "current",
        activeCount: 0,
        rows: [],
        nextCursor: null,
      });
    return Response.json({}, { status: 503 });
  });
  await renderTransformation({ send, canTransform: true });

  expect(await screen.findByText("100.000 case")).toBeTruthy();
  expect(await screen.findByText("0 linked cases")).toBeTruthy();
  expect(screen.queryByText("100 linked cases")).toBeNull();
});

it("makes an open unlink read-only after role loss and retains an uncertain key until reload", async () => {
  const record = finalizedRecord();
  const lotId = record.snapshot.outputs[0]!.lotId;
  const payloads: string[] = [];
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (url.includes(`/lots/${lotId}/cases?`))
      return Response.json({
        lotId,
        originState: "current",
        activeCount: 1,
        rows: [row(lotId)],
        nextCursor: null,
      });
    if (url.endsWith(`/${linkId}/unlink`) && init?.method === "POST") {
      payloads.push(String(init.body));
      throw new TypeError("connection lost");
    }
    return Response.json({}, { status: 503 });
  });
  const { user, rerender, view } = await renderTransformation({ send, canTransform: true });
  await screen.findByText("1 linked case");
  await user.click(screen.getByRole("button", { name: `Unlink ${sscc}` }));
  await user.type(screen.getByRole("textbox", { name: "Unlink reason" }), "Wrong link");
  rerender(view(false));
  expect(screen.queryByRole("textbox", { name: "Unlink reason" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Confirm unlink" })).toBeNull();
  expect(payloads).toHaveLength(0);

  rerender(view(true));
  await user.click(screen.getByRole("button", { name: `Unlink ${sscc}` }));
  expect(screen.getByRole("textbox", { name: "Unlink reason" })).toHaveProperty("value", "");
  await user.type(screen.getByRole("textbox", { name: "Unlink reason" }), "Wrong link");
  rerender(view(true, false, true));
  expect(screen.queryByRole("button", { name: "Confirm unlink" })).toBeNull();
  expect(payloads).toHaveLength(0);
  rerender(view(true));
  expect(screen.getByRole("textbox", { name: "Unlink reason" })).toHaveProperty(
    "value",
    "Wrong link",
  );
  await user.click(screen.getByRole("button", { name: "Confirm unlink" }));
  expect(await screen.findByText(/Case command outcome is unknown/)).toBeTruthy();
  expect(payloads).toHaveLength(1);
  rerender(view(false));
  expect(screen.getByRole("button", { name: "Retry same operation" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.click(screen.getByRole("button", { name: "Retry same operation" }));
  expect(payloads).toHaveLength(1);
  rerender(view(true));
  await user.click(screen.getByRole("button", { name: "Retry same operation" }));
  await waitFor(() => expect(payloads).toHaveLength(2));
  expect(payloads[1]).toBe(payloads[0]);
});

it("keeps the exact unlink target visible and prevents history navigation until cancel", async () => {
  const record = finalizedRecord();
  const lotId = record.snapshot.outputs[0]!.lotId;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${record.id}`) return Response.json(record);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (url.includes(`/lots/${lotId}/cases?`))
      return Response.json({
        lotId,
        originState: "current",
        activeCount: 1,
        rows: [row(lotId)],
        nextCursor: null,
      });
    return Response.json({}, { status: 503 });
  });
  const { user } = await renderTransformation({ send });
  await screen.findByText("1 linked case");
  await user.click(screen.getByRole("button", { name: `Unlink ${sscc}` }));
  expect(screen.getByText(`Unlink target: ${sscc} · link ${linkId}`)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show case history" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.click(screen.getByRole("button", { name: "Show case history" }));
  expect(send.mock.calls.some(([url]) => String(url).includes("history=true"))).toBe(false);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Show case history" }));
  await waitFor(() =>
    expect(send.mock.calls.some(([url]) => String(url).includes("history=true"))).toBe(true),
  );
});
