import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { FullScreenDialog } from "@markiro/ui";
import type { SqlExecutor } from "../lib/mirror.js";
import type { ScanSource } from "../lib/scan-source.js";
import type { FloorWorkBarrier } from "../lib/credential-recovery.js";
import {
  useProductLabelWork,
  type ProductLabelWorkEnvironment,
} from "../lib/use-product-label-work.js";
import { ProductLabelVerification } from "../ui/work/ProductLabelVerification.js";

/** Owns only a saved print. No shift entry, ordinary scan queue or allocating bundle is mounted. */
export function SavedProductLabelRecovery(props: {
  exec: SqlExecutor;
  shiftId: string;
  jobId: string;
  operatorId: string;
  source: ScanSource;
  environment: ProductLabelWorkEnvironment;
  register: (barrier: FloorWorkBarrier) => () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const labels = useProductLabelWork({
    ...props,
    terminalId: props.environment.deviceId,
    recoveryJobId: props.jobId,
  });
  const work = labels.work;
  useEffect(() => {
    let active = true;
    const stop = props.source.start((raw) => {
      if (active && work) void work.verify(raw);
    });
    return () => {
      active = false;
      stop();
    };
  }, [props.source, work]);
  const close = () => {
    void (work?.close() ?? Promise.resolve()).then(props.onClose);
  };
  if (labels.loading || labels.error || !work || labels.state.job?.status === "completed")
    return (
      <FullScreenDialog
        open
        title={t(
          labels.loading
            ? "productLabels.restoring"
            : labels.error || !work
              ? "productLabels.storageError"
              : "productLabels.verified",
        )}
        backLabel={t("productLabels.pause")}
        backPlacement="footer"
        onClose={close}
      />
    );
  return <ProductLabelVerification state={labels.state} work={work} onPause={close} recovery />;
}
