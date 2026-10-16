import { useTranslation } from "react-i18next";

import { useTheme, type Theme } from "@markiro/ui";

import { ModeSegment } from "../kit/ModeSegment.js";
import { UnpairStation } from "./UnpairStation.js";
import { useUnpair } from "./unpair-context.js";

export interface VolumeScaleProps {
  /** Filled divisions, 0–10. */
  filled: number;
  /** The tones are off: the scale is `dis`, whatever the level was. */
  silent: boolean;
}

/**
 * The ten divisions of the volume (kit: occupied `fg`, free `panel`). The scale only draws; the
 * number beside it and the words under it say the same, so the level is never only a colour.
 */
export function VolumeScale({ filled, silent }: VolumeScaleProps) {
  return (
    <div className="setup-volume__scale" aria-hidden="true" data-silent={silent ? "true" : "false"}>
      {Array.from({ length: 10 }, (_, index) => (
        <span
          key={index}
          className="setup-volume__division"
          data-filled={index < filled ? "true" : "false"}
        />
      ))}
    </div>
  );
}

const THEMES: readonly Theme[] = ["system", "light", "dark"];

export interface StationFacts {
  /** The name the host keeps for this station. */
  name: string | null;
  /** The device id, shortened for the eye. */
  device: string;
  /** The host's address. */
  host: string;
}

/** `dev-7f3a…c21`: the head and the tail of an id, which is how a person tells two devices apart. */
export function shortId(id: string): string {
  return id.length <= 13 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export interface StationPanelProps {
  facts: StationFacts | null;
}

/**
 * «Станция»: what this station is (its name, its device, its host), the floor's theme (the
 * provider's own choice, stored where the floor's theme already lives, «Системная» by default),
 * and the unpairing, which has its own tab so it is never next to «Сохранить».
 */
export function StationPanel({ facts }: StationPanelProps) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const unpair = useUnpair();
  const rows: { label: string; value: string; mono: boolean }[] =
    facts === null
      ? []
      : [
          ...(facts.name === null
            ? []
            : [{ label: t("floor.setup.station.name"), value: facts.name, mono: false }]),
          { label: t("floor.setup.station.device"), value: facts.device, mono: true },
          { label: t("floor.setup.station.host"), value: facts.host, mono: true },
        ];
  return (
    <div className="setup-station">
      <section className="setup-station__facts" aria-labelledby="setup-station-title">
        <h2 id="setup-station-title" className="setup-card__title">
          {t("floor.setup.station.title")}
        </h2>
        {rows.length > 0 && (
          <dl className="setup-station__list">
            {rows.map((row) => (
              <div key={row.label} className="setup-station__row">
                <dt>{row.label}</dt>
                <dd className={row.mono ? "setup-station__mono" : undefined}>{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <ModeSegment
          label={`${t("floor.setup.station.theme")} · ${t("floor.setup.station.themeDefault")}`}
          options={THEMES.map((value) => ({
            value,
            label: t(`floor.setup.station.themes.${value}`),
          }))}
          value={theme}
          onChange={setTheme}
          reserveHint={false}
        />
      </section>
      {unpair !== null && (
        <section className="setup-station__unpair" aria-labelledby="setup-unpair-title">
          <h2 id="setup-unpair-title" className="setup-card__title">
            {t("floor.setup.station.unpairTitle")}
          </h2>
          <p className="setup-card__hint">{t("floor.setup.station.unpairBody")}</p>
          <div>
            <UnpairStation />
          </div>
        </section>
      )}
    </div>
  );
}
