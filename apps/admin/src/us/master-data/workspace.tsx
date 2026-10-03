import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import { US_CAPABILITY } from "@markiro/domain";
import type { ReceivingFrozenView } from "../receiving/live-record.js";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { LocationsView } from "./locations-view.js";
import { PartiesView } from "./parties-view.js";
import { ProductsView } from "../catalog/products-view.js";
import { LotsView } from "../lots/lots-view.js";
import { EventsView } from "../events/events-view.js";
import type { UsReadinessQuery } from "@markiro/platform-contracts";
import { ReadinessView, SourceBackLabelContext } from "../readiness/view.js";
import type { ReadinessEventTarget } from "../readiness/source.js";
import { SearchView } from "../search/view.js";
import { emptySearchState } from "../search/filters.js";
import { TraceView, type TraceEntry } from "../trace/view.js";
import { traceCopy } from "../trace/copy.js";
import { PlanView } from "../plans/view.js";
import { UsBrandMark } from "../brand-mark.js";
import { navStyle, type NoticeKind } from "./workspace-shared.js";
import "./master-data.css";

export type MasterDataProps = {
  client: UsBrowserClient;
  organization: { id: string; name: string };
  profile: Awaited<ReturnType<UsBrowserClient["profile"]>>;
  onBack: () => void;
  onSessionLost: () => void;
};

type View =
  | "parties"
  | "locations"
  | "products"
  | "lots"
  | "events"
  | "readiness"
  | "search"
  | "trace"
  | "plans";
type Entry =
  | { kind: "parties" | "locations" | "products" | "readiness" | "search" | "plans" }
  | { kind: "lots"; lotId?: string }
  | { kind: "trace"; entry: TraceEntry | null }
  | {
      kind: "events";
      target?: ReadinessEventTarget;
      receiving?: ReceivingFrozenView;
      transformationId?: string;
    };
type ReturnFrame = { entry: Entry };
type Notice = { kind: NoticeKind; key: string } | null;

