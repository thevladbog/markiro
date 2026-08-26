import {
  PERSISTENT_GALLERY_STATE_IDS,
  type PersistentGalleryStateId,
} from "../ui/persistent-station-states.js";

const VISUAL_STRESS_GALLERY_STATE_IDS = [
  "work-aggregation-waiting",
  "pairing-recovery",
  "floor-header-actions",
  "floor-header-window-error",
  "long-copy-ru",
  "long-copy-en",
] as const;

export const INVENTORY_GALLERY_STATE_IDS = [
  "inventory-task-selection",
  "inventory-other-line-confirmation",
  "inventory-simple-box-accepted",
  "inventory-duplicate-other-terminal",
  "inventory-known-ineligible",
  "inventory-protected-moving-by-ud",
  "inventory-not-in-snapshot",
  "inventory-repack-awaiting-old-box",
  "inventory-repack-scanning",
  "inventory-repack-capacity-20",
  "inventory-repack-box-ready",
  "inventory-repack-corrections",
  "inventory-production-date-change",
  "inventory-leave-open-box",
  "inventory-print-recovery",
  "inventory-same-sscc-reprint-confirmation",
] as const;

export type GalleryStateId =
  | PersistentGalleryStateId
  | (typeof VISUAL_STRESS_GALLERY_STATE_IDS)[number]
  | (typeof INVENTORY_GALLERY_STATE_IDS)[number];

export const EXPECTED_GALLERY_STATE_IDS: readonly GalleryStateId[] = Array.from(
  new Set<GalleryStateId>([
    ...PERSISTENT_GALLERY_STATE_IDS,
    ...VISUAL_STRESS_GALLERY_STATE_IDS,
    ...INVENTORY_GALLERY_STATE_IDS,
  ]),
);
export type GalleryLocale = "ru" | "en";

export interface GalleryRequest {
  state: GalleryStateId;
  locale: GalleryLocale;
}

export type GalleryFixtureKind =
  | "system"
  | "credential-recovery"
  | "legacy-identity"
  | "pairing"
  | "login"
  | "new-shift"
  | "shift"
  | "work"
  | "work-overlay"
  | "signal"
  | "box"
  | "box-print-recovery"
  | "serial-recovery"
  | "exception"
  | "conflicts"
  | "setup"
  | "sync"
  | "print"
  | "updates"
  | "inventory"
  | "floor-header"
  | "long-copy";

export interface GalleryFixture {
  id: GalleryStateId;
  kind: GalleryFixtureKind;
  variant: string;
  /** Gallery fixtures are never hydrated from a production persistence path. */
  source: "synthetic";
}

