import shiftFixture from "../../../proto/fixtures/office-shift.json";
import participantsFixture from "../../../proto/fixtures/office-shift-participants.json";
import scansFixture from "../../../proto/fixtures/office-shift-scans.json";
import { officeShiftSchema } from "../../../src/host/protocol.js";

/** Synthetic counts and masked records for the approved shift design. No real host or hardware. */
const shift = officeShiftSchema.parse({
  ...shiftFixture,
  number: "NOV26-001",
  status: "closed",
  plannedDate: "2026-11-01",
  productionDate: "2026-11-01",
  openedAt: "2026-11-01T11:58:00Z",
  closedAt: "2026-11-01T12:04:00Z",
  plannedQty: 8,
  boxCapacity: 2,
  palletsEnabled: true,
  palletBoxCapacity: 2,
  palletTemplateId: shiftFixture.boxTemplateId,
  participants: participantsFixture.participants.map((p) => ({
    ...p,
    state: "closed",
    closedAt: "2026-11-01T12:04:00Z",
    lateDataAt: null,
  })),
  totals: {
    ...shiftFixture.totals,
    acceptedUnits: 8,
    unitsInClosedBoxes: 8,
    closedBoxes: 4,
    openBoxes: 0,
    closedPallets: 2,
    openPallets: 0,
    lastFactAt: "2026-11-01T12:04:00Z",
  },
  byDevice: participantsFixture.participants.map((p) => ({
    deviceId: p.deviceId,
    accepted: 4,
    boxesClosed: 2,
    pallets: 1,
  })),
});
const pallet = {
  id: "a0000000-0000-4000-8000-000000000001",
  deviceId: shiftFixture.ownerDeviceId,
  sscc: "146006820000000409",
  openedAt: "2026-11-01T12:00:00Z",
  closedAt: "2026-11-01T12:03:00Z",
  disassembledAt: null,
  boxes: 2,
  units: 4,
  boxCountReported: 2,
  disassembledBoxes: 0,
  printVerifiedAt: null,
  printSkippedAt: null,
};
export const shiftDesignResponses: Record<string, unknown> = {
  "/v1/office/shifts": [shift],
  [`/v1/office/shifts/${shift.id}`]: shift,
  [`/v1/office/shifts/${shift.id}/boxes`]: [],
  [`/v1/office/shifts/${shift.id}/pallets`]: [
    pallet,
    { ...pallet, id: "a0000000-0000-4000-8000-000000000002", sscc: "146006820000000416" },
  ],
  [`/v1/office/shifts/${shift.id}/exceptions`]: { items: [], total: 0 },
  [`/v1/office/shifts/${shift.id}/rejections`]: { items: [], total: 0 },
  [`/v1/office/shifts/${shift.id}/scans`]: { ...scansFixture, nextCursor: null },
  "/v1/office/conflicts": { items: [], page: 1, pageCount: 1, total: 0 },
};
