import { expect, it, vi } from "vitest";
import { buildPalletSheetPresets, createPalletSheetSnapshot } from "@markiro/domain";
import { fetchSavedShiftSheet } from "../src/pages/shifts/api.js";
import { apiFetch } from "../src/api/client.js";
vi.mock("../src/api/client.js", () => ({
  apiFetch: vi.fn(),
  ApiRequestError: class extends Error {},
}));
it("loads the saved bundle revision and rejects a stale or corrupt snapshot", async () => {
  const preset = buildPalletSheetPresets()[0];
  if (!preset) throw new Error("Missing preset");
  const snapshot = createPalletSheetSnapshot({
    id: "a1111111-1111-4111-8111-111111111111",
    name: "Saved",
    revision: 1,
    spec: preset.spec,
  });
  const mocked = vi.mocked(apiFetch);
  mocked.mockResolvedValue({ shift: { id: "shift" }, palletSheetTemplate: snapshot });
  expect(await fetchSavedShiftSheet("shift", snapshot.id, 1)).toEqual(snapshot);
  expect(mocked).toHaveBeenCalledWith("/shifts/shift/reference-bundle", {
    headers: { "x-label-template-formats": "label-v1,pallet-sheet-v2" },
  });
  await expect(fetchSavedShiftSheet("shift", snapshot.id, 2)).rejects.toThrow();
  mocked.mockResolvedValue({
    shift: { id: "shift" },
    palletSheetTemplate: { ...snapshot, digest: "0".repeat(64) },
  });
  await expect(fetchSavedShiftSheet("shift", snapshot.id, 1)).rejects.toThrow();
});
