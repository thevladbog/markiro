import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import * as hardware from "../src/lib/hardware.js";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

beforeEach(() => vi.clearAllMocks());

it("keeps production print IPC unchanged and opts warehouse sends into unknown-delivery timeout", async () => {
  const target = { kind: "usb" as const, printer: "TSC 210" };
  const bytes = new Uint8Array([0x5e, 0x58, 0x41, 0xa4]);
  await hardware.tauriHardware.print(target, bytes);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["print_bytes", { target, payloadBase64: "XlhBpA==" }],
  ]);
  expect(hardware.tauriWarehousePrint).toBeTypeOf("function");
  await hardware.tauriWarehousePrint(target, bytes);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["print_bytes", { target, payloadBase64: "XlhBpA==" }],
    ["print_bytes", { target, payloadBase64: "XlhBpA==", deliveryUnknownOnTimeout: true }],
  ]);
});
