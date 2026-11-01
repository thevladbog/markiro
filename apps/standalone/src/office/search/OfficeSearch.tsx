import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, Modal } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { OfficeSearchResponse, OfficeSearchTarget } from "../../host/office-search.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError } from "../page-state.js";
import { officeScanBlocked } from "./office-scan.js";
import { readOfficeSearch } from "./search-query.js";

type Result =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "failed"; error: Error }
  | { kind: "ready"; value: OfficeSearchResponse };

export interface OfficeSearchProps {
  /** Transient scanner input; a repeated code is a new event. */
  scan?: { id: number; raw: string };
  navigationKey?: string;
  onClose: () => void;
  onSelect: (target: OfficeSearchTarget) => void;
}

/** System search opened from the sidebar or a scan. */
export function OfficeSearch({
  scan,
  navigationKey = "initial",
  onSelect,
  onClose,
}: OfficeSearchProps) {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const inputId = useId();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const initialNavigation = useRef(navigationKey);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const generation = useRef(0);
  const active = useRef(true);
  const selection = useRef(onSelect);
  selection.current = onSelect;

  const dismiss = useCallback(() => {
    generation.current += 1;
    onClose();
  }, [onClose]);
  const select = (target: OfficeSearchTarget) => {
    dismiss();
    setText("");
    selection.current(target);
  };
  const perform = async (raw: string, scanned: boolean) => {
    const requestId = ++generation.current;
    const reading = readOfficeSearch(raw);
    if (!reading.ok) {
      setResult({ kind: reading.reason === "empty" ? "idle" : "invalid" });
      return;
    }
    setResult({ kind: "loading" });
    try {
      const response = await session.call((token) =>
        session.api.searchOffice(token, reading.request),
      );
      if (!active.current || requestId !== generation.current) return;
      // A form or dialog opened while the host was answering owns the user's attention.
      if (scanned && officeScanBlocked(document, root.current?.closest('[role="dialog"]'))) {
        dismiss();
        return;
      }
      if (scanned && !response.truncated && response.items.length === 1) {
        const item = response.items[0];
        if (item) select(item.target);
        return;
      }
      setResult({ kind: "ready", value: response });
    } catch (error) {
      if (!active.current || requestId !== generation.current) return;
      if (scanned && officeScanBlocked(document, root.current?.closest('[role="dialog"]'))) {
        dismiss();
        return;
      }
      setResult({
        kind: "failed",
        error: error instanceof Error ? error : new Error("search failed"),
      });
    }
  };
  const performRef = useRef(perform);
  performRef.current = perform;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    if (navigationKey !== initialNavigation.current) dismiss();
  }, [navigationKey, dismiss]);
  useEffect(() => {
    queueMicrotask(() => {
      if (active.current) document.getElementById(inputId)?.focus();
    });
  }, [inputId]);
  useEffect(() => {
    if (scan === undefined) return;
    setText(scan.raw);
    void performRef.current(scan.raw, true);
  }, [scan]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Disabling a focused submit button would leave keyboard focus outside the modal.
    document.getElementById(inputId)?.focus();
    void perform(text, false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>(".office-search-result") ?? []),
    ];
    if (buttons.length === 0) return;
    const index = buttons.findIndex((button) => button === event.target);
    if (
      event.target instanceof HTMLElement &&
      event.target.id === inputId &&
      event.key === "ArrowDown"
    ) {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (index >= 0) {
      event.preventDefault();
      if (event.key === "ArrowUp" && index === 0) document.getElementById(inputId)?.focus();
      else buttons[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    }
  };
  const groups = new Map<OfficeSearchTarget["kind"], OfficeSearchResponse["items"]>();
  if (result.kind === "ready") {
    for (const item of result.value.items) {
      const group = groups.get(item.target.kind) ?? [];
      group.push(item);
      groups.set(item.target.kind, group);
    }
  }
  return (
    <Modal
      open
      title={t("office.search.title")}
      width={800}
      closeLabel={t("office.common.close")}
      onClose={dismiss}
      className="office-search-dialog"
    >
      <div ref={root} className="office-search" onKeyDown={onKeyDown}>
        <form
          role="search"
          aria-label={t("office.search.title")}
          className="office-search-form"
          onSubmit={submit}
        >
          <Input
            id={inputId}
            aria-label={t("office.search.title")}
            placeholder={t("office.search.placeholder")}
            prefix={<OfficeIcon name="search" size={18} />}
            value={text}
            maxLength={4096}
            autoComplete="off"
            aria-controls={panelId}
            aria-keyshortcuts="Control+k Meta+k"
            onChange={(event) => {
              generation.current += 1;
              setText(event.target.value);
              setResult({ kind: "idle" });
            }}
          />
          <Button type="submit" disabled={result.kind === "loading" || text.trim() === ""}>
            {t("office.search.submit")}
          </Button>
        </form>
        <section id={panelId} aria-label={t("office.search.results")}>
          <div
            className="office-search-results"
            aria-live="polite"
            aria-busy={result.kind === "loading"}
          >
            {result.kind === "idle" && <p>{t("office.search.hint")}</p>}
            {result.kind === "invalid" && <Alert tone="warn">{t("office.search.invalid")}</Alert>}
            {result.kind === "loading" && <p role="status">{t("office.search.loading")}</p>}
            {result.kind === "failed" &&
              (result.error instanceof HostError && result.error.status === 404 ? (
                <Alert tone="warn">{t("office.search.updateHost")}</Alert>
              ) : (
                <LoadError error={result.error} onRetry={() => void perform(text, false)} />
              ))}
            {result.kind === "ready" && result.value.items.length === 0 && (
              <p>{t("office.search.empty")}</p>
            )}
            {result.kind === "ready" && result.value.truncated && (
              <Alert tone="warn">{t("office.search.truncated")}</Alert>
            )}
            {[...groups].map(([kind, items]) => (
              <section
                key={kind}
                className="office-search-group"
                aria-label={t(`office.search.groups.${kind}`)}
              >
                <h3>
                  {t(`office.search.groups.${kind}`)} <span>({items.length})</span>
                </h3>
                <ul>
                  {items.map((item) => (
                    <li key={item.id}>
                      <Button
                        type="button"
                        variant="plain"
                        className="office-search-result"
                        style={{ display: "grid", alignItems: "start" }}
                        onClick={() => select(item.target)}
                      >
                        <span className="office-search-result__label">{item.label}</span>
                        {item.detail !== null && (
                          <span className="office-search-result__detail">{item.detail}</span>
                        )}
                        {"source" in item.target && item.target.source === "cloud" && (
                          <span className="office-search-result__source">
                            {t("office.search.cloud")}
                          </span>
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}
