import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import {
  transformationHttpRecordSchema,
  transformationRevisionListSchema,
} from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { TransformationRevisionHistory } from "../src/us/transformation/revision-history.js";
import {
  finalizedRecord,
  completeDraft,
  renderTransformation,
  revisionDraftRecord,
  revisionId,
  stamp,
  transformationId,
} from "./support/us-transformation-ui-fixture.js";

afterEach(cleanup);

const page = transformationRevisionListSchema.parse({
  limit: 1,
  offset: 0,
  lifecycleVersion: 4,
  items: [
    {
      id: transformationId,
      rootId: transformationId,
      eventNumber: "TRN-26-0001",
      revision: 1,
      status: "amended",
      timeZone: "America/Chicago",
      lifecycleVersion: 4,
      currentEventId: revisionId,
      pendingDraftId: null,
      previousRevisionId: null,
      amendmentReason: null,
      voidReason: null,
    },
  ],
});

function pendingChain() {
  const base = finalizedRecord();
  const current = transformationHttpRecordSchema.parse({
    ...base,
    lifecycle: {
      ...base.lifecycle,
      lifecycleVersion: 3,
      pendingDraftId: revisionId,
    },
  });
  const pending = transformationHttpRecordSchema.parse({
    ...revisionDraftRecord(),
    draft: { ...completeDraft, notes: "Saved amendment note" },
  });
  const list = transformationRevisionListSchema.parse({
    limit: 50,
    offset: 0,
    lifecycleVersion: 3,
    items: [
      {
        id: transformationId,
        rootId: transformationId,
        eventNumber: "TRN-26-0001",
        revision: 1,
        status: "finalized",
        timeZone: "America/Chicago",
        lifecycleVersion: 3,
        currentEventId: transformationId,
        pendingDraftId: revisionId,
        previousRevisionId: null,
        amendmentReason: null,
        voidReason: null,
      },
      {
        id: revisionId,
        rootId: transformationId,
        eventNumber: "TRN-26-0001",
        revision: 2,
        status: "draft",
        timeZone: "America/Chicago",
        lifecycleVersion: 3,
        currentEventId: transformationId,
        pendingDraftId: revisionId,
        previousRevisionId: transformationId,
        amendmentReason: "Correct quantity",
        voidReason: null,
      },
    ],
  });
  return { current, pending, list };
}

it("hydrates the exact saved amendment draft when history moves from finalized to pending", async () => {
  const { current, pending, list } = pendingChain();
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${transformationId}`)
      return Response.json(current);
    if (url === `/api/us/traceability/transformation/${revisionId}`) return Response.json(pending);
    if (url.includes("/revisions?")) return Response.json(list);
    return Response.json({}, { status: 503 });
  });
  const { user, onDirtyChange } = await renderTransformation({
    eventId: transformationId,
    send,
    canManageQa: true,
  });
  await user.click(await screen.findByRole("button", { name: "Revision 2" }));
  const notes = await screen.findByLabelText("Notes");
  expect(notes).toHaveProperty("value", "Saved amendment note");
  expect(screen.getByLabelText("Completion date")).toHaveProperty("value", "2026-09-27");
  expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty("disabled", true);
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
});

it("does not replace edited draft when an earlier revision GET resolves late", async () => {
  const { current, pending, list } = pendingChain();
  const deferred: { release: (value: Response) => void } = {
    release: () => {
      throw new Error("Deferred response was not initialized");
    },
  };
  const late = new Promise<Response>((resolve) => {
    deferred.release = resolve;
  });
  let originalReads = 0;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${revisionId}`) return Response.json(pending);
    if (url === `/api/us/traceability/transformation/${transformationId}`)
      return originalReads++ === 0 ? Response.json(current) : late;
    if (url.includes("/revisions?")) return Response.json(list);
    return Response.json({}, { status: 503 });
  });
  const { user, onDirtyChange } = await renderTransformation({
    eventId: revisionId,
    send,
    canManageQa: true,
  });
  await waitFor(() => expect(originalReads).toBe(1));
  await user.click(await screen.findByRole("button", { name: "Revision 1" }));
  await waitFor(() => expect(originalReads).toBe(2));
  await user.clear(screen.getByLabelText("Notes"));
  await user.type(screen.getByLabelText("Notes"), "Locally corrected note");
  deferred.release(Response.json(current));
  await waitFor(() =>
    expect(screen.getByLabelText("Notes")).toHaveProperty("value", "Locally corrected note"),
  );
  expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty("disabled", false);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
});

