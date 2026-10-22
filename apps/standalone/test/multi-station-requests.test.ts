import { describe, expect, it } from "vitest";

import { createHostApi, type HostApi } from "../src/host/api.js";
import type { HostClient, HttpMethod } from "../src/host/client.js";
import { lineUpdateSchema, shiftCloseReasonSetSchema } from "../src/host/protocol.js";
import { lineMaxStations, lineUpdate, shiftCloseReasonSet } from "../src/host/requests.js";
import { fixture } from "./support/proto-fixture.js";

const LINE = { name: "Линия 2", archived: false, rev: 40 } as const;
const TOKEN = "office-session-token";
const SHIFT_ID = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b";

describe("the line's limit in a line update (plan 2b)", () => {
  it("reads a line of a host before protocol 7 as a line of one station", () => {
    expect(lineMaxStations(LINE)).toBe(1);
    expect(lineMaxStations({ ...LINE, maxStations: 3 })).toBe(3);
  });

  it("sends the limit only when it differs from the loaded one, with the loaded revision", () => {
    const same = { name: "Линия 2", archived: false };
    expect(lineUpdate({ ...LINE, maxStations: 2 }, { ...same, maxStations: 3 })).toEqual({
      expectedRev: 40,
      maxStations: 3,
    });
    expect(lineUpdate({ ...LINE, maxStations: 2 }, { ...same, maxStations: 2 })).toEqual({
      expectedRev: 40,
    });
    // A line with no limit is a line of one: typing 1 again changes nothing.
    expect(lineUpdate(LINE, { ...same, maxStations: 1 })).toEqual({ expectedRev: 40 });
    // A caller that says nothing of the limit never touches it.
    expect(lineUpdate({ ...LINE, maxStations: 2 }, same)).toEqual({ expectedRev: 40 });
  });

  it("builds exactly the body of the shared fixture", () => {
    expect(
      lineUpdate(
        { name: "Линия 2", archived: false, rev: 40, maxStations: 2 },
        { name: "Линия 2", archived: false, maxStations: 3 },
      ),
    ).toEqual(lineUpdateSchema.parse(fixture("line-update-max-stations.json")));
  });

  it("still sends a rename and an archive as before", () => {
    expect(lineUpdate(LINE, { name: "Линия 3", archived: true })).toEqual({
      expectedRev: 40,
      name: "Линия 3",
      archived: true,
    });
  });
});

describe("the reason of a shared shift (plan 2b)", () => {
  it("builds exactly the body of the shared fixture", () => {
    expect(shiftCloseReasonSet("equipment_stop", 88)).toEqual(
      shiftCloseReasonSetSchema.parse(fixture("shift-close-reason-set.json")),
    );
  });
});

interface Sent {
  method: HttpMethod;
  path: string;
  body: unknown;
  officeToken: string | undefined;
}

/** A client that records the request and answers `answer`, parsed by the caller's schema. */
function recording(answer: unknown): { api: HostApi; sent: Sent[] } {
  const sent: Sent[] = [];
  const client: HostClient = {
    request: async (method, path, options) => {
      sent.push({ method, path, body: options.body, officeToken: options.officeToken });
      return options.schema.parse(answer);
    },
  };
  return { api: createHostApi(client), sent };
}

describe("HostApi.setShiftCloseReason (plan 2b)", () => {
  it("puts the code with the loaded revision on the shift's close-reason route", async () => {
    const { api, sent } = recording(fixture("office-shift-participants.json"));
    const body = shiftCloseReasonSetSchema.parse(fixture("shift-close-reason-set.json"));
    const shift = await api.setShiftCloseReason(TOKEN, SHIFT_ID, body);
    expect(sent).toEqual([
      {
        method: "PUT",
        path: `/v1/office/shifts/${SHIFT_ID}/close-reason`,
        body,
        officeToken: TOKEN,
      },
    ]);
    expect(shift.closeReasonMissing).toBe(true);
    expect(shift.participants?.map((participant) => participant.state)).toEqual([
      "closed",
      "closed",
    ]);
  });

  it("refuses an answer that is no shift", async () => {
    const { api } = recording({
      ...(fixture("office-shift-participants.json") as object),
      status: "open",
    });
    await expect(
      api.setShiftCloseReason(TOKEN, SHIFT_ID, { reasonCode: "equipment_stop", expectedRev: 88 }),
    ).rejects.toThrow();
  });
});
