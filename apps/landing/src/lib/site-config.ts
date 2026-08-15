export interface PublicPhone {
  display: string;
  href: `tel:+7${string}`;
}

export interface PublicSiteConfig {
  captchaClientKey: string | null;
  consentVersion: string | null;
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

export function readPublicSiteConfig(env: PublicEnvironment): PublicSiteConfig {
  const submissionEnabled = readEnabled(env.PUBLIC_DEMO_SUBMISSION_ENABLED);
  if (!submissionEnabled) {
    return {
      captchaClientKey: null,
      consentVersion: null,
      demoEndpoint: null,
      legalLinks: null,
      phone: readPhone(env.PUBLIC_PHONE),
    };
  }

  const captchaClientKey = readOptionalValue(env.PUBLIC_SMARTCAPTCHA_CLIENT_KEY);

  if (captchaClientKey === null) {
    throw new Error("demo submission requires a captcha client key");
  }
  if (!captchaClientKey.startsWith("ysc1_") || captchaClientKey.length === "ysc1_".length) {
    throw new Error("PUBLIC_SMARTCAPTCHA_CLIENT_KEY must begin with ysc1_");
  }
  return {
    captchaClientKey,
    consentVersion: CURRENT_DEMO_CONSENT_ID,
    demoEndpoint: "/api/demo-requests",
    legalLinks: { consent: "/personal-data-consent/", privacy: "/privacy/" },
    phone: readPhone(env.PUBLIC_PHONE),
  };
}
import { CURRENT_DEMO_CONSENT_ID } from "@markiro/legal-documents";
