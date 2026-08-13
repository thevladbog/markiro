export interface BoxRegistryBinding {
  serverUrl: string;
  kioskId: string;
}

export interface BoxRegistryCredentialOwner {
  binding: BoxRegistryBinding;
  credentialGeneration: string;
}

const CREDENTIAL_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stable installation identity shared by config and the offline box registry. */
export function boxRegistryBindingOf(value: unknown): BoxRegistryBinding | null {
  const candidate = value as { serverUrl?: unknown; kioskId?: unknown } | null | undefined;
  if (typeof candidate?.serverUrl !== "string" || typeof candidate.kioskId !== "string")
    return null;
  const serverUrl = candidate.serverUrl.trim().replace(/\/+$/, "");
  const kioskId = candidate.kioskId.trim();
  if (
    serverUrl.length === 0 ||
    serverUrl.length > 2_048 ||
    kioskId.length === 0 ||
    kioskId.length > 128
  )
    return null;
  return { serverUrl, kioskId };
}

export function sameBoxRegistryBinding(
  left: BoxRegistryBinding | null,
  right: BoxRegistryBinding | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.serverUrl === right.serverUrl &&
    left.kioskId === right.kioskId
  );
}

export function boxRegistryBindingKey(binding: BoxRegistryBinding): string {
  return `${binding.serverUrl}\u0000${binding.kioskId}`;
}

export function credentialGenerationOf(value: unknown): string | null {
  const generation = (value as { credentialGeneration?: unknown } | null | undefined)
    ?.credentialGeneration;
  return typeof generation === "string" && CREDENTIAL_GENERATION_PATTERN.test(generation)
    ? generation.toLowerCase()
    : null;
}

export function boxRegistryCredentialOwnerOf(value: unknown): BoxRegistryCredentialOwner | null {
  const candidate = value as
    { binding?: unknown; credentialGeneration?: unknown } | null | undefined;
  const binding = boxRegistryBindingOf(candidate?.binding ?? value);
  const credentialGeneration = credentialGenerationOf(value);
  return binding && credentialGeneration ? { binding, credentialGeneration } : null;
}

export function sameBoxRegistryCredentialOwner(
  left: BoxRegistryCredentialOwner | null,
  right: BoxRegistryCredentialOwner | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    sameBoxRegistryBinding(left.binding, right.binding) &&
    left.credentialGeneration === right.credentialGeneration
  );
}

export function boxRegistryCredentialOwnerKey(owner: BoxRegistryCredentialOwner): string {
  return `${boxRegistryBindingKey(owner.binding)}\u0000${owner.credentialGeneration}`;
}