export const GALLERY_FIXTURES: readonly GalleryFixture[] = [
  { id: "app-loading", kind: "system", variant: "loading", source: "synthetic" },
  {
    id: "credential-recovery-sealing",
    kind: "credential-recovery",
    variant: "sealing",
    source: "synthetic",
  },
  {
    id: "credential-recovery-failed",
    kind: "credential-recovery",
    variant: "failed",
    source: "synthetic",
  },
  {
    id: "credential-recovery-ready",
    kind: "credential-recovery",
    variant: "ready",
    source: "synthetic",
  },
  {
    id: "legacy-identity-resolving",
    kind: "legacy-identity",
    variant: "resolving",
    source: "synthetic",
  },
  {
    id: "legacy-identity-degraded",
    kind: "legacy-identity",
    variant: "degraded",
    source: "synthetic",
  },
  {
    id: "legacy-identity-rejected",
    kind: "legacy-identity",
    variant: "rejected",
    source: "synthetic",
  },
  { id: "pairing-waiting", kind: "pairing", variant: "waiting", source: "synthetic" },
  { id: "pairing-redeeming", kind: "pairing", variant: "redeeming", source: "synthetic" },
  { id: "pairing-error", kind: "pairing", variant: "error", source: "synthetic" },
  { id: "pairing-success", kind: "pairing", variant: "success", source: "synthetic" },
  { id: "pairing-service", kind: "pairing", variant: "service", source: "synthetic" },
  { id: "pairing-recovery", kind: "pairing", variant: "recovery", source: "synthetic" },
  { id: "login-badge", kind: "login", variant: "badge", source: "synthetic" },
  { id: "login-number", kind: "login", variant: "number", source: "synthetic" },
  { id: "login-pin", kind: "login", variant: "pin", source: "synthetic" },
  { id: "login-name-search", kind: "login", variant: "name-search", source: "synthetic" },
  { id: "new-shift-input", kind: "new-shift", variant: "input", source: "synthetic" },
  { id: "new-shift-found", kind: "new-shift", variant: "found", source: "synthetic" },
  {
    id: "new-shift-not-found",
    kind: "new-shift",
    variant: "not-found",
    source: "synthetic",
  },
  { id: "new-shift-template", kind: "new-shift", variant: "template", source: "synthetic" },
  { id: "shift-loading", kind: "shift", variant: "loading", source: "synthetic" },
  { id: "shift-read-error", kind: "shift", variant: "read-error", source: "synthetic" },
  { id: "shift-empty", kind: "shift", variant: "empty", source: "synthetic" },
  { id: "shift-page-1", kind: "shift", variant: "1", source: "synthetic" },
  { id: "shift-page-2", kind: "shift", variant: "2", source: "synthetic" },
  { id: "work-validation", kind: "work", variant: "validation", source: "synthetic" },
  { id: "work-aggregation", kind: "work", variant: "aggregation", source: "synthetic" },
  {
    id: "work-aggregation-waiting",
    kind: "work",
    variant: "aggregation-waiting",
    source: "synthetic",
  },
  {
    id: "work-exit-pending",
    kind: "work-overlay",
    variant: "exit-pending",
    source: "synthetic",
  },
  {
    id: "work-clear-confirm",
    kind: "work-overlay",
    variant: "clear-confirm",
    source: "synthetic",
  },
  // Not a "signal" fixture like duplicate/error: production never shows a
  // full-screen overlay for an accepted scan (WorkScreen.tsx's
  // publishVerdict returns early for tone "ok"). The real feedback is the
  // inline compact-success panel inside ScanResultInstrument, so this state
  // renders through the real work screen (WorkFixture) instead.
  { id: "work-ok", kind: "work", variant: "ok", source: "synthetic" },
  { id: "work-duplicate", kind: "signal", variant: "duplicate", source: "synthetic" },
  { id: "work-error", kind: "signal", variant: "error", source: "synthetic" },
  { id: "box-empty", kind: "box", variant: "empty", source: "synthetic" },
  { id: "box-full", kind: "box", variant: "full", source: "synthetic" },
  {
    id: "box-print-template-missing",
    kind: "box-print-recovery",
    variant: "template_missing",
    source: "synthetic",
  },
  {
    id: "box-print-printer-unconfigured",
    kind: "box-print-recovery",
    variant: "printer_unconfigured",
    source: "synthetic",
  },
  {
    id: "box-print-render-failed",
    kind: "box-print-recovery",
    variant: "render_failed",
    source: "synthetic",
  },
  {
    id: "box-print-transport-failed",
    kind: "box-print-recovery",
    variant: "transport_failed",
    source: "synthetic",
  },
  {
    id: "box-print-skip-confirm",
    kind: "box-print-recovery",
    variant: "skip-confirm",
    source: "synthetic",
  },
  {
    id: "serial-exhaustion",
    kind: "serial-recovery",
    variant: "exhausted",
    source: "synthetic",
  },
  { id: "exception-action", kind: "exception", variant: "action", source: "synthetic" },
  { id: "exception-target", kind: "exception", variant: "target", source: "synthetic" },
  { id: "exception-reason", kind: "exception", variant: "reason", source: "synthetic" },
  { id: "exception-confirm", kind: "exception", variant: "confirm", source: "synthetic" },
  { id: "exception-applying", kind: "exception", variant: "applying", source: "synthetic" },
  { id: "exception-result", kind: "exception", variant: "result", source: "synthetic" },
  { id: "conflicts-loading", kind: "conflicts", variant: "loading", source: "synthetic" },
  {
    id: "conflicts-read-error",
    kind: "conflicts",
    variant: "read-error",
    source: "synthetic",
  },
  { id: "conflicts-empty", kind: "conflicts", variant: "empty", source: "synthetic" },
  { id: "conflicts-page-1", kind: "conflicts", variant: "1", source: "synthetic" },
  { id: "conflicts-page-2", kind: "conflicts", variant: "2", source: "synthetic" },
  { id: "setup-scanner", kind: "setup", variant: "scanner", source: "synthetic" },
  { id: "setup-printer", kind: "setup", variant: "printer", source: "synthetic" },
  { id: "setup-sound", kind: "setup", variant: "sound", source: "synthetic" },
  { id: "offline", kind: "sync", variant: "offline", source: "synthetic" },
  { id: "sync-stuck", kind: "sync", variant: "stuck", source: "synthetic" },
  { id: "update-current", kind: "updates", variant: "current", source: "synthetic" },
  { id: "update-info", kind: "updates", variant: "info", source: "synthetic" },
  { id: "update-warn", kind: "updates", variant: "warn", source: "synthetic" },
  { id: "update-urgent", kind: "updates", variant: "urgent", source: "synthetic" },
  { id: "update-error", kind: "updates", variant: "error", source: "synthetic" },
  { id: "update-active-shift", kind: "updates", variant: "active-shift", source: "synthetic" },
  {
    id: "floor-header-actions",
    kind: "floor-header",
    variant: "actions",
    source: "synthetic",
  },
  {
    id: "floor-header-window-error",
    kind: "floor-header",
    variant: "window-error",
    source: "synthetic",
  },
  { id: "print-verification", kind: "print", variant: "waiting", source: "synthetic" },
  { id: "print-mismatch", kind: "print", variant: "mismatch", source: "synthetic" },
  { id: "print-not-sscc", kind: "print", variant: "not-sscc", source: "synthetic" },
  { id: "long-copy-ru", kind: "long-copy", variant: "ru", source: "synthetic" },
  { id: "long-copy-en", kind: "long-copy", variant: "en", source: "synthetic" },
  ...INVENTORY_GALLERY_STATE_IDS.map((id) => ({
    id,
    kind: "inventory" as const,
    variant: id.replace("inventory-", ""),
    source: "synthetic" as const,
  })),
];

