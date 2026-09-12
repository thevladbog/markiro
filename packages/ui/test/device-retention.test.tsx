import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DeviceRetentionView,
  emptyDeviceRetentionAttempt,
  type DeviceRetentionAttempt,
  type DeviceRetentionViewProps,
} from "../src/entitlements/index.js";
import type {
  DeviceRetentionObservation,
  DeviceRetentionInspection,
  DeviceRetentionPreview,
  DeviceRetentionReceipt,
} from "@markiro/platform-contracts";
import { ENTITLEMENT_SNAPSHOT } from "./entitlements-fixture.js";
const ID = "11111111-1111-4111-8111-111111111111";
const PREVIEW = "22222222-2222-4222-8222-222222222222";
const boundaryAt = "2026-10-01T00:00:00.000Z";
function observation(): DeviceRetentionObservation {
  const current = structuredClone(ENTITLEMENT_SNAPSHOT);
  current.asOf = "2026-09-30T23:59:00.000Z";
  const future = structuredClone(current);
  future.asOf = boundaryAt;
  future.candidate.quotas.stations = { limit: 1, used: 1, remaining: 0 };
  return {
    boundary: { key: "a".repeat(64), effectiveAt: boundaryAt },
    current,
    future,
    devices: [
      {
        deviceId: ID,
        name: "Original station",
        kind: "station",
        assignmentId: ID,
        revision: 1,
        state: "assigned",
        eligible: true,
        reasons: [],
        knownServerWork: {
          activeShifts: 2,
          activeInventories: 3,
          printJobs: 4,
          quarantineBatches: 5,
        },
        localData: { journals: "unknown", outbox: "unknown", printWork: "unknown" },
      },
    ],
    services: [],
    selectionRequired: true,
    execution: { available: false, reasons: ["enforcement_not_enabled"] },
  };
}
function setup({
  saved = false,
  attempt = structuredClone(emptyDeviceRetentionAttempt),
  facts = observation(),
  currentShadow = { awaitingSelection: false, affectedDeviceIds: [], enforced: false },
  observationAvailable = true,
  canWrite = true,
  canSelect = true,
}: {
  saved?: boolean;
  attempt?: DeviceRetentionAttempt;
  facts?: DeviceRetentionObservation;
  currentShadow?: DeviceRetentionInspection["currentShadow"];
  observationAvailable?: boolean;
  canWrite?: boolean;
  canSelect?: boolean;
} = {}) {
  const receipt: DeviceRetentionReceipt = {
    requestId: ID,
    selection: {
      id: ID,
      revision: 1,
      preparedAt: "2026-09-30T23:59:01.000Z",
      selectedDeviceIds: [ID],
      observation: observation(),
    },
  };
  const inspection: DeviceRetentionInspection = {
    canSelect,
    observation: observationAvailable ? facts : null,
    selections: saved
      ? [{ selection: receipt.selection, needsReview: true, boundaryReached: false }]
      : [],
    currentShadow,
  };
  const store = { value: attempt };
  const listeners = new Set<() => void>();
  const preview = vi.fn<DeviceRetentionViewProps["preview"]>(async (request) => ({
    id: PREVIEW,
    requestId: request.requestId,
    createdAt: "2026-09-30T23:59:01.000Z",
    expiresAt: boundaryAt,
    expectedRevision: request.expectedRevision,
    selectedDeviceIds: request.selectedDeviceIds,
    observation: facts,
  }));
  const confirm = vi.fn<DeviceRetentionViewProps["confirm"]>(async (request, expected) => ({
    requestId: request.requestId,
    selection: {
      ...receipt.selection,
      revision: expected.expectedRevision + 1,
      selectedDeviceIds: expected.selectedDeviceIds,
      observation: expected.observation,
    },
  }));
  const refresh = vi.fn(async () => {});
  const snapshot = vi.fn((value: DeviceRetentionObservation["future"]) => (
    <div>{value.tenantId}</div>
  ));
  function Harness() {
    const value = useSyncExternalStore(
      (notify) => {
        listeners.add(notify);
        return () => {
          listeners.delete(notify);
        };
      },
      () => store.value,
    );
    return (
      <DeviceRetentionView
        canWrite={canWrite}
        inspection={{ data: inspection, isPending: false, isError: false }}
        attempt={value}
        getAttempt={() => store.value}
        setAttempt={(next) => {
          store.value = next;
          for (const notify of listeners) notify();
        }}
        preview={preview}
        confirm={confirm}
        refresh={refresh}
        classifyError={(error) => (error === "stale" ? "conflict" : "uncertain")}
        createRequestId={() => ID}
        translate={(key, options) =>
          key + (options?.count === undefined ? "" : `:${String(options.count)}`)
        }
        language="en"
        renderSnapshot={snapshot}
      />
    );
  }
  const mount = () => render(<Harness />);
  return { store, inspection, receipt, preview, confirm, refresh, snapshot, mount, ...mount() };
}
afterEach(cleanup);
it.each(["ineligible", "absent", "zero"])(
  "explicit blank repairs %s saved membership and preserves original receipt",
  async (mode) => {
    const facts = observation();
    if (mode === "absent") facts.devices = [];
    else if (mode === "ineligible") {
      const device = facts.devices[0];
      if (!device) throw new Error("Missing device");
      device.eligible = false;
      device.reasons = ["device_released"];
    } else facts.future.candidate.quotas.stations = { limit: 0, used: 1, remaining: 0 };
    const old: DeviceRetentionReceipt = {
      requestId: PREVIEW,
      selection: {
        id: PREVIEW,
        revision: 1,
        preparedAt: "2026-09-30T23:59:01.000Z",
        selectedDeviceIds: [ID],
        observation: observation(),
      },
    };
    const view = setup({
      saved: true,
      facts,
      attempt: { ...emptyDeviceRetentionAttempt, receipt: old },
    });
    fireEvent.click(screen.getByRole("button", { name: "deviceRetention.edit" }));
    expect(view.store.value.ids).toEqual([ID]);
    fireEvent.click(screen.getByRole("button", { name: "deviceRetention.blank" }));
    expect(view.store.value).toMatchObject({ ids: [], expectedRevision: 1, receipt: old });
    expect(view.inspection.selections[0]?.selection.selectedDeviceIds).toEqual([ID]);
    fireEvent.change(screen.getByRole("textbox", { name: "deviceRetention.reason" }), {
      target: { value: "Reviewed empty set" },
    });
    fireEvent.click(screen.getByRole("button", { name: "deviceRetention.preview" }));
    await screen.findByRole("button", { name: "deviceRetention.save" });
    expect(view.preview).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1, selectedDeviceIds: [] }),
    );
    expect(view.store.value.receipt).toEqual(old);
    fireEvent.click(screen.getByRole("button", { name: "deviceRetention.save" }));
    await waitFor(() => expect(view.refresh).toHaveBeenCalledOnce());
    expect(view.store.value.receipt?.selection.selectedDeviceIds).toEqual([]);
  },
);
it("pending and uncertain attempts block blank reset and repeat exact preview identity across remount", async () => {
  const view = setup({ saved: true });
  fireEvent.click(screen.getByRole("button", { name: "deviceRetention.edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "deviceRetention.reason" }), {
    target: { value: "Keep original" },
  });
  let reject: (reason: unknown) => void = () => {
    throw new Error("Missing deferred");
  };
  view.preview.mockImplementationOnce(
    () =>
      new Promise<DeviceRetentionPreview>((_, rejectRequest) => {
        reject = rejectRequest;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "deviceRetention.preview" }));
  expect(view.store.value.pending).toBe(true);
  expect(screen.getByRole("button", { name: "deviceRetention.blank" }).matches(":disabled")).toBe(
    true,
  );
  const first = view.store.value.request;
  view.unmount();
  view.mount();
  fireEvent.click(screen.getByRole("button", { name: "deviceRetention.blank" }));
  expect(view.store.value.request).toEqual(first);
  await act(async () => {
    reject(new Error("Lost response"));
  });
  expect(screen.getByRole("button", { name: "deviceRetention.blank" }).matches(":disabled")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "deviceRetention.retry" }));
  await screen.findByRole("button", { name: "deviceRetention.save" });
  expect(view.preview.mock.calls[1]?.[0]).toEqual(first);
});
it("deterministic stale requires explicit restart and preserves saved revision", async () => {
  const view = setup({ saved: true });
  fireEvent.click(screen.getByRole("button", { name: "deviceRetention.blank" }));
  fireEvent.change(screen.getByRole("textbox", { name: "deviceRetention.reason" }), {
    target: { value: "Empty" },
  });
  view.preview.mockRejectedValueOnce("stale");
  fireEvent.click(screen.getByRole("button", { name: "deviceRetention.preview" }));
  await screen.findByText("deviceRetention.conflict");
  expect(view.store.value.request).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "deviceRetention.blank" }));
  expect(view.store.value).toMatchObject({ ids: [], expectedRevision: 1 });
});
it.each([
  { canWrite: false, canSelect: true },
  { canWrite: true, canSelect: false },
])("honors both authorization inputs %o", (permissions) => {
  const view = setup({ ...permissions, saved: true });
  expect(screen.queryByRole("button", { name: "deviceRetention.blank" })).toBeNull();
  expect(view.preview).not.toHaveBeenCalled();
});
it("renders original history through the injected snapshot renderer", () => {
  const view = setup({ saved: true });
  expect(screen.getAllByText("Original station").length).toBeGreaterThan(0);
  expect(view.snapshot).toHaveBeenCalledWith(
    view.inspection.selections[0]?.selection.observation.future,
  );
  expect(screen.getAllByText("deviceReplacement.serverWork").length).toBeGreaterThan(0);
});
it("labels aggregate handheld inclusion without claiming scoped work permission", () => {
  const facts = observation();
  facts.future.candidate.features.handheld = true;
  const device = facts.devices[0];
  if (!device) throw new Error("Missing device");
  device.kind = "handheld";
  device.eligible = false;
  device.reasons = ["handheld_unavailable"];
  const historical: DeviceRetentionReceipt = {
    requestId: PREVIEW,
    selection: {
      id: PREVIEW,
      revision: 1,
      preparedAt: "2026-09-30T23:59:01.000Z",
      selectedDeviceIds: [],
      observation: facts,
    },
  };

  setup({ facts, attempt: { ...emptyDeviceRetentionAttempt, receipt: historical } });

  expect(screen.getAllByText("deviceRetention.handheldIncluded")).toHaveLength(2);
  expect(screen.queryByText("deviceRetention.handheldAvailable")).toBeNull();
  expect(screen.getAllByText("deviceRetention.ineligible.handheld_unavailable")).toHaveLength(2);
});
it("retains the supported aggregate handheld branch", () => {
  const facts = observation();
  facts.future.candidate.features.handheld = true;

  setup({ facts });

  expect(screen.getByText("deviceRetention.handheldIncluded")).toBeTruthy();
});
it.each([
  {
    name: "awaiting selection with an empty affected pool and no live boundary",
    awaitingSelection: true,
    affectedDeviceIds: [] as string[],
    showsCount: true,
    showsAwaiting: true,
  },
  {
    name: "affected devices with an applicable selection and no live boundary",
    awaitingSelection: false,
    affectedDeviceIds: [ID],
    showsCount: true,
    showsAwaiting: false,
  },
  {
    name: "no shadow state and no live boundary",
    awaitingSelection: false,
    affectedDeviceIds: [] as string[],
    showsCount: false,
    showsAwaiting: false,
  },
])("renders $name", ({ awaitingSelection, affectedDeviceIds, showsCount, showsAwaiting }) => {
  setup({
    observationAvailable: false,
    currentShadow: { awaitingSelection, affectedDeviceIds, enforced: false },
  });

  expect(
    screen.queryByText(`deviceRetention.currentShadow:${affectedDeviceIds.length}`) !== null,
  ).toBe(showsCount);
  expect(screen.queryByText("deviceRetention.awaitingSelection") !== null).toBe(showsAwaiting);
  expect(screen.getByText("deviceRetention.noBoundary")).toBeTruthy();
});
