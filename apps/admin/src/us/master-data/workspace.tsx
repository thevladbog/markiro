import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import { US_CAPABILITY } from "@markiro/domain";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { LocationsView } from "./locations-view.js";
import { PartiesView } from "./parties-view.js";
import { ProductsView } from "../catalog/products-view.js";
import { LotsView } from "../lots/lots-view.js";
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

type View = "parties" | "locations" | "products" | "lots";
type Notice = { kind: NoticeKind; key: string } | null;

export function MasterDataWorkspace({
  client,
  organization,
  profile,
  onBack,
  onSessionLost,
}: MasterDataProps) {
  const { t } = useTranslation();
  const [capabilities, setCapabilities] = useState<readonly string[] | null>(null);
  const [accessError, setAccessError] = useState(false);
  const [accessPending, setAccessPending] = useState(false);
  const [view, setView] = useState<View>("parties");
  const [viewGeneration, setViewGeneration] = useState(0);
  const [mutationPending, setMutationPending] = useState(false);
  const mutationCount = useRef(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const alive = useRef(true);
  const main = useRef<HTMLElement>(null);
  const focusAfterAccess = useRef(false);
  const accessRun = useRef(0);

  const canRead = capabilities?.includes(US_CAPABILITY.READ) ?? false;
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

  function navigate(next: View | "profile") {
    if (mutationPending || (editorDirty && !window.confirm(t("md.discardConfirm")))) return;
    setEditorDirty(false);
    if (next === "profile") {
      onBack();
      return;
    }
    setView(next);
    setViewGeneration((current) => current + 1);
  }

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

      <section ref={main} tabIndex={-1} className="us-md-main">
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
        {view === "lots" ? (
          <LotsView
            key={`lots-${viewGeneration}`}
            {...viewProps}
            profileCode={profile.code}
            timeZone={profile.timeZone}
            canManageQa={
              !accessError && !accessPending && capabilities.includes(US_CAPABILITY.QA_MANAGE)
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
