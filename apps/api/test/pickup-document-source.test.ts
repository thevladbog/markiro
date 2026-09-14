import { describe, expect, it } from "vitest";
import {
  handheldSource,
  kioskSource,
  sourceColumns,
  sourceLabel,
} from "../src/modules/pickup-orders/document-source";

describe("pickup document source", () => {
  it("maps a kiosk source onto the kiosk column only", () => {
    expect(sourceColumns(kioskSource("k-1"))).toEqual({
      sourceKind: "kiosk",
      kioskId: "k-1",
      stationDeviceId: null,
    });
  });

  it("maps a handheld source onto the station-device column only", () => {
    expect(sourceColumns(handheldSource("d-1"))).toEqual({
      sourceKind: "handheld",
      kioskId: null,
      stationDeviceId: "d-1",
    });
  });

  it("names the device for a log line without exposing it as a query key", () => {
    expect(sourceLabel(kioskSource("k-1"))).toBe("kiosk k-1");
    expect(sourceLabel(handheldSource("d-1"))).toBe("handheld d-1");
  });
});
