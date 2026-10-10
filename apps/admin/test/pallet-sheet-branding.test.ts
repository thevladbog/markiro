import { afterEach, expect, it, vi } from "vitest";
import { apiFetch } from "../src/api/client.js";
import { loadCabinetSheetBranding } from "../src/pages/labels/editor/sheet/sheet-branding.js";
vi.mock("../src/api/client.js", () => ({
  apiFetch: vi.fn(),
  API_BASE: "/api",
  apiErrorFromResponse: async () => new Error("API failure"),
}));
afterEach(() => vi.restoreAllMocks());
const bitmap = { width: 4, height: 1, stride: 1, pixels: Uint8Array.of(128) };
it("uses the real organization name and Markiro only for explicit absence", async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    organizationName: "Real Plant",
    logoRevision: null,
    logoUrl: null,
    logo: null,
  });
  const actual = await loadCabinetSheetBranding({
    loadMarkiroLogo: async () => ({ ...bitmap, source: "markiro", digest: "sample" }),
  });
  expect(actual).toMatchObject({ organizationName: "Real Plant", logo: { source: "markiro" } });
});
it("loads a private configured logo and refuses failure instead of substituting the fallback", async () => {
  const revision = "a1111111-1111-4111-8111-111111111111",
    blob = new Blob([Uint8Array.of(1, 2)], { type: "image/webp" });
  const checksum = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  vi.mocked(apiFetch).mockResolvedValue({
    organizationName: "Real Plant",
    logoRevision: revision,
    logoUrl: `/org/profile/print-branding/logo/${revision}`,
    logo: { contentType: "image/webp", checksum, byteSize: 2, width: 4, height: 1 },
  });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(Uint8Array.of(1, 2), { headers: { "Content-Type": "image/webp" } }),
    );
  const fallback = vi.fn();
  const result = await loadCabinetSheetBranding({
    decodeLogo: async () => bitmap,
    loadMarkiroLogo: fallback,
  });
  expect(result.logo).toMatchObject({ source: "organization", revision, width: 4, height: 1 });
  expect(fetchMock).toHaveBeenCalledWith(`/api/org/profile/print-branding/logo/${revision}`, {
    credentials: "include",
  });
  expect(fallback).not.toHaveBeenCalled();
  fetchMock.mockRejectedValue(new Error("offline"));
  await expect(loadCabinetSheetBranding({ loadMarkiroLogo: fallback })).rejects.toThrow();
  expect(fallback).not.toHaveBeenCalled();
});
