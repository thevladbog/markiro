import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, FullScreenDialog } from "@markiro/ui";
import { listPalletBoxes, type PalletBoxSummary } from "../lib/pallets.js";
import type { SqlExecutor } from "../lib/mirror.js";

export function PalletContents({
  exec,
  shiftId,
  terminalId,
  palletId,
  waitForIdle,
  onClose,
}: {
  exec: SqlExecutor;
  shiftId: string;
  terminalId: string | null;
  palletId: string;
  waitForIdle: () => Promise<void>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [boxes, setBoxes] = useState<PalletBoxSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setBoxes(null);
    setError(false);
    void waitForIdle()
      .then(() => listPalletBoxes(exec, shiftId, terminalId, palletId))
      .then((rows) => {
        if (active) setBoxes(rows);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [exec, shiftId, terminalId, palletId, waitForIdle, revision]);
  return (
    <FullScreenDialog
      open
      title={t("pallet.contents")}
      backLabel={t("pallet.backToAssembly")}
      backPlacement="footer"
      onClose={onClose}
      initialFocus="dialog"
    >
      <div className="pallet-contents" role="region" aria-label={t("pallet.contents")} tabIndex={0}>
        {error ? (
          <>
            <Alert tone="error" title={t("pallet.contentsError")} />
            <Button size="floor" onClick={() => setRevision((value) => value + 1)}>
              {t("productLabels.retry")}
            </Button>
          </>
        ) : boxes === null ? (
          <p role="status">{t("pallet.contentsLoading")}</p>
        ) : boxes.length === 0 ? (
          <p>{t("pallet.contentsEmpty")}</p>
        ) : (
          <table>
            <caption>{t("pallet.boxCount", { count: boxes.length })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("pallet.boxSscc")}</th>
                <th scope="col">{t("pallet.boxClosedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((box) => (
                <tr key={box.boxId}>
                  <td>
                    <code>{box.sscc}</code>
                  </td>
                  <td>
                    <time dateTime={box.closedAt}>
                      {new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: "short",
                        timeStyle: "medium",
                      }).format(new Date(box.closedAt))}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </FullScreenDialog>
  );
}
