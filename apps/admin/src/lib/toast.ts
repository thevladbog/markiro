/**
 * Thin wrapper over `@markiro/ui`'s imperative `toast()` helper that supplies
 * a translated dismiss-button label on every call.
 *
 * `@markiro/ui` has no i18n dependency of its own (see `Toast.tsx`'s doc
 * comment), so its `dismissLabel` param defaults to the plain-English
 * "Close". `apps/admin` renders in RU by default (`i18n/index.ts`), so every
 * admin call site routes through this wrapper instead of importing `toast`
 * directly from `@markiro/ui` -- that keeps the dismiss button's aria-label
 * in the user's active language without repeating `t("common.close")` at
 * each of the ~15 call sites across the catalog/counterparties/shifts pages.
 *
 * Uses the i18next singleton (`../i18n/index.js`) rather than the
 * `useTranslation` hook because `toast()` is called imperatively from event
 * handlers, not from render -- the singleton's `t` reflects the
 * currently-active language (kept in sync by the same instance the
 * `<Trans>`/`useTranslation` consumers read from) without needing a hook.
 */
import type { ReactNode } from "react";

import { toast as uiToast } from "@markiro/ui";
import type { ToastTone } from "@markiro/ui";

import i18n from "../i18n/index.js";

export function toast(tone: ToastTone, message: ReactNode, durationMs = 4000): number {
  return uiToast(tone, message, durationMs, i18n.t("common.close"));
}
