/** Mirrors the host's 30-minute idle limit, without sending keepalive requests. */
const IDLE_MS = 30 * 60_000;

export function watchOfficeSession(expiresAt: string, onEnded: () => void) {
  const absolute = Date.parse(expiresAt);
  let lastRequest = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (stopped) return;
    clearTimeout(timer);
    const remaining = Math.min(absolute, lastRequest + IDLE_MS) - Date.now();
    if (remaining <= 0) {
      stop();
      onEnded();
    } else {
      timer = setTimeout(check, remaining);
    }
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", check);
  };
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", check);
  check();
  return {
    // Use the request's start, not its response: latency must not extend the session.
    confirmRequest(startedAt: number) {
      lastRequest = Math.max(lastRequest, startedAt);
      check();
    },
    stop,
  };
}
