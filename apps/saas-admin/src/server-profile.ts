export type ServerProfile = "legacy" | "platform-only";

/** Existing development/test builds retain legacy unless an edge pins its profile. */
export function parseServerProfile(value: unknown): ServerProfile {
  if (value === undefined) return "legacy";
  if (value === "legacy" || value === "platform-only") return value;
  throw new Error("VITE_SERVER_PROFILE must be legacy or platform-only");
}

export const SERVER_PROFILE = parseServerProfile(import.meta.env?.VITE_SERVER_PROFILE);
export const IS_PLATFORM_ONLY = SERVER_PROFILE === "platform-only";
