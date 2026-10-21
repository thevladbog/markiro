/**
 * Where the visitor came from, remembered at the first page of the browser session
 * and sent with a lead form (spec 15.2: `first_utm`, `first_referrer`). Kept in
 * sessionStorage: it needs no consent, ends with the tab and never leaves the browser
 * except inside a form the visitor submits.
 */

export const FIRST_TOUCH_STORAGE_KEY = "markiro:first-touch";

const UTM_FIELDS = ["source", "medium", "campaign", "content", "term"] as const;
type UtmField = (typeof UTM_FIELDS)[number];

export type Utm = Partial<Record<UtmField, string>>;

export interface FirstTouch {
  readonly utm?: Utm;
  readonly referrer?: string;
}

const UTM_MAX_LENGTH = 200;
const REFERRER_MAX_LENGTH = 2048;

export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readUtm(url: URL): Utm | undefined {
  const utm: Utm = {};
  for (const field of UTM_FIELDS) {
    const value = url.searchParams.get(`utm_${field}`)?.trim() ?? "";
    if (value.length > 0) utm[field] = value.slice(0, UTM_MAX_LENGTH);
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

/** An external page only: navigation inside the site is not a source. */
function readReferrer(referrer: string, pageUrl: URL): string | undefined {
  if (referrer.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(referrer);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (parsed.host === pageUrl.host) return undefined;
  return parsed.href.slice(0, REFERRER_MAX_LENGTH);
}

export function firstTouchFrom(pageUrl: URL, referrer: string): FirstTouch {
  const utm = readUtm(pageUrl);
  const source = readReferrer(referrer, pageUrl);
  return {
    ...(utm === undefined ? {} : { utm }),
    ...(source === undefined ? {} : { referrer: source }),
  };
}

/** Records the first page of the session; later pages of the same session change nothing. */
export function captureFirstTouch(store: SessionStore, pageUrl: URL, referrer: string): void {
  try {
    if (store.getItem(FIRST_TOUCH_STORAGE_KEY) !== null) return;
    store.setItem(FIRST_TOUCH_STORAGE_KEY, JSON.stringify(firstTouchFrom(pageUrl, referrer)));
  } catch {
    // Storage may be disabled; the form then goes without a source.
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function readFirstTouch(store: SessionStore): FirstTouch {
  let raw: string | null;
  try {
    raw = store.getItem(FIRST_TOUCH_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;

  const utm: Utm = {};
  if (typeof record.utm === "object" && record.utm !== null) {
    const source = record.utm as Record<string, unknown>;
    for (const field of UTM_FIELDS) {
      const value = source[field];
      if (isString(value)) utm[field] = value.slice(0, UTM_MAX_LENGTH);
    }
  }
  const referrer = isString(record.referrer)
    ? record.referrer.slice(0, REFERRER_MAX_LENGTH)
    : undefined;
  return {
    ...(Object.keys(utm).length > 0 ? { utm } : {}),
    ...(referrer === undefined ? {} : { referrer }),
  };
}
