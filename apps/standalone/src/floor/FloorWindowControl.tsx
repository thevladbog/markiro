import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import type { LockdownSnapshot } from "../app/lockdown.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { Reconfirm } from "./Reconfirm.js";
import type { ScanSource } from "./scan-source.js";

/** The window mode the floor can change (`createLockdownLifecycle`). */
export interface FloorWindowMode {
  /**
   * `kiosk` (the default): the shell's kiosk mode of a station, left only after a fresh proof
   * of identity. `fullscreen`: the plain full-screen window of a PC that is never locked (the
   * host's), where `snapshot.mode === "locked"` reads «in full screen»; nothing is locked, so
   * leaving needs no proof (and Esc leaves it as well).
   */
  kind?: "kiosk" | "fullscreen";
  snapshot: LockdownSnapshot;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  clearError: () => void;
}

export interface FloorWindowControlProps {
  windowMode: FloorWindowMode;
  local: LocalExecutor;
  pairing: Pairing;
  /** The unmuted scan source and the mute of the floor's screens, for the badge. */
  source: ScanSource;
  onMute: (muted: boolean) => void;
  /** The operator signed in (their own proof is required), or `null` on the sign-in screen. */
  operatorId: string | null;
  now?: () => number;
}

/**
 * «Оконный режим» / «Полноэкранный режим» in the status bar's rail, after the
 * cloud station's `WindowModeControl` (apps/station/src/ui/WindowModeControl.tsx,
 * compact): a 64 px icon button whose name says what it does. Leaving the
 * full-screen mode asks for a fresh proof of identity first (`Reconfirm`: the
 * operator's badge, or number and PIN; owner decision, beta 3), so a stray
 * touch cannot do it; the way back needs none. On the host's PC, which is never
 * locked, the same control is the plain full-screen window and asks for no proof
 * (`kind: "fullscreen"`). An office administrator's
 * sign-in on this PC opens an ordinary window by itself, as before.
 */
export function FloorWindowControl({
  windowMode,
  local,
  pairing,
  source,
  onMute,
  operatorId,
  now,
}: FloorWindowControlProps) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const { snapshot } = windowMode;
  const locked = snapshot.mode === "locked";
  const plain = windowMode.kind === "fullscreen";
  const words = plain ? "floor.windowMode.fullscreen" : "floor.windowMode";
  const label = snapshot.pending
    ? t("floor.windowMode.pending")
    : t(locked ? `${words}.exitLabel` : `${words}.enterLabel`);
  return (
    <div className="floor-window-control">
      <Button
        type="button"
        size="floor"
        variant="secondary"
        className="station-rail-button station-rail-button--icon floor-window-control__button"
        aria-label={label}
        title={t(locked ? `${words}.exit` : `${words}.enter`)}
        disabled={snapshot.pending}
        onClick={() => {
          windowMode.clearError();
          if (locked && !plain) setAsking(true);
          else if (locked) void windowMode.exit();
          else void windowMode.enter();
        }}
        icon={
          <span
            className={`floor-window-control__glyph floor-window-control__glyph--${snapshot.mode}`}
            aria-hidden="true"
          />
        }
      />
      {snapshot.error !== null && (
        <div className="floor-window-control__error" role="alert">
          <span>{t(snapshot.error === "exit" ? `${words}.exitError` : `${words}.enterError`)}</span>
          <Button size="floor" variant="secondary" onClick={windowMode.clearError}>
            {t("floor.windowMode.dismiss")}
          </Button>
        </div>
      )}
      <Reconfirm
        open={asking && locked && !plain}
        title={t("floor.windowMode.confirmTitle")}
        detail={t("floor.windowMode.confirmDetail")}
        confirmLabel={t("floor.windowMode.confirm")}
        local={local}
        pairing={pairing}
        source={source}
        onMute={onMute}
        expectedOperatorId={operatorId}
        {...(now === undefined ? {} : { now })}
        onCancel={() => setAsking(false)}
        onConfirmed={() => {
          setAsking(false);
          void windowMode.exit();
        }}
      />
    </div>
  );
}
