type JsonResponse = { json(): Promise<unknown> };

export async function readActionResponseBody(
  response: Promise<JsonResponse>,
  action: () => Promise<void>,
): Promise<unknown> {
  // Consume the browser-owned body as soon as headers arrive, not after click
  // auto-waiting/navigation can discard the protocol's response resource.
  const captured = response
    .then((value) => value.json())
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  await action();
  const result = await captured;
  if (!result.ok) throw result.error;
  return result.value;
}

export function createResponseObservation() {
  const events = new Set([
    "request-started",
    "response",
    "action-started",
    "action-settled",
    "action-failed",
    "body-started",
    "body-settled",
    "body-failed",
    "request-finished",
    "request-failed",
    "main-frame-navigation",
    "child-frame-navigation",
    "page-close",
    "page-crash",
  ]);
  // Playwright 1.62.0 Request.resourceType's documented closed vocabulary.
  const resourceTypes = new Set([
    "document",
    "stylesheet",
    "image",
    "media",
    "font",
    "script",
    "texttrack",
    "xhr",
    "fetch",
    "eventsource",
    "websocket",
    "manifest",
    "other",
  ]);
  const records: {
    event: string;
    elapsedMs: number;
    status?: number;
    sameOrigin?: boolean;
    fromServiceWorker?: boolean;
    resourceType?: string;
  }[] = [];
  let overflow = false,
    invalid = false,
    stopped = false,
    emitted = false;
  let lastElapsed = 0;
  let frozen = "";
  function record(event: unknown, elapsed: unknown, response?: unknown) {
    if (stopped) return;
    if (
      typeof event !== "string" ||
      !events.has(event) ||
      typeof elapsed !== "number" ||
      !Number.isFinite(elapsed) ||
      elapsed < lastElapsed
    ) {
      invalid = true;
      return;
    }
    try {
      if (event === "response") {
        if (typeof response !== "object" || response === null) {
          invalid = true;
          return;
        }
        const status: unknown = Reflect.get(response, "status");
        const sameOrigin: unknown = Reflect.get(response, "sameOrigin");
        const fromServiceWorker: unknown = Reflect.get(response, "fromServiceWorker");
        const resourceType: unknown = Reflect.get(response, "resourceType");
        if (
          typeof status !== "number" ||
          !Number.isInteger(status) ||
          status < 0 ||
          status > 599 ||
          typeof sameOrigin !== "boolean" ||
          typeof fromServiceWorker !== "boolean" ||
          typeof resourceType !== "string" ||
          !resourceTypes.has(resourceType)
        ) {
          invalid = true;
          return;
        }
        if (records.length < 32)
          records.push({
            event,
            elapsedMs: elapsed,
            status,
            sameOrigin,
            fromServiceWorker,
            resourceType,
          });
        else overflow = true;
      } else {
        if (response !== undefined) {
          invalid = true;
          return;
        }
        if (records.length < 32) records.push({ event, elapsedMs: elapsed });
        else overflow = true;
      }
      lastElapsed = elapsed;
    } catch {
      // Hostile getters/proxies are invalid evidence, never diagnostic payloads.
      invalid = true;
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    frozen = JSON.stringify({ records, overflow, invalid });
  }
  function timed(event: string, elapsed: () => number) {
    if (stopped) return;
    try {
      record(event, elapsed());
    } catch {
      invalid = true;
    }
  }
  return {
    record,
    stop,
    failureLine(): string | undefined {
      stop();
      if (emitted) return undefined;
      emitted = true;
      return `US_REQUEST_CREATE_OBSERVATION ${frozen}`;
    },
    async observe<T>(
      kind: "body" | "action",
      elapsed: () => number,
      operation: () => Promise<T>,
    ): Promise<T> {
      timed(`${kind}-started`, elapsed);
      try {
        const value = await operation();
        timed(`${kind}-settled`, elapsed);
        return value;
      } catch (error) {
        timed(`${kind}-failed`, elapsed);
        throw error;
      }
    },
  };
}
