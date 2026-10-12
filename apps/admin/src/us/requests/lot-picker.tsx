import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import { platformUuidSchema } from "@markiro/platform-contracts";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { getRequestCopy } from "./copy.js";

export type RequestLotPickerProps = {
  client: UsBrowserClient;
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
};
export function RequestLotPicker(props: RequestLotPickerProps) {
  const { client, value, disabled, onChange } = props;
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<{ value: string; label: string }[]>([]);
  const [selected, setSelected] = useState<{ value: string; label: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const run = useRef(0);
  const selectionRun = useRef(0);
  const reject = useCallback(async (error: unknown) => {
    if (error instanceof UsClientError && error.code === "session_required")
      callbacks.current.onSessionLost();
    else if (error instanceof UsClientError && error.code === "forbidden") {
      try {
        await callbacks.current.onForbidden();
      } catch {
        /* Owner blocks failed authority refresh. */
      }
    }
  }, []);
  useEffect(() => {
    if (disabled) return;
    const token = ++run.current;
    setPending(true);
    setFailed(false);
    void client
      .listLots({ limit: 50, offset, search })
      .then((result) => {
        if (token === run.current)
          setRows(result.items.map((lot) => ({ value: lot.id, label: `${lot.tlc} · ${lot.id}` })));
      })
      .catch(async (error: unknown) => {
        if (token !== run.current) return;
        setFailed(true);
        setRows([]);
        await reject(error);
      })
      .finally(() => {
        if (token === run.current) setPending(false);
      });
    return () => {
      run.current += 1;
    };
  }, [client, disabled, search, offset, retry, reject]);
  useEffect(() => {
    const token = ++selectionRun.current;
    setSelected(null);
    if (!value || disabled || !platformUuidSchema.safeParse(value).success) return;
    void client
      .getLot(value)
      .then((lot) => {
        if (token === selectionRun.current)
          setSelected({ value: lot.id, label: `${lot.tlc} · ${lot.id}` });
      })
      .catch(async (error: unknown) => {
        if (token === selectionRun.current) await reject(error);
      });
    return () => {
      selectionRun.current += 1;
    };
  }, [client, value, disabled, reject]);
  return (
    <fieldset className="us-lot-picker" disabled={disabled}>
      <legend>{copy.lotPicker}</legend>
      <div className="us-md-filter-row">
        <Input
          label={copy.lotSearch}
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (pending || disabled || event.nativeEvent.isComposing) return;
            setOffset(0);
            setSearch(draft);
          }}
        />
        <Button
          type="button"
          disabled={disabled || pending}
          onClick={() => {
            setOffset(0);
            setSearch(draft);
          }}
        >
          {copy.searchLots}
        </Button>
      </div>
      <Select
        native
        label={copy.lotId}
        value={value}
        disabled={disabled || pending || failed}
        onValueChange={onChange}
        options={[
          { value: "", label: copy.noLot },
          ...(value && !rows.some((row) => row.value === value)
            ? [selected ?? { value, label: value }]
            : []),
          ...rows,
        ]}
      />
      {failed ? (
        <>
          <p role="alert">{copy.lotLoadError}</p>
          <Button
            type="button"
            disabled={disabled || pending}
            onClick={() => setRetry((n) => n + 1)}
          >
            {copy.retryLots}
          </Button>
        </>
      ) : null}
      <div className="us-request-actions">
        <Button
          type="button"
          disabled={disabled || pending || failed || offset === 0}
          onClick={() => setOffset((n) => Math.max(0, n - 50))}
        >
          {copy.previous}
        </Button>
        <span>
          {copy.page} {offset / 50 + 1}
        </span>
        <Button
          type="button"
          disabled={disabled || pending || failed || rows.length !== 50 || offset >= 100000}
          onClick={() => setOffset((n) => n + 50)}
        >
          {copy.next}
        </Button>
      </div>
    </fieldset>
  );
}
