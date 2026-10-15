import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, FullScreenDialog } from "@markiro/ui";

import { DeviceError } from "../../host/device.js";
import { Reconfirm } from "../Reconfirm.js";
import { useUnpair } from "./unpair-context.js";
import "./unpair-station.css";

type Counts = { unsent: number | null; owed: boolean };

/**
 * «Отвязать станцию» in the footer of «Рабочее место» (beta 3, owner feedback: the cloud
 * station has it, the standalone did not): the station forgets its host and
 * its copies, exactly as the shell's `device_forget` does for the screens of a
 * rejected device — the reference copies go, with the operators' PIN and badge
 * hashes, and so does the upgrade's copy of the database — and the screens
 * start from the pairing again. Three guards stand before it: no shift is
 * open, the dialog says what is lost (the records not yet sent, which stay on
 * the disk and never reach the host, and the blocks of serials a restored host
 * is still owed), and a fresh proof of identity is required (`Reconfirm`: the
 * operator's badge, or number and PIN). Nothing renders where the app gave no
 * `UnpairContext`, as on the pairing screen's scanner settings.
 */
export function UnpairStation() {
  const { t } = useTranslation();
  const api = useUnpair();
  const [step, setStep] = useState<"closed" | "ask" | "proof" | "working">("closed");
  const [counts, setCounts] = useState<Counts | "loading">("loading");
  const [failure, setFailure] = useState<string | null>(null);

  const asking = step !== "closed";
  useEffect(() => {
    if (!asking || api === null) return;
    let cancelled = false;
    setCounts("loading");
    void Promise.all([
      api.countUnsent().catch(() => null),
      api.owesBlocks().catch(() => false),
    ]).then(([unsent, owed]) => {
      if (!cancelled) setCounts({ unsent, owed });
    });
    return () => {
      cancelled = true;
    };
    // The counts are read when the dialog opens, not when the app re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking]);

  if (api === null) return null;

  const run = async () => {
    if (counts === "loading") return;
    setStep("working");
    setFailure(null);
    try {
      // Records not yet sent (or not countable) stay on the disk: the shell
      // refuses the forget without this, and counts again itself.
      await api.forget(counts.unsent !== 0);
    } catch (error) {
      setStep("ask");
      setFailure(
        error instanceof DeviceError && error.code === "storage"
          ? t("floor.unpair.storage")
          : t("floor.unpair.failed"),
      );
    }
  };

  const consequences = counts === "loading" ? null : counts;
  return (
    <>
      <Button
        size="floor"
        variant="destructive"
        className="unpair-station__button"
        title={t("floor.unpair.hint")}
        onClick={() => {
          setFailure(null);
          setStep("ask");
        }}
      >
        {t("floor.unpair.button")}
      </Button>
      <FullScreenDialog
        open={asking && step !== "proof"}
        title={t("floor.unpair.title")}
        backLabel={t("floor.unpair.cancel")}
        backDisabled={step === "working"}
        onClose={() => setStep("closed")}
        footer={
          <Button
            size="floor"
            variant="destructive"
            loading={step === "working"}
            disabled={counts === "loading" || api.inShift}
            onClick={() => setStep("proof")}
          >
            {t("floor.unpair.confirmed")}
          </Button>
        }
      >
        <div className="unpair-station__body">
          <p>{t("floor.unpair.consequences")}</p>
          {api.inShift && <Alert tone="warn">{t("floor.unpair.inShift")}</Alert>}
          {consequences === null && <p role="status">{t("floor.sync.loading")}</p>}
          {consequences !== null && consequences.unsent === null && (
            <Alert tone="warn">{t("floor.unpair.unsentUnknown")}</Alert>
          )}
          {consequences !== null && consequences.unsent !== null && consequences.unsent > 0 && (
            <Alert tone="warn">{t("floor.unpair.unsent", { n: consequences.unsent })}</Alert>
          )}
          {consequences !== null && consequences.owed && (
            <Alert tone="warn">{t("floor.unpair.owed")}</Alert>
          )}
          {step === "working" && <p role="status">{t("floor.unpair.working")}</p>}
          {failure !== null && <Alert tone="error">{failure}</Alert>}
        </div>
      </FullScreenDialog>
      <Reconfirm
        open={step === "proof"}
        title={t("floor.unpair.title")}
        detail={t("floor.unpair.reconfirmDetail")}
        confirmLabel={t("floor.unpair.confirm")}
        local={api.local}
        pairing={api.pairing}
        source={api.source}
        onMute={api.onMute}
        expectedOperatorId={api.operatorId}
        {...(api.now === undefined ? {} : { now: api.now })}
        onCancel={() => setStep("ask")}
        onConfirmed={() => {
          void run();
        }}
      />
    </>
  );
}
