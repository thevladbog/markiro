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

/**
 * The work screen of a shift. Plan 2a5 shows the shift and the way back to
 * the list; plan 2a6 replaces the body with scanning and boxes.
 */
export function WorkScreen({ shift, leaving, onLeave }: WorkScreenProps) {
  const { t } = useTranslation();
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
          <Button size="floor" variant="secondary" disabled={leaving} onClick={onLeave}>
            {t("floor.work.leave")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
