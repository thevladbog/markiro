import { useEffect, useState } from "react";
import { Button } from "@markiro/ui";
import type { ReceivingLiveRecord } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import type { MasterDataViewProps } from "../master-data/workspace-shared.js";
import { ReceivingEditor } from "./editor.js";
import {
  isReceivingDraftView,
  isReceivingFrozenView,
  type ReceivingDraftView,
  type ReceivingFrozenView,
} from "./live-record.js";

/** Reads fresh amendment and exact frozen predecessor together before mounting an editor. */
export function ReceivingAmendmentEditor(
  props: MasterDataViewProps & {
    initial: ReceivingDraftView;
    timeZone: string;
    canManageQa?: boolean;
    onClose: () => void;
    backLabel?: string;
    onOpenRecord: (record: ReceivingLiveRecord) => void;
  },
) {
  const { client, initial, onOpenRecord, onSessionLost, onForbidden } = props;
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{
    record: ReceivingDraftView;
    predecessor: ReceivingFrozenView;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    setFailed(false);
    void (async () => {
      try {
        const current = await client.getReceivingRecord(initial.id);
        if (!active) return;
        if (!isReceivingDraftView(current) || current.lifecycle.previousRevisionId === null) {
          onOpenRecord(current);
          return;
        }
        const previous = await client.getReceivingRecord(current.lifecycle.previousRevisionId);
        if (!active) return;
        if (
          !isReceivingFrozenView(previous) ||
          previous.id.toLowerCase() !== current.lifecycle.previousRevisionId.toLowerCase() ||
          previous.lifecycle.rootId.toLowerCase() !== current.lifecycle.rootId.toLowerCase() ||
          previous.eventNumber !== current.eventNumber ||
          previous.timeZone !== current.timeZone ||
          previous.revision >= current.revision ||
          (current.status === "draft" &&
            (previous.status !== "finalized" ||
              previous.lifecycle.lifecycleVersion !== current.lifecycle.lifecycleVersion ||
              previous.lifecycle.pendingDraftId?.toLowerCase() !== current.id.toLowerCase()))
        )
          throw new UsClientError("invalid_response");
        setLoaded({ record: current, predecessor: previous });
      } catch (error) {
        if (!active) return;
        setFailed(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      }
    })();
    return () => {
      active = false;
    };
  }, [client, initial, onOpenRecord, onSessionLost, onForbidden, generation]);
  if (loaded)
    return <ReceivingEditor {...props} initial={loaded.record} predecessor={loaded.predecessor} />;
  return (
    <section className="us-rec-page" aria-busy={!failed}>
      <Button type="button" variant="secondary" onClick={props.onClose}>
        {props.backLabel ?? t("receiving.back")}
      </Button>
      <h1>{initial.eventNumber}</h1>
      {failed ? (
        <div role="alert">
          <p>{t("receiving.predecessorUnavailable")}</p>
          <Button type="button" onClick={() => setGeneration((value) => value + 1)}>
            {t("receiving.reloadCurrent")}
          </Button>
        </div>
      ) : (
        <p role="status">{t("receiving.loadingPredecessor")}</p>
      )}
    </section>
  );
}
