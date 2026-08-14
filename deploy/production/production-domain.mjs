const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateProductionDomain(value, variable = "MARKIRO_DOMAIN") {
  if (
    typeof value !== "string" ||
    ((value !== "localhost" || variable !== "MARKIRO_DOMAIN") &&
      (!value.includes(".") || !DOMAIN_PATTERN.test(value)))
  )
    throw new Error(`${variable} is invalid`);
  return value;
}

export function validateProductionDomains(domain, kioskDomain, landingDomain) {
  validateProductionDomain(domain);
  validateProductionDomain(kioskDomain, "MARKIRO_KIOSK_DOMAIN");
  validateProductionDomain(landingDomain, "MARKIRO_LANDING_DOMAIN");
  if (new Set([domain, kioskDomain, landingDomain]).size !== 3)
    throw new Error("production domains must be distinct");
  return { domain, kioskDomain, landingDomain };
}
