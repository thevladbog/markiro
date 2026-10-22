import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { LANDING_LEAD_STATUSES } from "@markiro/platform-contracts";

import type { LeadEvent } from "./api.js";
import { formatLeadDate, formatLeadDateTime } from "./leadFormat.js";

const FORM_EVENTS = new Set(["download", "invoice_request", "demo_request"]);
const KNOWN_PAYLOAD_KEYS = new Set([
  "sourcePath",
  "locale",
  "utm",
  "referrer",
  "productGroup",
  "linesBucket",
  "inn",
  "tariffCode",
]);
const MAX_VALUE_LENGTH = 200;

function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isStatus(value: string | null): value is (typeof LANDING_LEAD_STATUSES)[number] {
  return value !== null && (LANDING_LEAD_STATUSES as readonly string[]).includes(value);
}

export function formatUtm(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parts = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .map(([key, part]) => `${key}=${part}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function rawValue(value: unknown): string {
  const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return raw.length > MAX_VALUE_LENGTH ? `${raw.slice(0, MAX_VALUE_LENGTH)}…` : raw;
}

interface Detail {
  id: string;
  label: string;
  value: string;
}

/** Turns a free-form payload into labelled lines; unknown keys are kept as-is, never dropped. */
function payloadDetails(
  payload: Record<string, unknown>,
  consumed: ReadonlySet<string>,
  t: TFunction,
): Detail[] {
  return Object.entries(payload)
    .filter(([key, value]) => !consumed.has(key) && value !== null && value !== undefined)
    .map(([key, value]) => {
      if (!KNOWN_PAYLOAD_KEYS.has(key)) return { id: key, label: key, value: rawValue(value) };
      if (key === "utm")
        return { id: key, label: t("leads.payload.utm"), value: formatUtm(value) ?? "—" };
      if (key === "linesBucket" && typeof value === "string") {
        return {
          id: key,
          label: t("leads.payload.linesBucket"),
          value: t(`leads.lines.${value}`, value),
        };
      }
      if (key === "locale" && typeof value === "string") {
        return {
          id: key,
          label: t("leads.payload.locale"),
          value: t(`leads.locale.${value}`, value),
        };
      }
      return { id: key, label: t(`leads.payload.${key}`), value: rawValue(value) };
    });
}

function EventSummary({ event, language }: { event: LeadEvent; language: string }) {
  const { t } = useTranslation();
  const { payload } = event;
  const status = (key: string) => {
    const value = text(payload, key);
    return isStatus(value) ? t(`leads.status.${value}`) : (value ?? "—");
  };
  const touch = text(payload, "nextTouchAt");
  const touchLine = touch ? (
    <p>{t("leads.journal.nextTouch", { date: formatLeadDate(touch, language) })}</p>
  ) : null;

  // Spec 2026-10-20 §15.6: the link and the status a site's activation request set.
  const viaActivation =
    payload.via === "activation_request" ? <p>{t("leads.journal.viaActivation")}</p> : null;

  switch (event.kind) {
    case "status_change":
      return (
        <>
          <p>{`${status("from")} → ${status("to")}`}</p>
          {touchLine}
          {viaActivation}
        </>
      );
    case "activation_request": {
      const tenantId = text(payload, "tenantId");
      return (
        <p>
          {payload.intent === "rebind"
            ? t("leads.journal.activationRebind")
            : t("leads.journal.activationCreate")}{" "}
          {tenantId ? (
            <Link to={`/tenants/${tenantId}`}>{t("leads.journal.openTenant")}</Link>
          ) : null}
        </p>
      );
    }
    case "touch":
      return touchLine;
    case "note": {
      const length = typeof payload.length === "number" ? payload.length : null;
      return (
        <p>
          {length === 0
            ? t("leads.journal.noteCleared")
            : length === null
              ? t("leads.journal.noteChanged")
              : t("leads.journal.noteLength", { count: length })}
        </p>
      );
    }
    case "linked_tenant": {
      const tenantId = text(payload, "tenantId");
      const previous = text(payload, "previousTenantId");
      return (
        <>
          <p>
            {payload.created === true
              ? t("leads.journal.tenantCreated")
              : t("leads.journal.tenantLinked")}{" "}
            {tenantId ? (
              <Link to={`/tenants/${tenantId}`}>{t("leads.journal.openTenant")}</Link>
            ) : null}
          </p>
          {previous ? <p>{t("leads.journal.previousTenant", { id: previous })}</p> : null}
          {viaActivation}
        </>
      );
    }
    case "anonymized": {
      const reason = text(payload, "reason");
      return (
        <p>
          {t("leads.journal.anonymizedReason", {
            reason: reason ? t(`leads.anonymizeReason.${reason}`, reason) : "—",
          })}
        </p>
      );
    }
    default:
      return null;
  }
}

const CONSUMED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  status_change: new Set(["from", "to", "nextTouchAt", "via"]),
  activation_request: new Set(["tenantId", "siteId", "hostId", "intent"]),
  touch: new Set(["nextTouchAt"]),
  note: new Set(["length"]),
  linked_tenant: new Set(["tenantId", "created", "previousTenantId", "via"]),
  anonymized: new Set(["reason"]),
};
const NOTHING = new Set<string>();

export function LeadJournal({ events }: { events: readonly LeadEvent[] }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;

  if (events.length === 0) return <p className="leads-muted">{t("leads.journal.empty")}</p>;

  return (
    <ol className="leads-journal" aria-label={t("leads.journal.title")}>
      {events.map((event) => {
        const actor =
          event.actor?.name ??
          event.actor?.id ??
          (FORM_EVENTS.has(event.kind) ? t("leads.journal.form") : t("leads.journal.system"));
        const details = payloadDetails(event.payload, CONSUMED_KEYS[event.kind] ?? NOTHING, t);
        return (
          <li key={event.id} className="leads-journal__entry">
            <header className="leads-journal__header">
              <strong>{t(`leads.eventKind.${event.kind}`)}</strong>
              <time dateTime={event.createdAt}>
                {formatLeadDateTime(event.createdAt, language)}
              </time>
              <span>{actor}</span>
            </header>
            <EventSummary event={event} language={language} />
            {details.length > 0 ? (
              <dl className="leads-journal__details">
                {details.map((detail) => (
                  <div key={detail.id}>
                    <dt>{detail.label}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