it("does not replace an accepted QA void when an earlier revision GET resolves late", async () => {
  const original = finalizedRecord();
  const current = transformationHttpRecordSchema.parse({
    ...original,
    id: revisionId,
    revision: 2,
    snapshot: {
      ...original.snapshot,
      eventId: revisionId,
      revision: 2,
      previousRevisionId: transformationId,
    },
    lifecycle: {
      ...original.lifecycle,
      lifecycleVersion: 4,
      currentEventId: revisionId,
      previousRevisionId: transformationId,
      amendmentReason: "Correct quantity",
    },
  });
  const voided = transformationHttpRecordSchema.parse({
    ...current,
    status: "void",
    lifecycle: {
      ...current.lifecycle,
      lifecycleVersion: 5,
      currentEventId: null,
      voidedAt: stamp,
      voidedBy: "qa",
      voidReason: "QA void after review",
    },
  });
  const old = transformationHttpRecordSchema.parse({
    ...original,
    status: "amended",
    lifecycle: {
      ...original.lifecycle,
      lifecycleVersion: 5,
      currentEventId: null,
      supersededByEventId: revisionId,
      supersededAt: stamp,
      supersededBy: "qa",
    },
  });
  const list = transformationRevisionListSchema.parse({
    limit: 50,
    offset: 0,
    lifecycleVersion: 4,
    items: [
      { ...page.items[0], currentEventId: revisionId },
      {
        id: revisionId,
        rootId: transformationId,
        eventNumber: "TRN-26-0001",
        revision: 2,
        status: "finalized",
        timeZone: "America/Chicago",
        lifecycleVersion: 4,
        currentEventId: revisionId,
        pendingDraftId: null,
        previousRevisionId: transformationId,
        amendmentReason: "Correct quantity",
        voidReason: null,
      },
    ],
  });
  const deferred: { release: (value: Response) => void } = {
    release: () => {
      throw new Error("Deferred response was not initialized");
    },
  };
  const late = new Promise<Response>((resolve) => {
    deferred.release = resolve;
  });
  let reads = 0;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (
      url === `/api/us/traceability/transformation/${revisionId}` &&
      (!init || init.method === "GET")
    )
      return Response.json(reads++ === 0 ? current : voided);
    if (url === `/api/us/traceability/transformation/${transformationId}`) return late;
    if (url.includes("/revisions?")) return Response.json(list);
    if (
      url === `/api/us/traceability/transformation/${revisionId}/void` &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as { operationKey: string };
      return Response.json({
        receiptVersion: 1,
        command: "transformation.void",
        operationKey: body.operationKey,
        inputDigest: "a".repeat(64),
        eventId: revisionId,
        record: voided,
      });
    }
    return Response.json({}, { status: 503 });
  });
  const { user } = await renderTransformation({ eventId: revisionId, send, canManageQa: true });
  await user.click(await screen.findByRole("button", { name: "Revision 1" }));
  await user.click(screen.getByRole("button", { name: "Void transformation" }));
  await user.type(screen.getByLabelText("QA reason"), "QA void after review");
  await user.click(screen.getByRole("button", { name: "Confirm" }));
  expect(await screen.findByText("QA void after review")).toBeTruthy();
  await act(async () => {
    deferred.release(Response.json(old));
  });
  expect(screen.getByText("Void · revision 2")).toBeTruthy();
  expect(screen.queryByText("Amended · revision 1")).toBeNull();
});

