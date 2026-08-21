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

export function validateProductionDomains(domain, saasAdminDomain, kioskDomain, landingDomain) {
  validateProductionDomain(domain);
  validateProductionDomain(saasAdminDomain, "MARKIRO_SAAS_ADMIN_DOMAIN");
  validateProductionDomain(kioskDomain, "MARKIRO_KIOSK_DOMAIN");
  validateProductionDomain(landingDomain, "MARKIRO_LANDING_DOMAIN");
  if (new Set([domain, saasAdminDomain, kioskDomain, landingDomain]).size !== 4)
    throw new Error("production domains must be distinct");
  return { domain, saasAdminDomain, kioskDomain, landingDomain };
}

export function validateVbtechDomains(domain, wwwDomain, reservedDomains = []) {
  validateProductionDomain(domain, "VBTECH_DOMAIN");
  validateProductionDomain(wwwDomain, "VBTECH_WWW_DOMAIN");
  if (domain !== "v-b.tech") throw new Error("VBTECH_DOMAIN is invalid");
  if (wwwDomain !== "www.v-b.tech") throw new Error("VBTECH_WWW_DOMAIN is invalid");
  if (new Set([...reservedDomains, domain, wwwDomain]).size !== reservedDomains.length + 2)
    throw new Error("production domains must be distinct");
  return { domain, wwwDomain };
}
