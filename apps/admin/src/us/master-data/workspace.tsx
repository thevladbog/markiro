import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import { US_CAPABILITY } from "@markiro/domain";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { LocationsView } from "./locations-view.js";
import { PartiesView } from "./parties-view.js";
import { navStyle, type NoticeKind } from "./workspace-shared.js";
import "./master-data.css";

export type MasterDataProps = {
  client: UsBrowserClient;
  organization: { id: string; name: string };
  profile: Awaited<ReturnType<UsBrowserClient["profile"]>>;
  onBack: () => void;
  onSessionLost: () => void;
};

type View = "parties" | "locations";
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
  const [view, setView] = useState<View>("parties");
  const [viewGeneration, setViewGeneration] = useState(0);
  const [mutationPending, setMutationPending] = useState(false);
  const mutationCount = useRef(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const alive = useRef(true);
  const accessRun = useRef(0);

  const canRead = capabilities?.includes(US_CAPABILITY.READ) ?? false;
  const canWrite = capabilities?.includes(US_CAPABILITY.MASTER_DATA_WRITE) ?? false;

  const reloadAccess = useCallback(async () => {
    const run = ++accessRun.current;
    setAccessError(false);
    try {
      const result = await client.access();
      if (alive.current && run === accessRun.current) setCapabilities(result.capabilities);
    } catch (error) {
      if (!alive.current || run !== accessRun.current) return;
      if (error instanceof UsClientError && error.code === "session_required") {
        onSessionLost();
        return;
      }
      setCapabilities(null);
      setAccessError(true);
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
            <Button onClick={() => void reloadAccess()}>{t("md.retry")}</Button>
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
  };

  return (
    <div className="us-md-shell" aria-busy={mutationPending}>
      <aside className="us-md-sidebar">
        <div className="us-md-wordmark">markiro</div>
        <div className="us-md-org">
          <strong>{organization.name}</strong>
          <span>
            {t(profile.code === "US_FSMA204_PROCESSOR" ? "md.profileBadge" : "md.genericBadge")}
          </span>
        </div>
        <nav aria-label={t("md.referenceData")}>
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

      <section className="us-md-main">
        {notice ? (
          <div className={`us-md-notice us-md-notice--${notice.kind}`} role={notice.kind}>
            {t(notice.key)}
          </div>
        ) : null}
        {view === "parties" ? (
          <PartiesView key={`parties-${viewGeneration}`} {...viewProps} />
        ) : (
          <LocationsView key={`locations-${viewGeneration}`} {...viewProps} />
        )}
      </section>
    </div>
  );
}
