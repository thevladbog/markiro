export const CONSENT_STORAGE_KEY = "markiro-consent";

export type ConsentCategory = "analytics" | "marketing";

export interface ConsentState {
  version: 1;
  analytics: boolean;
  marketing: boolean;
}

export function parseConsent(stored: string | null): ConsentState | null {
  if (stored === null || stored.length === 0) return null;

  try {
    const value = JSON.parse(stored) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("analytics" in value) ||
      typeof value.analytics !== "boolean" ||
      !("marketing" in value) ||
      typeof value.marketing !== "boolean"
    ) {
      return null;
    }

    return { version: 1, analytics: value.analytics, marketing: value.marketing };
  } catch {
    return null;
  }
}

export function serializeConsent(state: ConsentState): string {
  return JSON.stringify({
    version: 1,
    analytics: state.analytics,
    marketing: state.marketing,
  });
}

export function readConsent(storage: Pick<Storage, "getItem">): ConsentState | null {
  try {
    return parseConsent(storage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function canUseCategory(state: ConsentState | null, category: ConsentCategory): boolean {
  return state?.[category] === true;
}
