import type { UsRequestRunDetail } from "@markiro/platform-contracts";

export type RequestPollingOptions = {
  read: () => Promise<UsRequestRunDetail>;
  onValue: (run: UsRequestRunDetail) => void;
  onPause: (reason: "budget" | "errors" | "hidden" | "terminal" | "authority") => void;
  onError: (error: unknown) => "transient" | "stop";
  owns: () => boolean;
  isVisible: () => boolean;
  now: () => number;
};
export function startRequestPolling(options: RequestPollingOptions): { stop(): void } {
  let active = true;
  let errors = 0;
  const started = options.now();
  let timer: ReturnType<typeof setTimeout>;
  function stop() {
    active = false;
    clearTimeout(timer);
  }
  function pause(reason: Parameters<RequestPollingOptions["onPause"]>[0]) {
    stop();
    options.onPause(reason);
  }
  function valid() {
    if (!active) return false;
    if (!options.owns()) {
      pause("authority");
      return false;
    }
    if (!options.isVisible()) {
      pause("hidden");
      return false;
    }
    if (options.now() - started >= 300_000) {
      pause("budget");
      return false;
    }
    return true;
  }
  async function read() {
    if (!valid()) return;
    try {
      const run = await options.read();
      if (!valid()) return;
      errors = 0;
      options.onValue(run);
      if (!valid()) return;
      if (run.status === "ready" || run.status === "failed") {
        pause("terminal");
        return;
      }
    } catch (error) {
      if (!valid()) return;
      if (options.onError(error) === "stop") {
        pause("authority");
        return;
      }
      if (!valid()) return;
      if (++errors === 3) {
        pause("errors");
        return;
      }
    }
    if (valid()) timer = setTimeout(() => void read(), 2000);
  }
  timer = setTimeout(() => void read(), 2000);
  return { stop };
}
