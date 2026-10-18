import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import { UpdateError, type UpdateErrorCode } from "../../update/updates-api.js";
import { useUpdates } from "../../update/updates-context.js";
import { officeKeys } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";

type Stage =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; version: string }
  | { kind: "failed"; code: UpdateErrorCode };

/**
 * «Загрузить пакет на хост» (spec §10.11.2) beside a package found on this
 * PC: the shell sends the manifest and streams the installer with the
 * office session; the host keeps it as waiting. Administrators only.
 */
export function StageToHostButton({ manifestPath }: { manifestPath: string }) {
  const { t } = useTranslation();
  const { user, call } = useOfficeSession();
  const updates = useUpdates();
  const queryClient = useQueryClient();
  const [state, setState] = useState<Stage>({ kind: "idle" });
  if (user.role !== "admin") return null;
  const stage = async () => {
    setState({ kind: "busy" });
    try {
      const staged = await call((token) => updates.stage(manifestPath, token));
      setState({ kind: "done", version: staged.version });
      await queryClient.invalidateQueries({ queryKey: officeKeys.updateStatus });
    } catch (error) {
      setState({ kind: "failed", code: error instanceof UpdateError ? error.code : "refused" });
    }
  };
  return (
    <div className="update-stage">
      <Button variant="secondary" loading={state.kind === "busy"} onClick={() => void stage()}>
        {t("office.about.update.stage.button")}
      </Button>
      <div aria-live="polite">
        {state.kind === "done" && (
          <Alert tone="ok">{t("office.about.update.stage.done", { version: state.version })}</Alert>
        )}
        {state.kind === "failed" && <Alert tone="error">{t(`update.errors.${state.code}`)}</Alert>}
      </div>
    </div>
  );
}
