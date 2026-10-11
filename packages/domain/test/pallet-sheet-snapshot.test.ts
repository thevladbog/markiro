import { describe, expect, it } from "vitest";
import {
  buildPalletSheetPresets,
  createPalletSheetSnapshot,
  parsePalletSheetSnapshot,
} from "../src/index.js";
const preset = buildPalletSheetPresets()[0];
if (!preset) throw new Error("Missing preset");
const value = {
  id: "8d47946b-1c1c-4589-8ec4-70a3e7ff0024",
  name: "Pallet A4",
  revision: 1,
  spec: preset.spec,
};
describe("immutable pallet sheet snapshot", () => {
  it("hashes content plus selected revision and validates the saved snapshot", () => {
    const snapshot = createPalletSheetSnapshot(value);
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsePalletSheetSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(createPalletSheetSnapshot({ ...value, revision: 2 }).digest).not.toBe(snapshot.digest);
  });
  it("rejects changed content, revision, id, unknown metadata and unsupported spec versions", () => {
    const snapshot = createPalletSheetSnapshot(value);
    for (const changed of [
      { ...snapshot, name: "Other" },
      { ...snapshot, revision: 2 },
      { ...snapshot, id: "bad" },
      { ...snapshot, tenantId: "foreign" },
      { ...snapshot, spec: { ...snapshot.spec, schemaVersion: 3 } },
    ])
      expect(() => parsePalletSheetSnapshot(changed)).toThrow();
  });
  it("bounds untrusted recursive input before parsing or hashing", () => {
    const snapshot = createPalletSheetSnapshot(value);
    const children: unknown[] = [];
    const node = { id: "cycle", kind: "stack", children };
    children.push(node);
    expect(() =>
      parsePalletSheetSnapshot({ ...snapshot, spec: { ...snapshot.spec, body: children } }),
    ).toThrow();
  });
});
