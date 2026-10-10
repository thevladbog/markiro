import { useTranslation } from "react-i18next";

import { Alert, VisuallyHidden } from "@markiro/ui";

import type { BackupState } from "../../host/backups.js";
import { backupWarnings, warningText, warningTone, warningToneKey } from "./backup-warnings.js";

export interface BackupWarningsProps {
  state: BackupState;
  /** Writes an instant the host reported, in the organization's zone. */
  format: (instant: string) => string;
}

/**
 * The warnings of `state`, one alert each; nothing when all is well. They
 * live inside a polite region their caller keeps on the screen, so each is
 * heard once when it arrives; they lose their own `alert` role (`presentation`)
 * for that reason, and a hidden word names the tone a screen reader cannot see.
 */
export function BackupWarnings({ state, format }: BackupWarningsProps) {
  const { t } = useTranslation();
  return (
    <>
      {backupWarnings(state).map((warning) => {
        const text = warningText(warning, format);
        const values = {
          ...text.values,
          ...(text.reason === undefined ? {} : { reason: t(text.reason) }),
        };
        return (
          <Alert key={warning.kind} tone={warningTone(warning)} role="presentation">
            <VisuallyHidden>{t(warningToneKey(warning))}</VisuallyHidden> {t(text.key, values)}
          </Alert>
        );
      })}
    </>
  );
}
