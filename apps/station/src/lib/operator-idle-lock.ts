import type { ScanSource } from "./scan-source.js";

export const OPERATOR_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

type ActivityTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

interface OperatorIdleLockOptions {
  target: ActivityTarget;
  onIdle: () => void;
  timeoutMs?: number;
}

export interface OperatorIdleLock {
  start(): void;
  stop(): void;
  activity(): void;
}

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

export function createOperatorIdleLock({
  target,
  onIdle,
  timeoutMs = OPERATOR_IDLE_TIMEOUT_MS,
}: OperatorIdleLockOptions): OperatorIdleLock {
  let active = false;
  let listening = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const activity = () => {
    if (!active) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      active = false;
      onIdle();
    }, timeoutMs);
  };
  const onActivity: EventListener = () => activity();
  const stop = () => {
    active = false;
    clearTimer();
    if (listening) {
      for (const eventName of ACTIVITY_EVENTS) {
        target.removeEventListener(eventName, onActivity);
      }
      listening = false;
    }
  };

  return {
    start() {
      stop();
      active = true;
      for (const eventName of ACTIVITY_EVENTS) {
        target.addEventListener(eventName, onActivity);
      }
      listening = true;
      activity();
    },
    stop,
    activity,
  };
}

export function createActivityAwareScanSource(
  source: ScanSource,
  onActivity: () => void,
): ScanSource {
  return {
    ...source,
    start(listener) {
      return source.start((raw) => {
        onActivity();
        listener(raw);
      });
    },
  };
}
