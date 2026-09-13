import type { LocalDecision } from "@markiro/domain";
import { Alert, Button, Modal } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type { GrantDenied } from "../grants/admission.js";
/** Only an actual strict owner denial opens this message. Observe diagnostics stay non-blocking. */
export function GrantNotice({
  reason,
  onClose,
}: {
  reason: GrantDenied["reason"] | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={reason !== null}
      width={520}
      title={t("grantBlocked.title")}
      footer={
        <Button className="kiosk-control" size="floor" onClick={onClose}>
          {t("grantBlocked.close")}
        </Button>
      }
    >
      {reason === "clock_untrusted" ? <p>{t("grantBlocked.clock")}</p> : null}
      <p>{t("grantBlocked.body")}</p>
    </Modal>
  );
}

export function GrantDiagnostic({
  status,
}: {
  status: { mode: "observe" | "strict"; decision: LocalDecision } | null;
}) {
  const { t } = useTranslation();
  if (!status || status.decision.allow) return null;
  return (
    <div role="status" style={{ padding: "var(--sp-3) var(--sp-6)" }}>
      <Alert tone="warn">
        <p>{t(status.mode === "observe" ? "grantBlocked.observe" : "grantBlocked.title")}</p>
        {status.mode === "strict" ? (
          <p>
            {t(
              status.decision.reason === "clock_untrusted"
                ? "grantBlocked.clock"
                : "grantBlocked.body",
            )}
          </p>
        ) : null}
      </Alert>
    </div>
  );
}