export function MasterDataWorkspace({
  client,
  organization,
  profile,
  onBack,
  onSessionLost,
}: MasterDataProps) {
  const { t, i18n } = useTranslation();
  const [capabilities, setCapabilities] = useState<readonly string[] | null>(null);
  const [accessError, setAccessError] = useState(false);
  const [accessPending, setAccessPending] = useState(false);
  const [view, setView] = useState<View>("parties");
  const [viewGeneration, setViewGeneration] = useState(0);
  const [readinessQuery, setReadinessQuery] = useState<UsReadinessQuery>({});
  const [entry, setEntry] = useState<Entry>({ kind: "parties" });
  const [returnStack, setReturnStack] = useState<ReturnFrame[]>([]);
  const [searchState, setSearchState] = useState(emptySearchState);
  const [mutationPending, setMutationPending] = useState(false);
  const mutationCount = useRef(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const alive = useRef(true);
  const main = useRef<HTMLElement>(null);
  const focusAfterAccess = useRef(false);
  const focusAfterReturn = useRef(false);
  const accessRun = useRef(0);

  const canRead = capabilities?.includes(US_CAPABILITY.READ) ?? false;
  const showPlan = profile.code === "US_FSMA204_PROCESSOR" && canRead;
  const canWrite =
    !accessError &&
    !accessPending &&
    (capabilities?.includes(US_CAPABILITY.MASTER_DATA_WRITE) ?? false);

  useEffect(() => {
    if (!focusAfterAccess.current || accessPending || accessError) return;
    focusAfterAccess.current = false;
    if (canRead)
      (main.current?.querySelector<HTMLElement>('h1[tabindex="-1"]') ?? main.current)?.focus();
  }, [accessPending, accessError, canRead]);

  useEffect(() => {
    if (!focusAfterReturn.current) return;
    focusAfterReturn.current = false;
    // Focus a stable return target immediately. Search moves focus to its initiating
    // row after a successful refresh; missing rows and failures retain this heading.
    (main.current?.querySelector<HTMLElement>('h1[tabindex="-1"]') ?? main.current)?.focus();
  }, [view, viewGeneration]);

  const reloadAccess = useCallback(async () => {
    const run = ++accessRun.current;
    setAccessPending(true);
    try {
      const result = await client.access();
      if (alive.current && run === accessRun.current) {
        setCapabilities(result.capabilities);
        setAccessError(false);
      }
    } catch (error) {
      if (!alive.current || run !== accessRun.current) return;
      if (error instanceof UsClientError && error.code === "session_required") {
        onSessionLost();
        return;
      }
      if (error instanceof UsClientError && error.code === "forbidden") {
        setCapabilities([]);
        setAccessError(false);
        return;
      }
      // Keep mounted drafts during a transient refresh failure, but disable writes.
      setAccessError(true);
    } finally {
      if (alive.current && run === accessRun.current) setAccessPending(false);
    }
  }, [client, onSessionLost]);

  useEffect(() => {
    alive.current = true;
    void reloadAccess();
    return () => {
      alive.current = false;
      accessRun.current += 1;
    };
  }, [reloadAccess]);

  const onClientFailure = useCallback(
    (error: unknown, fallbackKey: string) => {
      if (error instanceof UsClientError && error.code === "session_required") {
        onSessionLost();
        return;
      }
      setNotice({ kind: "alert", key: fallbackKey });
    },
    [onSessionLost],
  );

  const onNotice = useCallback((kind: NoticeKind, key: string) => {
    setNotice({ kind, key });
  }, []);

  const onForbidden = useCallback(async () => {
    setNotice({ kind: "alert", key: "md.writeChanged" });
    await reloadAccess();
  }, [reloadAccess]);

  const beginMutation = useCallback(() => {
    mutationCount.current += 1;
    setMutationPending(true);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      mutationCount.current = Math.max(0, mutationCount.current - 1);
      if (mutationCount.current === 0) setMutationPending(false);
    };
  }, []);

  function navigate(next: View | "profile", editorConfirmed = false) {
    if (
      mutationPending ||
      (!editorConfirmed && editorDirty && !window.confirm(t("md.discardConfirm")))
    )
      return false;
    setEditorDirty(false);
    if (next === "profile") {
      onBack();
      return true;
    }
    setView(next);
    setEntry(next === "trace" ? { kind: "trace", entry: null } : { kind: next });
    setReturnStack([]);
    setViewGeneration((current) => current + 1);
    return true;
  }

  function openEntry(next: Entry, source: Entry = entry, editorConfirmed = false) {
    if (!canRead || accessPending || accessError || !navigate(next.kind, editorConfirmed)) return;
    setReturnStack([...returnStack, { entry: source }]);
    setEntry(next);
  }

  function returnToSource(editorConfirmed = false) {
    const frame = returnStack.at(-1);
    if (!frame || !navigate(frame.entry.kind, editorConfirmed)) return;
    setEntry(frame.entry);
    setReturnStack(returnStack.slice(0, -1));
    focusAfterReturn.current = true;
  }

  const source = returnStack.at(-1)?.entry;
  const backLabel =
    source?.kind === "plans"
      ? t("usPlan.back")
      : source?.kind === "search"
        ? t("navigation.backSearch")
        : source?.kind === "trace"
          ? t("navigation.backTrace")
          : source?.kind === "readiness"
            ? t("usReadiness.back")
            : source?.kind === "lots"
              ? t("lots.backToLot")
              : source?.kind === "events" &&
                  (source.receiving || source.target?.type === "receiving")
                ? t("receiving.back")
                : t("events.back");

  if (capabilities === null) {
    return (
      <div className="us-md-gate">
        <p role={accessError ? "alert" : "status"}>
          {t(accessError ? "md.accessError" : "md.accessLoading")}
        </p>
        <div className="us-md-gate-actions">
          {accessError ? (
            <Button disabled={accessPending} onClick={() => void reloadAccess()}>
              {t("md.retry")}
            </Button>
          ) : null}
          <Button variant="secondary" disabled={mutationPending} onClick={onBack}>
            {t("md.profile")}
          </Button>
        </div>
      </div>
    );
  }

  if (!canRead) {
    return (
      <div className="us-md-gate">
        <p role="alert">{t("md.readDenied")}</p>
        <Button variant="secondary" disabled={mutationPending} onClick={onBack}>
          {t("md.profile")}
        </Button>
      </div>
    );
  }

  const viewProps = {
    client,
    canWrite,
    mutationPending,
    beginMutation,
    onDirtyChange: setEditorDirty,
    onNotice,
    onForbidden,
    onClientFailure,
    onSessionLost,
    ...(accessError ? { accessRecovery: { pending: accessPending, retry: reloadAccess } } : {}),
  };

  return (
    <div className="us-md-shell" aria-busy={mutationPending}>
      <aside className="us-md-sidebar">
        <UsBrandMark surface="rail" />
        <div className="us-md-org">
          <strong>{organization.name}</strong>
          <span>
            {t(profile.code === "US_FSMA204_PROCESSOR" ? "md.profileBadge" : "md.genericBadge")}
          </span>
        </div>
        <nav aria-label={t("md.referenceData")}>
          {showPlan ? (
            <Button
              variant="secondary"
              className={`us-md-nav ${view === "plans" ? "is-active" : ""}`}
              style={navStyle(view === "plans")}
              disabled={mutationPending}
              aria-current={view === "plans" ? "page" : undefined}
              onClick={() => navigate("plans")}
            >
              {t("usPlan.title")}
            </Button>
          ) : null}
          {(["search", "trace"] as const).map((item) => (
            <Button
              key={item}
              variant="secondary"
              className={`us-md-nav ${view === item ? "is-active" : ""}`}
              style={navStyle(view === item)}
              disabled={mutationPending}
              aria-current={view === item ? "page" : undefined}
              onClick={() => navigate(item)}
            >
              {item === "search" ? t("usSearch.title") : traceCopy(i18n.language).title}
            </Button>
          ))}
          <Button
            variant="secondary"
            className={`us-md-nav ${view === "readiness" ? "is-active" : ""}`}
            style={navStyle(view === "readiness")}
            disabled={mutationPending}
            aria-current={view === "readiness" ? "page" : undefined}
            onClick={() => navigate("readiness")}
          >
            {t("usReadiness.title")}
          </Button>
          <Button
            variant="secondary"
            className={`us-md-nav ${view === "events" ? "is-active" : ""}`}
            style={navStyle(view === "events")}
            disabled={mutationPending}
            aria-current={view === "events" ? "page" : undefined}
            onClick={() => navigate("events")}
          >
            {t("events.title")}
          </Button>
          <Button
            variant="secondary"
            className={`us-md-nav ${view === "lots" ? "is-active" : ""}`}
            style={navStyle(view === "lots")}
            disabled={mutationPending}
            aria-current={view === "lots" ? "page" : undefined}
            onClick={() => navigate("lots")}
          >
            {t("lots.title")}
          </Button>
          <Button
            variant="secondary"
            className={`us-md-nav ${view === "products" ? "is-active" : ""}`}
            style={navStyle(view === "products")}
            disabled={mutationPending}
            aria-current={view === "products" ? "page" : undefined}
            onClick={() => navigate("products")}
          >
            {t("catalog.products")}
          </Button>
          <Button
            variant="secondary"
            className="us-md-nav"
            style={navStyle(false)}
            disabled={mutationPending}
            onClick={() => navigate("profile")}
          >
            ← {t("md.profile")}
          </Button>
          <Button
            variant="secondary"
            className={`us-md-nav ${view === "parties" ? "is-active" : ""}`}
            style={navStyle(view === "parties")}
            disabled={mutationPending}
            aria-current={view === "parties" ? "page" : undefined}
            onClick={() => navigate("parties")}
          >
            {t("md.parties")}
          </Button>
          <Button
            variant="secondary"
            className={`us-md-nav ${view === "locations" ? "is-active" : ""}`}
            style={navStyle(view === "locations")}
            disabled={mutationPending}
            aria-current={view === "locations" ? "page" : undefined}
            onClick={() => navigate("locations")}
          >
            {t("md.locations")}
          </Button>
        </nav>
      </aside>

      <section ref={main} role="main" tabIndex={-1} className="us-md-main">
        {accessError ? (
          <div className="us-md-notice us-md-notice--alert" role="alert">
            <p>{t("md.accessError")}</p>
            <Button
              disabled={accessPending || mutationPending}
              onClick={() => {
                focusAfterAccess.current = true;
                void reloadAccess();
              }}
            >
              {t("md.retry")}
            </Button>
          </div>
        ) : null}
        {notice ? (
          <div className={`us-md-notice us-md-notice--${notice.kind}`} role={notice.kind}>
            {t(notice.key)}
          </div>
        ) : null}
        {source?.kind === "plans" ? (
          <Button variant="secondary" onClick={() => returnToSource()}>
            {backLabel}
          </Button>
        ) : null}
        {view === "plans" ? (
          showPlan ? (
            <PlanView
              key={`plans-${viewGeneration}`}
              client={client}
              profile={profile}
              canManageQa={
                !accessError && !accessPending && capabilities.includes(US_CAPABILITY.QA_MANAGE)
              }
              canExport={
                !accessError && !accessPending && capabilities.includes(US_CAPABILITY.EXPORT_READ)
              }
              onForbidden={onForbidden}
              onSessionLost={onSessionLost}
              onDirtyChange={setEditorDirty}
              onMutationPendingChange={setMutationPending}
              onOpenProfile={() => navigate("profile")}
              onOpenLocations={() => openEntry({ kind: "locations" })}
              onOpenProducts={() => openEntry({ kind: "products" })}
            />
          ) : (
            <p role="alert">{t("usPlan.unavailable")}</p>
          )
        ) : view === "search" ? (
          <SearchView
            key={`search-${viewGeneration}`}
            client={client}
            state={searchState}
            onStateChange={setSearchState}
            onForbidden={onForbidden}
            onSessionLost={onSessionLost}
            onOpenLot={(lotId) => openEntry({ kind: "lots", lotId })}
          />
        ) : view === "trace" && entry.kind === "trace" ? (
          <>
            {source ? (
              <Button
                variant="secondary"
                disabled={mutationPending}
                onClick={() => returnToSource()}
              >
                {backLabel}
              </Button>
            ) : null}
            <TraceView
              key={`trace-${viewGeneration}`}
              client={client}
              entry={entry.entry}
              onEntryChange={(next) => setEntry({ kind: "trace", entry: next })}
              onForbidden={onForbidden}
              onSessionLost={onSessionLost}
              onOpenLot={(lotId) => openEntry({ kind: "lots", lotId })}
              onOpenEvent={(target) => openEntry({ kind: "events", target })}
            />
          </>
        ) : view === "readiness" ? (
          <ReadinessView
            key={`readiness-${viewGeneration}`}
            client={client}
            profileCode={profile.code}
            initialQuery={readinessQuery}
            onQueryChange={setReadinessQuery}
            onForbidden={onForbidden}
            onSessionLost={onSessionLost}
            onOpenEvent={(target) => openEntry({ kind: "events", target })}
            onOpenLot={(lotId) => openEntry({ kind: "lots", lotId })}
            onOpenEvents={() => openEntry({ kind: "events" })}
          />
        ) : view === "events" ? (
          <SourceBackLabelContext.Provider value={source ? backLabel : undefined}>
            <EventsView
              key={`events-${viewGeneration}`}
              {...viewProps}
              {...(entry.kind === "events" && entry.target ? { initialEvent: entry.target } : {})}
              {...(entry.kind === "events" && entry.receiving
                ? { initialReceiving: entry.receiving }
                : {})}
              {...(entry.kind === "events" && entry.transformationId
                ? { initialTransformationId: entry.transformationId }
                : {})}
              {...(source ? { backLabel, onEntryBack: () => returnToSource(true) } : {})}
              timeZone={profile.timeZone}
              canExport={
                !accessError && !accessPending && capabilities.includes(US_CAPABILITY.EXPORT_READ)
              }
              canManageQa={
                !accessError && !accessPending && capabilities.includes(US_CAPABILITY.QA_MANAGE)
              }
              onOpenLot={(lotId, record) =>
                openEntry(
                  { kind: "lots", lotId },
                  entry.kind === "events" && entry.target
                    ? entry
                    : { kind: "events", receiving: record },
                  true,
                )
              }
              onOpenTransformationLot={(lotId) => openEntry({ kind: "lots", lotId }, entry, true)}
              canWrite={
                !accessError &&
                !accessPending &&
                capabilities.includes(US_CAPABILITY.RECEIVING_WRITE)
              }
              canTransform={
                !accessError &&
                !accessPending &&
                capabilities.includes(US_CAPABILITY.TRANSFORMATION_WRITE)
              }
              canShip={
                !accessError &&
                !accessPending &&
                capabilities.includes(US_CAPABILITY.SHIPPING_WRITE)
              }
            />
          </SourceBackLabelContext.Provider>
        ) : view === "lots" ? (
          <LotsView
            key={`lots-${viewGeneration}`}
            {...viewProps}
            profileCode={profile.code}
            {...(entry.kind === "lots" && entry.lotId ? { entryLotId: entry.lotId } : {})}
            {...(source
              ? { entryBackLabel: backLabel, onEntryBack: () => returnToSource(true) }
              : entry.kind === "lots" && entry.lotId
                ? { entryBackLabel: t("lots.back"), onEntryBack: () => navigate("lots", true) }
                : {})}
            timeZone={profile.timeZone}
            onOpenReceiving={(lotId, record) =>
              openEntry({ kind: "events", receiving: record }, { kind: "lots", lotId })
            }
            onOpenTransformation={(eventId, lotId) =>
              openEntry({ kind: "events", transformationId: eventId }, { kind: "lots", lotId })
            }
            onOpenEvent={(target, lotId) =>
              openEntry({ kind: "events", target }, { kind: "lots", lotId })
            }
            onOpenTrace={(direction, lotId) =>
              openEntry({ kind: "trace", entry: { lotId, direction } }, { kind: "lots", lotId })
            }
            canManageQa={
              !accessError && !accessPending && capabilities.includes(US_CAPABILITY.QA_MANAGE)
            }
            canTransform={
              !accessError &&
              !accessPending &&
              capabilities.includes(US_CAPABILITY.TRANSFORMATION_WRITE)
            }
          />
        ) : view === "products" ? (
          <ProductsView
            key={`products-${viewGeneration}`}
            {...viewProps}
            profileCode={profile.code}
            timeZone={profile.timeZone}
            canManageQa={canWrite && (capabilities?.includes(US_CAPABILITY.QA_MANAGE) ?? false)}
          />
        ) : view === "parties" ? (
          <PartiesView key={`parties-${viewGeneration}`} {...viewProps} />
        ) : (
          <LocationsView key={`locations-${viewGeneration}`} {...viewProps} />
        )}
      </section>
    </div>
  );
}
