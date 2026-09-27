import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { transformationHttpRecordSchema } from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { TransformationDetail } from "../src/us/transformation/detail.js";
import {
  completeDraft,
  draftRecord,
  finalizedRecord,
  renderTransformation,
  revisionId,
  stamp,
} from "./support/us-transformation-ui-fixture.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function show(record: unknown, locale: "en-US" | "es-US" = "en-US") {
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: locale,
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const onOpenRevision = vi.fn();
  const onOpenLot = vi.fn();
  render(
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={instance}>
        <TransformationDetail
          record={transformationHttpRecordSchema.parse(record)}
          onOpenRevision={onOpenRevision}
          onOpenLot={onOpenLot}
        />
      </I18nextProvider>
    </ThemeProvider>,
  );
  return { user: userEvent.setup(), onOpenRevision, onOpenLot };
}

it("renders only frozen finalized business values after master-data drift", async () => {
  const frozen = finalizedRecord();
  const { user, onOpenLot } = await show(frozen);
  expect(screen.getAllByText("Processor").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Fresh-cut fruit").length).toBeGreaterThan(0);
  expect(screen.getAllByText("2.5 kg")).toHaveLength(2);
  expect(screen.getByText("WO-2026-1")).toBeTruthy();
  expect(screen.getByText("America/Chicago")).toBeTruthy();
  expect(screen.queryByText("Renamed live product")).toBeNull();
  expect(screen.queryByText("Renamed live processor")).toBeNull();
  await user.click(screen.getByRole("button", { name: /OUT-2026-001/ }));
  expect(onOpenLot).toHaveBeenCalledWith(frozen.snapshot.outputs[0]!.lotId);
});

it("keeps frozen labels when live product and location cards have conflicting names", async () => {
  const frozen = finalizedRecord();
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${frozen.id}`) return Response.json(frozen);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    if (url.includes("/products"))
      return Response.json({
        items: [
          { id: frozen.snapshot.outputs[0]!.product.id, description: "Renamed live product" },
        ],
        limit: 50,
        offset: 0,
      });
    if (url.includes("/locations"))
      return Response.json({
        items: [{ id: frozen.snapshot.processor.id, description: "Renamed live processor" }],
        limit: 50,
        offset: 0,
      });
    return Response.json({}, { status: 503 });
  });
  await renderTransformation({ send, canManageQa: false });
  expect(await screen.findByText("WO-2026-1")).toBeTruthy();
  expect(screen.getAllByText("Fresh-cut fruit").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Processor").length).toBeGreaterThan(0);
  expect(screen.queryByText("Renamed live product")).toBeNull();
  expect(screen.queryByText("Renamed live processor")).toBeNull();
  expect(
    send.mock.calls.some(([url]) =>
      /\/traceability\/(products|locations)(?:\/|\?)/.test(String(url)),
    ),
  ).toBe(false);
});

it("shows amended predecessor, successor and exact frozen output identity", async () => {
  const frozen = finalizedRecord();
  const amended = {
    ...frozen,
    status: "amended",
    lifecycle: {
      ...frozen.lifecycle,
      lifecycleVersion: 4,
      currentEventId: revisionId,
      supersededByEventId: revisionId,
      supersededAt: stamp,
      supersededBy: "qa",
    },
  };
  const { user, onOpenRevision } = await show(amended);
  expect(screen.getByText("Amended · revision 1")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Superseded by revision/ }));
  expect(onOpenRevision).toHaveBeenCalledWith(revisionId);
  expect(screen.getByText(frozen.snapshot.outputs[0]!.lotId)).toBeTruthy();
});

it("shows void actor, time, reason and exclusion without implying archival", async () => {
  const frozen = finalizedRecord();
  await show({
    ...frozen,
    status: "void",
    lifecycle: {
      ...frozen.lifecycle,
      lifecycleVersion: 3,
      currentEventId: null,
      voidedAt: stamp,
      voidedBy: "qa",
      voidReason: "Incorrect completion record",
    },
  });
  expect(screen.getByText("Incorrect completion record")).toBeTruthy();
  expect(screen.getByText("qa")).toBeTruthy();
  expect(screen.getByText(/Excluded from current origin/)).toBeTruthy();
  expect(screen.queryByText("Automatically archived")).toBeNull();
});

it("shows retained saved draft for an original-draft void without claiming a snapshot", async () => {
  const draft = draftRecord(completeDraft);
  await show(
    {
      ...draft,
      status: "void",
      lifecycle: {
        ...draft.lifecycle,
        lifecycleVersion: 2,
        pendingDraftId: null,
        voidedAt: stamp,
        voidedBy: "qa",
        voidReason: "Canceled before processing",
      },
    },
    "es-US",
  );
  expect(screen.getByText("Canceled before processing")).toBeTruthy();
  expect(screen.getByText("OUT-2026-001")).toBeTruthy();
  expect(screen.getAllByText("2.5 kg")).toHaveLength(2);
  expect(screen.getByText(/No se creó una instantánea final/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /OUT-2026-001/ })).toBeNull();
  expect(
    within(screen.getByRole("region", { name: /Salidas/ })).getByText("OUT-2026-001"),
  ).toBeTruthy();
});

it("protects a typed QA reason and blocks output-lot navigation during a mutation", async () => {
  const frozen = finalizedRecord();
  const send = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/api/us/traceability/transformation/${frozen.id}`) return Response.json(frozen);
    if (url.includes("/revisions?"))
      return Response.json({ items: [], limit: 50, offset: 0, lifecycleVersion: 2 });
    return Response.json({}, { status: 503 });
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { user, rerender, view, onOpenLot } = await renderTransformation({
    send,
    canManageQa: true,
  });
  await user.click(await screen.findByRole("button", { name: "Start amendment" }));
  await user.type(screen.getByLabelText("QA reason"), "Review quantity before leaving");
  await user.click(screen.getByRole("button", { name: "OUT-2026-001" }));
  expect(confirm).toHaveBeenCalled();
  expect(onOpenLot).not.toHaveBeenCalled();
  expect(screen.getByLabelText("QA reason")).toHaveProperty(
    "value",
    "Review quantity before leaving",
  );
  rerender(view(true, true, true));
  expect(screen.getByRole("button", { name: "OUT-2026-001" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "OUT-2026-001" }));
  expect(onOpenLot).not.toHaveBeenCalled();
});
