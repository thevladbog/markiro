import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import type { ReceivingBasis, TraceabilityLot } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import { Pager, type MasterDataViewProps } from "../master-data/workspace-shared.js";
import { isReceivingFrozenView, type ReceivingFrozenView } from "../receiving/live-record.js";

export function LotReceivingBasis({
  value,
  disabled,
  onOpenReceiving,
  onPage,
}: {
  value: ReceivingBasis;
  disabled: boolean;
  onOpenReceiving: (eventId: string) => void;
  onPage: (offset: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p role="status">
        {value.state === "missing"
          ? t("lots.receivingMissing")
          : t("lots.receivingCount", { count: value.supportCount })}
      </p>
      {value.items.length ? (
        <ul className="us-lot-basis-list">
          {value.items.map((item) => (
            <li key={item.eventId}>
              <Button
                type="button"
                variant="secondary"
                disabled={disabled}
                onClick={() => onOpenReceiving(item.eventId)}
              >
                {item.eventNumber} · {t("receiving.revision")} {item.revision}
              </Button>
              <span>{t("lots.receivingLines", { lines: item.lineNos.join(", ") })}</span>
            </li>
          ))}
        </ul>
      ) : value.state === "present" ? (
        <p>{t("lots.receivingEmptyPage")}</p>
      ) : null}
      {value.offset > 0 || value.hasMore ? (
        <Pager
          page={value.offset / value.limit + 1}
          hasPrevious={value.offset > 0}
          hasNext={value.hasMore && value.offset + value.limit <= 100000}
          disabled={disabled}
          onPrevious={() => onPage(Math.max(0, value.offset - value.limit))}
          onNext={() => onPage(value.offset + value.limit)}
        />
      ) : null}
    </>
  );
}

/** Fresh support queries are independent of lot status and historical creation bindings. */
export function LotReceivingBasisSection({
  lot,
  onOpenReceiving,
  ...props
}: MasterDataViewProps & {
  lot: TraceabilityLot;
  onOpenReceiving: (record: ReceivingFrozenView) => void;
}) {
  const { client, mutationPending, beginMutation, onSessionLost, onForbidden } = props;
  const { t } = useTranslation();
  const titleId = useId();
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [value, setValue] = useState<ReceivingBasis | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(true);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const openRun = useRef(0);
  const busy = useRef(false);
  useEffect(
    () => () => {
      openRun.current += 1;
    },
    [],
  );
  useEffect(() => {
    let active = true;
    setPending(true);
    setFailed(false);
    setValue(null);
    setOpenFailed(false);
    void client
      .getLotReceivingBasis(lot.id, { limit: 50, offset })
      .then((result) => {
        if (active) setValue(result);
      })
      .catch(async (error: unknown) => {
        if (!active) return;
        setFailed(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [client, lot, offset, refresh, onSessionLost, onForbidden]);

  async function open(eventId: string) {
    const entry = value?.items.find((item) => item.eventId === eventId);
    if (!entry || pending || mutationPending || busy.current) return;
    busy.current = true;
    const run = ++openRun.current;
    const release = beginMutation();
    setOpening(true);
    setOpenFailed(false);
    try {
      const record = await client.getReceivingRecord(eventId);
      if (run !== openRun.current) return;
      // A basis may change after it was read: show that exact frozen revision, never redirect.
      if (
        !isReceivingFrozenView(record) ||
        record.lifecycle.rootId.toLowerCase() !== entry.rootId.toLowerCase() ||
        record.revision !== entry.revision ||
        record.eventNumber !== entry.eventNumber ||
        !entry.lineNos.every((lineNo) =>
          record.content.snapshot.items.some(
            (item) => item.lineNo === lineNo && item.lotId.toLowerCase() === lot.id.toLowerCase(),
          ),
        )
      )
        throw new UsClientError("invalid_response");
      onOpenReceiving(record);
    } catch (error) {
      if (run !== openRun.current) return;
      setOpenFailed(true);
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
    } finally {
      release();
      busy.current = false;
      if (run === openRun.current) setOpening(false);
    }
  }
  return (
    <section
      className="us-lot-panel us-lot-basis"
      aria-labelledby={titleId}
      aria-busy={pending || opening}
    >
      <div className="us-lot-basis-header">
        <h2 id={titleId}>{t("lots.receivingBasis")}</h2>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || mutationPending || opening}
          onClick={() => {
            setOffset(0);
            setRefresh((n) => n + 1);
          }}
        >
          {t("lots.receivingRefresh")}
        </Button>
      </div>
      <p className="us-lot-note">{t("lots.receivingHint")}</p>
      {pending ? (
        <p role="status">{t("lots.receivingLoading")}</p>
      ) : failed ? (
        <p role="alert">{t("lots.receivingError")}</p>
      ) : value ? (
        <LotReceivingBasis
          value={value}
          disabled={mutationPending || opening}
          onOpenReceiving={(id) => void open(id)}
          onPage={setOffset}
        />
      ) : null}
      {opening ? <p role="status">{t("lots.receivingOpening")}</p> : null}
      {openFailed ? <p role="alert">{t("lots.receivingOpenError")}</p> : null}
    </section>
  );
}