it("labels selected and current revisions separately and pages within the server bound", async () => {
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: "en-US",
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const onPage = vi.fn();
  const onOpenRevision = vi.fn();
  const user = userEvent.setup();
  render(
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={instance}>
        <TransformationRevisionHistory
          list={page}
          selectedEventId={transformationId}
          onPage={onPage}
          onOpenRevision={onOpenRevision}
          pending={false}
          failure={false}
          onRetry={vi.fn()}
        />
      </I18nextProvider>
    </ThemeProvider>,
  );
  expect(screen.getByText("Selected")).toBeTruthy();
  expect(screen.queryByText("Current revision")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Next page" }));
  expect(onPage).toHaveBeenCalledWith(1);
});

it("keeps the displayed revision on failed history read, then opens frozen predecessor without edit actions", async () => {
  const original = finalizedRecord();
  const amended = transformationHttpRecordSchema.parse({
    ...original,
    status: "amended",
    lifecycle: {
      ...original.lifecycle,
      lifecycleVersion: 4,
      currentEventId: revisionId,
      supersededByEventId: revisionId,
      supersededAt: stamp,
      supersededBy: "qa",
    },
  });
  const current = transformationHttpRecordSchema.parse({
    ...original,
    id: revisionId,
    revision: 2,
    snapshot: {
      ...original.snapshot,
      eventId: revisionId,
      revision: 2,
      previousRevisionId: transformationId,
      inputs: original.snapshot.inputs.map((row) => ({ ...row, quantity: "3.000" })),
      outputs: original.snapshot.outputs.map((row) => ({ ...row, quantity: "3.000" })),
    },
    lifecycle: {
      ...original.lifecycle,
      lifecycleVersion: 4,
      currentEventId: revisionId,
      previousRevisionId: transformationId,
      amendmentReason: "Correct quantity",
    },
  });
  const list = transformationRevisionListSchema.parse({
    limit: 50,
    offset: 0,
    lifecycleVersion: 4,
    items: [
      { ...page.items[0], lifecycleVersion: 4, currentEventId: revisionId },
      {
        id: revisionId,
        rootId: transformationId,
        eventNumber: "TRN-26-0001",
        revision: 2,
        status: "finalized",
        timeZone: "America/Chicago",
        lifecycleVersion: 4,
        currentEventId: revisionId,
        pendingDraftId: null,
        previousRevisionId: transformationId,
        amendmentReason: "Correct quantity",
        voidReason: null,
      },
    ],
  });
  let failPredecessor = true;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${revisionId}`) return Response.json(current);
    if (url === `/api/us/traceability/transformation/${transformationId}`) {
      if (failPredecessor) {
        failPredecessor = false;
        return Response.json({}, { status: 503 });
      }
      return Response.json(amended);
    }
    if (url.includes("/revisions?")) return Response.json(list);
    return Response.json({}, { status: 503 });
  });
  const { user } = await renderTransformation({ eventId: revisionId, send, canManageQa: true });
  await waitFor(() => expect(screen.getAllByText("3.000 kg")).toHaveLength(2));
  expect(screen.getAllByText("Correct quantity").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: transformationId })).toBeTruthy();
  expect(screen.getByText(original.snapshot.outputs[0]!.lotId)).toBeTruthy();
  await user.click(await screen.findByRole("button", { name: "Revision 1" }));
  expect(
    await screen.findByText(
      "That revision could not be opened. The displayed record is unchanged.",
    ),
  ).toBeTruthy();
  expect(screen.getAllByText("3.000 kg").length).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "Revision 1" }));
  await waitFor(() => expect(screen.getByText("Amended · revision 1")).toBeTruthy());
  expect(screen.getAllByText("2.5 kg").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Start amendment" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
});
