import type { HelloObservation } from "../../src/host/probe.js";
import type { DeviceStatus, OfficeSession } from "../../src/host/protocol.js";

export const HOST_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

export const DEVICE_STATUS: DeviceStatus = {
  hostAddress: "https://127.0.0.1:45710",
  fingerprint: "ab".repeat(32),
  hostId: HOST_ID,
  deviceId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  kind: "station",
  lineId: null,
};

export function observation(initialized: boolean): HelloObservation {
  return {
    hello: {
      product: "markiro-host",
      protocol: 1,
      minProtocol: 1,
      hostId: HOST_ID,
      version: "0.1.0",
      time: "2026-09-26T09:15:00Z",
      initialized,
    },
    fingerprint: "ab".repeat(32),
  };
}

export const SESSION: OfficeSession = {
  token: "office-session-token",
  user: {
    id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
    login: "admin",
    name: "Ирина Смирнова",
    role: "admin",
  },
  expiresAt: "2026-09-26T21:15:00Z",
};
