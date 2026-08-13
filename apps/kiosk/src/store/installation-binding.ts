export interface BoxRegistryBinding {
  serverUrl: string;
  kioskId: string;
}

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
