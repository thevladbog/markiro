import { expect, it } from "vitest";
import {
  organizationBrandingDescriptorSchema,
  logoFromRgba,
} from "../src/labels/pallet-sheet-branding.js";
it("requires a complete private logo descriptor or explicit absence", () => {
  expect(
    organizationBrandingDescriptorSchema.parse({
      organizationName: "Plant",
      logoRevision: null,
      logoUrl: null,
      logo: null,
    }).logo,
  ).toBeNull();
  const revision = "a1111111-1111-4111-8111-111111111111";
  const descriptor = {
    organizationName: "Plant",
    logoRevision: revision,
    logoUrl: `/station/branding/logo/${revision}`,
    logo: {
      contentType: "image/webp",
      checksum: "a".repeat(64),
      byteSize: 123,
      width: 1000,
      height: 100,
    },
  };
  expect(organizationBrandingDescriptorSchema.parse(descriptor)).toEqual(descriptor);
  for (const value of [
    { ...descriptor, logo: null },
    { ...descriptor, logoUrl: "https://evil.test/image" },
    { ...descriptor, organizationName: " " },
    { ...descriptor, logoRevision: null },
    { ...descriptor, logo: { ...descriptor.logo, byteSize: 9_000_000 } },
  ])
    expect(organizationBrandingDescriptorSchema.safeParse(value).success).toBe(false);
});
it("composites transparent pixels against white without cropping a rectangular logo", () => {
  const bitmap = logoFromRgba(
    3,
    1,
    new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]),
  );
  expect(bitmap).toMatchObject({ width: 3, height: 1, stride: 1 });
  expect([...bitmap.pixels]).toEqual([128]);
  expect(() => logoFromRgba(3, 1, new Uint8ClampedArray(3))).toThrow();
  expect(() => logoFromRgba(100_000, 1, new Uint8ClampedArray())).toThrow();
});
