import { useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@markiro/ui";

import { alertFailure, type AlertFailure } from "./form-errors.js";
import { FormDialog } from "./FormDialog.js";
import { useOfficeMutation } from "./office-query.js";
import { useOfficeSession } from "./office-session.js";
import { WriteFailureAlert } from "./page-state.js";
import { OfficeIcon } from "./OfficeIcon.js";
import { useWindowMode } from "./window-mode.js";

/**
 * «Оконный режим» in the office header (plan 1f2): the administrator's way
 * out of kiosk mode, so the station's PC can be serviced. Shown only to an
 * administrator while the window is locked; the technologist and the floor
 * never see it. Before the window changes, the user is read again from the
 * host (`GET /v1/office/me`): a role taken away meanwhile does not open the
 * window. Leaving the office brings kiosk mode back (`App`). Once the window
 * is an ordinary one this button is gone, and with it the focus it held:
 * `onLeft` hands the focus to the office page.
 */
export function WindowModeButton({ onLeft }: { onLeft: () => void }) {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const windowMode = useWindowMode();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const whoAmI = useOfficeMutation((api, token, _variables: void) => api.officeMe(token));

  if (windowMode === null || session.user.role !== "admin" || windowMode.mode !== "locked") {
    return null;
  }

  const submit = async () => {
    setFailure(null);
    let role: string;
    try {
      role = (await whoAmI.mutateAsync()).role;
    } catch (error) {
      setFailure(alertFailure(error));
      return;
    }
    if (role !== "admin") {
      setFailure({ kind: "alert", message: "office.windowMode.notAdmin" });
      // The menu and the header follow the role the host has now.
      void session.refreshUser().catch(() => undefined);
      return;
    }
    if (await windowMode.leave()) {
      onLeft();
      setOpen(false);
      return;
    }
    setFailure({ kind: "alert", message: "office.windowMode.failed" });
  };

  return (
    <>
      <IconButton
        variant="secondary"
        icon={<OfficeIcon name="window" />}
        aria-label={t("office.windowMode.open")}
        title={t("office.windowMode.open")}
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      />
      {open && (
        <FormDialog
          title={t("office.windowMode.title")}
          submitLabel={t("office.windowMode.submit")}
          onSubmit={submit}
          onClose={() => setOpen(false)}
          alert={<WriteFailureAlert failure={failure} />}
        >
          <p>{t("office.windowMode.body")}</p>
        </FormDialog>
      )}
    </>
  );
}
