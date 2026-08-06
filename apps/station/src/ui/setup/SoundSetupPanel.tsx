import { useTranslation } from "react-i18next";
import { Button } from "@markiro/ui";
import type { SoundSettings } from "../../lib/signal-sound.js";
import { TouchRange } from "./TouchRange.js";

export interface SoundSetupPanelProps {
  sound: SoundSettings;
  disabled: boolean;
  onSoundChange: (sound: SoundSettings) => void;
  onTestSound: () => void;
}

export function SoundSetupPanel({
  sound,
  disabled,
  onSoundChange,
  onTestSound,
}: SoundSetupPanelProps) {
  const { t } = useTranslation();
  const testUnavailable = sound.muted || sound.volume <= 0;
  return (
    <div className="setup-panel setup-panel--sound">
      <label className="setup-touch-choice setup-touch-choice--checkbox">
        <input
          type="checkbox"
          checked={sound.muted}
          disabled={disabled}
          onChange={(event) => onSoundChange({ ...sound, muted: event.target.checked })}
        />
        <span>{t("setup.mute")}</span>
      </label>
      <TouchRange
        label={t("setup.volume")}
        value={sound.volume}
        min={0}
        max={1}
        step={0.1}
        disabled={disabled}
        onChange={(volume) => onSoundChange({ ...sound, volume })}
      />
      <Button
        size="floor"
        variant="secondary"
        disabled={disabled || testUnavailable}
        onClick={onTestSound}
      >
        {t("setup.testSound")}
      </Button>
    </div>
  );
}
