import {
  DomainError,
  organizationBrandingDescriptorSchema,
  logoFromRgba,
  sheetLogoFingerprint,
  type MonoBitmap,
  type SheetLogo,
} from "@markiro/domain";
import { API_BASE, apiFetch, apiErrorFromResponse } from "../../../../api/client.js";
import { loadSheetPreviewLogo } from "./sheet-preview.js";
export interface SheetPreviewBranding {
  organizationName: string;
  logo: SheetLogo;
}
interface PreviewBrandingPorts {
  decodeLogo?: (blob: Blob) => Promise<MonoBitmap>;
  loadMarkiroLogo?: () => Promise<MonoBitmap>;
}
async function decodeLogo(blob: Blob): Promise<MonoBitmap> {
  const url = URL.createObjectURL(blob),
    image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (
      image.naturalWidth < 1 ||
      image.naturalHeight < 1 ||
      image.naturalWidth > 1024 ||
      image.naturalHeight > 512
    )
      throw new Error("Invalid preview logo dimensions");
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Logo canvas unavailable");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    return logoFromRgba(
      canvas.width,
      canvas.height,
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function loadCabinetSheetBranding(
  ports: PreviewBrandingPorts = {},
): Promise<SheetPreviewBranding> {
  try {
    const metadata = organizationBrandingDescriptorSchema.parse(
      await apiFetch<unknown>("/org/profile/print-branding"),
    );
    let bitmap: MonoBitmap;
    if (metadata.logo && metadata.logoRevision && metadata.logoUrl) {
      if (metadata.logoUrl !== `/org/profile/print-branding/logo/${metadata.logoRevision}`)
        throw new Error("Invalid cabinet logo route");
      const response = await fetch(`${API_BASE}${metadata.logoUrl}`, { credentials: "include" });
      if (!response.ok) throw await apiErrorFromResponse(response);
      const blob = await response.blob();
      if (blob.type !== metadata.logo.contentType || blob.size !== metadata.logo.byteSize)
        throw new Error("Logo metadata mismatch");
      const checksum = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
      ]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
      if (checksum !== metadata.logo.checksum) throw new Error("Logo checksum mismatch");
      bitmap = await (ports.decodeLogo ?? decodeLogo)(blob);
      if (bitmap.width !== metadata.logo.width || bitmap.height !== metadata.logo.height)
        throw new Error("Logo dimensions mismatch");
    } else bitmap = await (ports.loadMarkiroLogo ?? (() => loadSheetPreviewLogo(false)))();
    return {
      organizationName: metadata.organizationName,
      logo: {
        ...bitmap,
        digest: sheetLogoFingerprint(bitmap),
        source: metadata.logoRevision ? "organization" : "markiro",
        ...(metadata.logoRevision ? { revision: metadata.logoRevision } : {}),
      },
    };
  } catch (cause) {
    throw new DomainError("LABEL_SHEET_BRANDING", "Organization branding is unavailable", {
      cause,
    });
  }
}
