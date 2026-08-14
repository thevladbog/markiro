export interface PublicPhone {
  display: string;
  href: `tel:+7${string}`;
}

export interface PublicSiteConfig {
  demoEndpoint: string | null;
  phone: PublicPhone | null;
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

function readDemoEndpoint(value: string | undefined): string | null {
  const endpoint = readOptionalValue(value);
  if (endpoint === null) return null;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("PUBLIC_DEMO_ENDPOINT must be an absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("PUBLIC_DEMO_ENDPOINT must use HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("PUBLIC_DEMO_ENDPOINT must not contain credentials");
  }

  return url.toString();
}

export function readPublicSiteConfig(env: PublicEnvironment): PublicSiteConfig {
  return {
    demoEndpoint: readDemoEndpoint(env.PUBLIC_DEMO_ENDPOINT),
    phone: readPhone(env.PUBLIC_PHONE),
  };
}
