import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Button, Card } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { WorkShift } from "../shifts/shift-copies.js";

/**
 * What the floor gives the work screen of a shift (the contract plans 2a6–2a8
 * build on): the shift with the snapshot this build read, the session, the
 * pairing whose rows it writes, the local database and the link; `track`
 * holds the leave until a piece of work settles; `touch` restarts the
 * operator's idle wait (a COM scanner presses no key); `onLeave` asks to go
 * back to the list, which the floor does once the tracked work has settled,
 * and `leaving` says it is waiting for that.
 *
 * What the screen owes the floor (plan 2a6 replaces the body of the stub and
 * keeps these; the floor cannot check them):
 *
 * - Every write to the local database, every send to the host and every job
 *   for the printer is handed to `track` BEFORE it starts, never after: the
 *   leave, a refusal of the device and a move to another line wait for it, and
 *   a piece of work started outside the gate is lost with the shift.
 * - No scan is accepted while `leaving`: a scan taken then would start work
 *   the leave no longer waits for.
 * - Tracked work is bounded, because the gate has no timeout of its own that
 *   could let the leave through in the middle of a write: a local write ends in
 *   about 35 s at the most (the busy timeout of 5 s and the wait for the pool
 *   of sqlx, 30 s), the shell's hand-over to the printer in 5 s, the check of a
 *   code at the host in 300 ms. Work that can wait longer than that must not
 *   be tracked as one piece.
 * - The way back to the list is a button that stays on the keyboard while the
 *   leave waits: `aria-disabled`, not `disabled`, which drops the focus onto
 *   the page. The waiting is said in a polite region that is on the screen
 *   before it is said.
 */
export interface WorkScreenProps {
  shift: WorkShift;
  operator: FloorSession;
  pairing: Pairing;
  local: LocalExecutor;
  online: boolean;
  track: <T>(work: Promise<T>) => Promise<T>;
  touch: () => void;
  onLeave: () => void;
  leaving: boolean;
}

const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

/**
 * The work screen of a shift. Plan 2a5 shows the shift and the way back to
 * the list; plan 2a6 replaces the body with scanning and boxes.
 */
export function WorkScreen({ shift, leaving, onLeave }: WorkScreenProps) {
  const { t } = useTranslation();
  // Looks as a button that does nothing now; still on the keyboard (see the
  // contract above), so it is `aria-disabled` and ignores the press itself.
  return (
    <Card
      className="standalone-card"
      title={t("floor.work.title", { number: shift.copy.number })}
      titleAs="h2"
    >
      <div className="standalone-form">
        <p className="shift-card__product">{shift.snapshot.product.name}</p>
        <p>{t("floor.work.stub")}</p>
        {/* Always on the screen, so that the text put into it is announced. */}
        <div aria-live="polite">{leaving && <p>{t("floor.work.leaving")}</p>}</div>
        <div className="standalone-form__actions">
          <Button
            size="floor"
            variant="secondary"
            aria-disabled={leaving ? true : undefined}
            style={leaving ? WAITING_STYLE : undefined}
            onClick={leaving ? undefined : onLeave}
          >
            {t("floor.work.leave")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
