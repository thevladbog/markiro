const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateProductionDomain(value) {
  if (typeof value !== "string" || !DOMAIN_PATTERN.test(value))
    throw new Error("MARKIRO_DOMAIN is invalid");
  return value;
}