const FIXTURE_IDS = new Set<GalleryStateId>(EXPECTED_GALLERY_STATE_IDS);

export function findMissingGalleryStates(
  fixtures: readonly Pick<GalleryFixture, "id">[],
  expected: readonly GalleryStateId[] = EXPECTED_GALLERY_STATE_IDS,
): GalleryStateId[] {
  const present = new Set(fixtures.map((fixture) => fixture.id));
  return expected.filter((id) => !present.has(id));
}

export function getGalleryFixture(id: GalleryStateId): GalleryFixture {
  const fixture = GALLERY_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Missing gallery fixture: ${id}`);
  return fixture;
}

/** Pure selection seam: the caller must pass Vite's DEV flag explicitly. */
export function resolveGalleryRequest(
  isDevelopment: boolean,
  search: string,
): GalleryRequest | null {
  if (!isDevelopment) return null;
  const params = new URLSearchParams(search);
  if (params.get("gallery") !== "1") return null;

  const requestedState = params.get("state");
  const state =
    requestedState !== null && FIXTURE_IDS.has(requestedState as GalleryStateId)
      ? (requestedState as GalleryStateId)
      : "pairing-waiting";
  const locale: GalleryLocale = params.get("locale") === "en" ? "en" : "ru";
  return { state, locale };
}
