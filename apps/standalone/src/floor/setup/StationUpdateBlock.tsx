import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import { PROTOCOL_VERSION } from "../../host/protocol.js";
import { useFloorUpdateEntry } from "../../update/floor-update-entry-context.js";
import { updateEntryState, type UpdateEntryState } from "../../update/floor-update-entry.js";
import "./station-update-block.css";

const NOTES_SHOWN = 3;

/** The words and tone of a state that is not an offer, or `null` when there is nothing to say. */
function line(
  state: UpdateEntryState,
  t: TFunction,
): { tone: "info" | "ok" | "warn"; text: string } | null {
  switch (state.kind) {
    case "latest":
      return { tone: "ok", text: t("floor.update.entry.latest") };
    case "unreachable":
      return { tone: "warn", text: t("floor.update.entry.unreachable") };
    case "host_older":
      return { tone: "warn", text: t("floor.update.entry.hostOlder") };
    case "intermediate":
      return { tone: "warn", text: t("floor.update.entry.intermediate", { min: state.min }) };
    case "verifying":
      return { tone: "info", text: t("floor.update.entry.verifying") };
    case "unreadable":
      return { tone: "warn", text: t("floor.update.entry.unreadable") };
    case "no_package":
      return { tone: "warn", text: t("floor.update.entry.noPackage") };
    default:
      return null;
  }
}

/**
 * «Станция → Версия программы»: this build's version, a «Проверить обновление» that asks the host
 * for its offer now, and, when there is one, «Обновить» (the «С хоста» dialog). The update comes
 * from the host PC, so an unreachable host is said in words. During a shift the install is held
 * back, as everywhere on the floor: the offer is told, the button is not drawn.
 */
export function StationUpdateBlock() {
  const { t } = useTranslation();
  const entry = useFloorUpdateEntry();
  if (entry === null) return null;
  const state = updateEntryState({
    offer: entry.offer,
    reachable: entry.reachable,
    checking: entry.checking,
    checked: entry.checked,
    inShift: entry.inShift,
  });
  const said = line(state, t);
  const notes = state.kind === "available" ? state.notes.slice(0, NOTES_SHOWN) : [];
  return (
    <section className="setup-station__update" aria-labelledby="setup-update-title">
      <h2 id="setup-update-title" className="setup-card__title">
        {t("floor.update.entry.title")}
      </h2>
      <p className="setup-station__version">
        {entry.appVersion === null
          ? t("floor.update.entry.versionUnknown", { protocol: PROTOCOL_VERSION })
          : t("floor.update.entry.version", {
              version: entry.appVersion,
              protocol: PROTOCOL_VERSION,
            })}
      </p>
      <div aria-live="polite" className="setup-station__update-state">
        {state.kind === "checking" && (
          <p className="setup-card__hint">{t("floor.update.entry.checking")}</p>
        )}
        {said !== null && <Alert tone={said.tone}>{said.text}</Alert>}
        {state.kind === "available" && (
          <div className="setup-station__offer">
            <p className="setup-station__offer-title">
              {t(
                state.required
                  ? "floor.update.entry.availableRequired"
                  : "floor.update.entry.available",
                { version: state.version },
              )}
            </p>
            {notes.length > 0 && (
              <ul className="setup-station__notes" aria-label={t("floor.update.entry.notes")}>
                {notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            )}
            {state.canInstall ? (
              <Button size="floor" className="floor-primary" onClick={entry.open}>
                {t("floor.update.entry.install")}
              </Button>
            ) : (
              <Alert tone="info">{t("floor.update.entry.inShift")}</Alert>
            )}
          </div>
        )}
      </div>
      <div>
        <Button
          size="floor"
          variant="secondary"
          loading={state.kind === "checking"}
          onClick={entry.check}
        >
          {t("floor.update.entry.check")}
        </Button>
      </div>
    </section>
  );
}
