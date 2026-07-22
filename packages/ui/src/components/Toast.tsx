import { useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { cn } from "../cn.js";
import type { AlertTone } from "./Alert.js";

/**
 * Toast is a Task-3 synthesis — the handoff's `Toast` (exported alongside
 * `Alert` from `feedback/Alert.jsx`) takes `kind`/`children`/`onClose` as
 * props on a component the caller mounts and controls itself. The plan asks
 * for a minimal *imperative* helper instead (`toast(tone, message)`, no
 * component to wire up), so this reimplements the same visual — inverse
 * surface, `--shadow-3`, tone glyph, dismiss button, `role="status"` — as a
 * singleton viewport lazily mounted into a portal `<div>` appended to
 * `document.body` on first use. Tones reuse `AlertTone` (`ok`/`error`/`warn`/
 * `info`) per the brief. Each toast auto-dismisses after `durationMs`
 * (default ~4s per the brief) or immediately via its close button.
 *
 * The store is read via `useSyncExternalStore` rather than a plain
 * `useState` + module-level "notify" callback: a `toast(...)` call can
 * mount the viewport and push the first entry in the same synchronous tick
 * (e.g. from a click handler), before the viewport's subscription effect
 * has had a chance to run. `useSyncExternalStore` is specifically built to
 * survive that gap — it re-checks the snapshot right after subscribing and
 * forces a re-render if it already changed — so the very first toast is
 * never silently dropped.
 */
export type ToastTone = AlertTone;

interface ToastEntry {
  id: number;
  tone: ToastTone;
  message: ReactNode;
}

const TONE_GLYPH: Record<ToastTone, string> = {
  ok: "✓",
  error: "✕",
  warn: "⧉",
  info: "⟳",
};

let container: HTMLDivElement | null = null;
let entries: ToastEntry[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function ensureMounted() {
  if (container) return;
  container = document.createElement("div");
  container.setAttribute("data-mk-toast-root", "");
  document.body.appendChild(container);
  createRoot(container).render(<ToastViewport />);
}

function setEntries(next: ToastEntry[]) {
  entries = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return entries;
}

function dismiss(id: number) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  setEntries(entries.filter((entry) => entry.id !== id));
}

/** Показывает временное уведомление (офис). В цехе тосты не используются. */
export function toast(tone: ToastTone, message: ReactNode, durationMs = 4000): number {
  ensureMounted();
  const id = nextId++;
  setEntries([...entries, { id, tone, message }]);
  if (durationMs > 0) {
    const timer = setTimeout(() => dismiss(id), durationMs);
    timers.set(id, timer);
  }
  return id;
}

function ToastViewport() {
  const currentEntries = useSyncExternalStore(subscribe, getSnapshot);

  return (
    <div
      className="mk-toast-viewport"
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {currentEntries.map((entry) => (
        <div
          key={entry.id}
          role="status"
          className={cn("mk-toast", `mk-toast--${entry.tone}`)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            borderRadius: "var(--r-2)",
            background: "var(--surface-inverse)",
            color: "var(--fg-on-inverse)",
            boxShadow: "var(--shadow-3)",
            maxWidth: 420,
          }}
        >
          <span aria-hidden="true" style={{ font: "600 16px/1 var(--font-ui)" }}>
            {TONE_GLYPH[entry.tone]}
          </span>
          <span style={{ font: "var(--text-body)", flex: 1 }}>{entry.message}</span>
          <button
            type="button"
            onClick={() => dismiss(entry.id)}
            aria-label="Закрыть"
            style={{
              border: "none",
              background: "transparent",
              color: "inherit",
              opacity: 0.6,
              cursor: "pointer",
              padding: 4,
              display: "flex",
              font: "600 12px/1 var(--font-ui)",
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
