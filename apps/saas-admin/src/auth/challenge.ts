const PLATFORM_CHALLENGE_KEY = "markiro.platform.2fa-challenge";
const PLATFORM_CHALLENGE_VALUE = "pending";

function challengeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function markPlatformChallengePending(): void {
  try {
    challengeStorage()?.setItem(PLATFORM_CHALLENGE_KEY, PLATFORM_CHALLENGE_VALUE);
  } catch {
    // The server challenge cookie remains authoritative if tab storage is unavailable.
  }
}

export function clearPlatformChallenge(): void {
  try {
    challengeStorage()?.removeItem(PLATFORM_CHALLENGE_KEY);
  } catch {
    // There is no sensitive data in the marker, and an unavailable store needs no cleanup.
  }
}

export function isPlatformChallengePending(): boolean {
  try {
    return challengeStorage()?.getItem(PLATFORM_CHALLENGE_KEY) === PLATFORM_CHALLENGE_VALUE;
  } catch {
    return false;
  }
}
