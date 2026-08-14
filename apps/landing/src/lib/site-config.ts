export interface PublicPhone {
  display: string;
  href: `tel:+7${string}`;
}

export interface PublicSiteConfig {
  demoEndpoint: string | null;
  legalLinks: PublicLegalLinks | null;
  phone: PublicPhone | null;
}

export interface PublicLegalLinks {
  consent: string;
  privacy: string;
}

type PublicEnvironment = Readonly<Record<string, string | undefined>>;

function readOptionalValue(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function readPhone(value: string | undefined): PublicPhone | null {
  const display = readOptionalValue(value);
  if (display === null) return null;

  const digits = display.replace(/\D/g, "");
  const normalizedDigits = digits.startsWith("8") ? `7${digits.slice(1)}` : digits;

  if (normalizedDigits.length !== 11 || !normalizedDigits.startsWith("7")) {
    throw new Error("PUBLIC_PHONE must be a Russian phone number");
  }

  return {
    display,
    href: `tel:+7${normalizedDigits.slice(1)}`,
  };
}

function readEnabled(value: string | undefined): boolean {
  const normalized = readOptionalValue(value);
  if (normalized === null || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error("PUBLIC_DEMO_SUBMISSION_ENABLED must be true or false");
}

function readSameOriginPath(value: string | undefined, variable: string): string | null {
  const path = readOptionalValue(value);
  if (path === null) return null;
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`${variable} must be a same-origin absolute path`);
  }

  const url = new URL(path, "https://markiro.app");
  if (url.origin !== "https://markiro.app" || url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`${variable} must be a same-origin absolute path`);
  }
  return url.pathname;
}

export function readPublicSiteConfig(env: PublicEnvironment): PublicSiteConfig {
  const submissionEnabled = readEnabled(env.PUBLIC_DEMO_SUBMISSION_ENABLED);
  const privacy = readSameOriginPath(
    env.PUBLIC_PRIVACY_POLICY_PATH,
    "PUBLIC_PRIVACY_POLICY_PATH",
  );
  const consent = readSameOriginPath(
    env.PUBLIC_PERSONAL_DATA_CONSENT_PATH,
    "PUBLIC_PERSONAL_DATA_CONSENT_PATH",
  );

  if (submissionEnabled && (privacy === null || consent === null)) {
    throw new Error("demo submission requires privacy and personal-data consent paths");
  }

  return {
    demoEndpoint: submissionEnabled ? "/api/demo-requests" : null,
    legalLinks: submissionEnabled && privacy !== null && consent !== null ? { consent, privacy } : null,
    phone: readPhone(env.PUBLIC_PHONE),
  };
}
