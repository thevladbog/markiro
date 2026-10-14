import { useEffect, useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import { Alert, Button } from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import type { ShiftStatus } from "../../host/protocol.js";
import { useCan } from "../access.js";
import { useOfficeMutation } from "../office-query.js";
import { PackDraftWithoutLine, startPackDisassembly } from "./pack-disassembly.js";

interface PackDisassemblyProps {
  /** The box's or the pallet's SSCC, `null` while it has none. */
  sscc: string | null;
  closed: boolean;
  disassembled: boolean;
  shiftStatus: ShiftStatus;
}

/**
 * «Расформировать» of a card (plan КРТ, task 9): `button` goes among the
 * page's actions, `notice` under them. A box or a pallet that is closed, with
 * an SSCC and not taken apart gets the button once its shift is closed (owner
 * decision ПР-1; an active shift's line would only come back `shift_open`),
 * and a quiet line before that. The press makes a draft document with the
 * SSCC as its line and opens the document, where the reason is chosen and
 * the document applied. Administrators and technologists, as the documents.
 */
export function usePackDisassembly({
  sscc,
  closed,
  disassembled,
  shiftStatus,
}: PackDisassemblyProps): { button: ReactNode; notice: ReactNode } {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const allowed = useCan("planShifts");
  const alertId = useId();
  const start = useOfficeMutation((api, token, packSscc: string) =>
    startPackDisassembly(api, token, packSscc),
  );
  // The mutation's own pending flag reaches the button a tick late: a double click would make two drafts.
  const running = useRef(false);
  const failure = start.error;
  useEffect(() => {
    if (failure !== null) document.getElementById(alertId)?.focus();
  }, [failure, alertId]);

  const eligible = allowed && closed && !disassembled && sscc !== null;
  if (!eligible || sscc === null) return { button: null, notice: null };
  if (shiftStatus !== "closed") {
    return {
      button: null,
      notice: <p className="office-note">{t("office.packs.disassembleAfterClose")}</p>,
    };
  }
  const reason =
    failure === null
      ? ""
      : t(errorMessageKey(failure instanceof PackDraftWithoutLine ? failure.cause : failure));
  return {
    // After a draft was made without its line, a second press would make another empty one.
    button:
      failure instanceof PackDraftWithoutLine ? null : (
        <Button
          variant="secondary"
          loading={start.isPending}
          onClick={() => {
            if (running.current) return;
            running.current = true;
            start.mutate(sscc, {
              onSuccess: (document) => void navigate(`/disaggregation/${document.id}`),
              onSettled: () => {
                running.current = false;
              },
            });
          }}
        >
          {t("office.packs.disassemble")}
        </Button>
      ),
    notice:
      failure === null ? null : failure instanceof PackDraftWithoutLine ? (
        <Alert
          tone="error"
          id={alertId}
          tabIndex={-1}
          action={
            <Link
              to={`/disaggregation/${failure.document.id}`}
              aria-label={t("office.packs.documents.open", { docNo: failure.document.docNo })}
            >
              {t("office.packs.documents.open", { docNo: failure.document.docNo })}
            </Link>
          }
        >
          {t("office.packs.disassembleLineFailed", { docNo: failure.document.docNo, reason })}
        </Alert>
      ) : (
        <Alert tone="error" id={alertId} tabIndex={-1}>
          {t("office.packs.disassembleFailed", { reason })}
        </Alert>
      ),
  };
}
