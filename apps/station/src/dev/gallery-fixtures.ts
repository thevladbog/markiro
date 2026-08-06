export const EXPECTED_GALLERY_STATE_IDS = [
  "pairing-waiting",
  "pairing-error",
  "pairing-success",
  "pairing-recovery",
  "login-badge",
  "login-number",
  "login-pin",
  "login-name-search",
  "shift-page-1",
  "shift-page-2",
  "work-validation",
  "work-aggregation",
  "work-ok",
  "work-duplicate",
  "work-error",
  "box-empty",
  "box-full",
  "exception-action",
  "exception-target",
  "exception-reason",
  "exception-confirm",
  "exception-result",
  "conflicts-page-1",
  "conflicts-page-2",
  "setup-scanner",
  "setup-printer",
  "setup-sound",
  "offline",
  "sync-stuck",
  "print-verification",
  "long-copy-ru",
  "long-copy-en",
] as const;

export type GalleryStateId = (typeof EXPECTED_GALLERY_STATE_IDS)[number];
export type GalleryLocale = "ru" | "en";

export interface GalleryRequest {
  state: GalleryStateId;
  locale: GalleryLocale;
}

export type GalleryFixtureKind =
  | "pairing"
  | "login"
  | "shift"
  | "work"
  | "signal"
  | "box"
  | "exception"
  | "conflicts"
  | "setup"
  | "sync"
  | "print"
  | "long-copy";

export interface GalleryFixture {
  id: GalleryStateId;
  kind: GalleryFixtureKind;
  variant: string;
  /** Gallery fixtures are never hydrated from a production persistence path. */
  source: "synthetic";
}

export const GALLERY_FIXTURES: readonly GalleryFixture[] = [
  { id: "pairing-waiting", kind: "pairing", variant: "waiting", source: "synthetic" },
  { id: "pairing-error", kind: "pairing", variant: "error", source: "synthetic" },
  { id: "pairing-success", kind: "pairing", variant: "success", source: "synthetic" },
  { id: "pairing-recovery", kind: "pairing", variant: "recovery", source: "synthetic" },
  { id: "login-badge", kind: "login", variant: "badge", source: "synthetic" },
  { id: "login-number", kind: "login", variant: "number", source: "synthetic" },
  { id: "login-pin", kind: "login", variant: "pin", source: "synthetic" },
  { id: "login-name-search", kind: "login", variant: "name-search", source: "synthetic" },
  { id: "shift-page-1", kind: "shift", variant: "1", source: "synthetic" },
  { id: "shift-page-2", kind: "shift", variant: "2", source: "synthetic" },
  { id: "work-validation", kind: "work", variant: "validation", source: "synthetic" },
  { id: "work-aggregation", kind: "work", variant: "aggregation", source: "synthetic" },
  { id: "work-ok", kind: "signal", variant: "ok", source: "synthetic" },
  { id: "work-duplicate", kind: "signal", variant: "duplicate", source: "synthetic" },
  { id: "work-error", kind: "signal", variant: "error", source: "synthetic" },
  { id: "box-empty", kind: "box", variant: "empty", source: "synthetic" },
  { id: "box-full", kind: "box", variant: "full", source: "synthetic" },
  { id: "exception-action", kind: "exception", variant: "action", source: "synthetic" },
  { id: "exception-target", kind: "exception", variant: "target", source: "synthetic" },
  { id: "exception-reason", kind: "exception", variant: "reason", source: "synthetic" },
  { id: "exception-confirm", kind: "exception", variant: "confirm", source: "synthetic" },
  { id: "exception-result", kind: "exception", variant: "result", source: "synthetic" },
  { id: "conflicts-page-1", kind: "conflicts", variant: "1", source: "synthetic" },
  { id: "conflicts-page-2", kind: "conflicts", variant: "2", source: "synthetic" },
  { id: "setup-scanner", kind: "setup", variant: "scanner", source: "synthetic" },
  { id: "setup-printer", kind: "setup", variant: "printer", source: "synthetic" },
  { id: "setup-sound", kind: "setup", variant: "sound", source: "synthetic" },
  { id: "offline", kind: "sync", variant: "offline", source: "synthetic" },
  { id: "sync-stuck", kind: "sync", variant: "stuck", source: "synthetic" },
  { id: "print-verification", kind: "print", variant: "waiting", source: "synthetic" },
  { id: "long-copy-ru", kind: "long-copy", variant: "ru", source: "synthetic" },
  { id: "long-copy-en", kind: "long-copy", variant: "en", source: "synthetic" },
];

const FIXTURE_IDS = new Set<GalleryStateId>(EXPECTED_GALLERY_STATE_IDS);

export function findMissingGalleryStates(
  fixtures: readonly Pick<GalleryFixture, "id">[],
): GalleryStateId[] {
  const present = new Set(fixtures.map((fixture) => fixture.id));
  return EXPECTED_GALLERY_STATE_IDS.filter((id) => !present.has(id));
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
      : EXPECTED_GALLERY_STATE_IDS[0];
  const locale: GalleryLocale = params.get("locale") === "en" ? "en" : "ru";
  return { state, locale };
}
