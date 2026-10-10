import { z } from "zod";
import { DomainError } from "../errors.js";
import { bitmapFromText, validateMonoBitmap, type MonoBitmap } from "./mono-compose.js";
import { productLabelValueDigest } from "../product-labels/km.js";
import { bitmapToZplHex, convertToMonochrome } from "./raster.js";
export const organizationLogoDescriptorSchema = z.strictObject({
  contentType: z.literal("image/webp"),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  width: z.number().int().positive().max(1024),
  height: z.number().int().positive().max(512),
});
export const organizationBrandingDescriptorSchema = z
  .strictObject({
    organizationName: z.string().trim().min(1).max(255),
    logoRevision: z.uuid().nullable(),
    logoUrl: z.string().nullable(),
    logo: organizationLogoDescriptorSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.logoRevision === null) {
      if (value.logo !== null || value.logoUrl !== null)
        ctx.addIssue({ code: "custom", message: "Absent logo must be explicit" });
    } else if (
      value.logo === null ||
      ![
        `/station/branding/logo/${value.logoRevision}`,
        `/org/profile/print-branding/logo/${value.logoRevision}`,
      ].includes(value.logoUrl ?? "")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Configured logo requires complete private metadata",
      });
    }
  });
export type OrganizationBrandingDescriptor = z.infer<typeof organizationBrandingDescriptorSchema>;
export function sheetLogoFingerprint(bitmap: MonoBitmap): string {
  validateMonoBitmap(bitmap);
  return productLabelValueDigest({
    width: bitmap.width,
    height: bitmap.height,
    stride: bitmap.stride,
    pixelsHex: [...bitmap.pixels].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  });
}
/** Decode against paper white; retain every source pixel and the natural aspect. */
export function logoFromRgba(width: number, height: number, rgba: Uint8ClampedArray): MonoBitmap {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 3508 ||
    height > 3508 ||
    width * height > 1024 * 512 ||
    rgba.length !== width * height * 4
  )
    throw new DomainError("LABEL_SHEET_BRANDING", "Invalid decoded logo dimensions");
  const white = new Uint8ClampedArray(rgba);
  for (let index = 0; index < white.length; index += 4) {
    const alpha = (rgba[index + 3] ?? 0) / 255;
    for (let channel = 0; channel < 3; channel++)
      white[index + channel] = (rgba[index + channel] ?? 0) * alpha + 255 * (1 - alpha);
    white[index + 3] = 255;
  }
  return bitmapFromText({
    ...bitmapToZplHex(convertToMonochrome(white, width, height), width, height),
    width,
    height,
  });
}
