import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import {
  LANDING_LEAD_DEFAULT_TOUCH_DAYS,
  LANDING_LEAD_NOTE_MAX_LENGTH,
  LANDING_LEAD_STATUSES,
  platformLeadParamsSchema,
  type LandingLeadStatus,
} from "@markiro/platform-contracts";
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DatePicker,
  DefinitionGrid,
  SectionHeader,
  Select,
  StatusChip,
  Textarea,
  type DefinitionGridItem,
} from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { PanelState } from "../../components/PanelState.js";
import { useNavigationGuard } from "../../layout/NavigationGuard.js";
import {
  anonymizeLead,
  createLeadTenant,
  getLead,
  leadKeys,
  linkLeadTenant,
  markLeadContacted,
  updateLead,
  type LeadDetail,
} from "./api.js";
import { leadErrorMessageKey, type LeadOperation } from "./errorMessages.js";
import { formatUtm, LeadJournal } from "./LeadJournal.js";
import {
  formatLeadDate,
  formatLeadDateTime,
  LEAD_STATUS_TO_PHASE,
  moscowCivilDate,
  moscowTouchInstant,
} from "./leadFormat.js";
import { LeadTenantPanel } from "./LeadTenantPanel.js";

type Run = (
  operation: LeadOperation,
  call: () => Promise<LeadDetail>,
  okKey: string,
) => Promise<boolean>;

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="compact"
      variant="secondary"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? t("leads.contacts.copied") : t("leads.contacts.copy")}
    </Button>
  );
}

function LeadContacts({ lead, language }: { lead: LeadDetail; language: string }) {
  const { t } = useTranslation();
  if (lead.anonymizedAt) {
    return (
      <Card title={t("leads.contacts.title")} titleAs="h2" className="leads-card">
        <p className="leads-muted">
          {t("leads.contacts.anonymized", { date: formatLeadDate(lead.anonymizedAt, language) })}
        </p>
      </Card>
    );
  }
  const items: DefinitionGridItem[] = [
    {
      id: "email",
      term: t("leads.contacts.email"),
      description: lead.email ? (
        <span className="leads-contact">
          <a href={`mailto:${lead.email}`}>{lead.email}</a>
          <CopyButton value={lead.email} label={t("leads.contacts.copyEmail")} />
        </span>
      ) : (
        "—"
      ),
    },
    { id: "name", term: t("leads.contacts.name"), description: lead.name ?? "—" },
    {
      id: "phone",
      term: t("leads.contacts.phone"),
      description: lead.phone ? (
        <span className="leads-contact">
          <span className="font-mono">{lead.phone}</span>
          <CopyButton value={lead.phone} label={t("leads.contacts.copyPhone")} />
        </span>
      ) : (
        "—"
      ),
    },
  ];
  return (
    <Card title={t("leads.contacts.title")} titleAs="h2" className="leads-card">
      <DefinitionGrid items={items} />
    </Card>
  );
}

function LeadFacts({ lead, language }: { lead: LeadDetail; language: string }) {
  const { t } = useTranslation();
  const items: DefinitionGridItem[] = [
    {
      id: "company",
      term: t("leads.facts.company"),
      description: lead.company ?? t("leads.noCompany"),
    },
    { id: "inn", term: t("leads.facts.inn"), description: lead.inn ?? "—", mono: true },
    {
      id: "productGroup",
      term: t("leads.facts.productGroup"),
      description: lead.productGroup ?? "—",
    },
    {
      id: "lines",
      term: t("leads.facts.lines"),
      description: lead.linesBucket ? t(`leads.lines.${lead.linesBucket}`) : "—",
    },
    {
      id: "tariff",
      term: t("leads.facts.tariff"),
      description: lead.tariffCode ?? "—",
      mono: true,
    },
    { id: "source", term: t("leads.facts.source"), description: lead.firstSourcePath, mono: true },
    { id: "utm", term: t("leads.facts.utm"), description: formatUtm(lead.firstUtm) ?? "—" },
    { id: "referrer", term: t("leads.facts.referrer"), description: lead.firstReferrer ?? "—" },
    { id: "locale", term: t("leads.facts.locale"), description: t(`leads.locale.${lead.locale}`) },
    {
      id: "createdAt",
      term: t("leads.facts.createdAt"),
      description: formatLeadDateTime(lead.createdAt, language),
    },
  ];
  return (
    <Card title={t("leads.facts.title")} titleAs="h2" className="leads-card">
      <DefinitionGrid items={items} />
    </Card>
  );
}

function NextTouchForm({ lead, busy, run }: { lead: LeadDetail; busy: boolean; run: Run }) {
  const { t, i18n } = useTranslation();
  const saved = moscowCivilDate(lead.nextTouchAt);
  const [date, setDate] = useState(saved);
  return (
    <div className="leads-inline-form">
      <DatePicker
        label={t("leads.work.nextTouch")}
        hint={t("leads.work.nextTouchHint")}
        value={date}
        onValueChange={(value) => setDate(value ?? "")}
        locale={i18n.language}
        placeholder={t("reports.calendar.placeholder")}
        clearLabel={t("reports.calendar.clear")}
        calendarLabel={t("reports.calendar.title")}
        previousMonthLabel={t("reports.calendar.previousMonth")}
        nextMonthLabel={t("reports.calendar.nextMonth")}
      />
      <Button
        variant="secondary"
        disabled={busy || date === saved}
        onClick={() =>
          void run(
            "update",
            () => updateLead(lead.id, { nextTouchAt: date ? moscowTouchInstant(date) : null }),
            "leads.notice.nextTouchSaved",
          )
        }
      >
        {t("leads.work.saveNextTouch")}
      </Button>
    </div>
  );
}

function NoteForm({ lead, busy, run }: { lead: LeadDetail; busy: boolean; run: Run }) {
  const { t } = useTranslation();
  const saved = lead.ownerNote ?? "";
  const [note, setNote] = useState(saved);
  const dirty = note.trim() !== saved.trim();
  useNavigationGuard(dirty, busy);
  return (
    <div className="leads-note">
      <Textarea
        label={t("leads.work.note")}
        value={note}
        rows={4}
        maxLength={LANDING_LEAD_NOTE_MAX_LENGTH}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="leads-actions">
        <span className="leads-muted" aria-live="polite">
          {t("leads.work.noteLength", { count: note.length, max: LANDING_LEAD_NOTE_MAX_LENGTH })}
        </span>
        <Button
          variant="secondary"
          disabled={busy || !dirty}
          onClick={() =>
            void run(
              "update",
              () => updateLead(lead.id, { ownerNote: note.trim() || null }),
              "leads.notice.noteSaved",
            )
          }
        >
          {t("leads.work.saveNote")}
        </Button>
      </div>
    </div>
  );
}

function LeadWork({
  lead,
  canWrite,
  busy,
  run,
  language,
}: {
  lead: LeadDetail;
  canWrite: boolean;
  busy: boolean;
  run: Run;
  language: string;
}) {
  const { t } = useTranslation();
  const statusChip = (
    <StatusChip
      phase={LEAD_STATUS_TO_PHASE[lead.status]}
      label={t(`leads.status.${lead.status}`)}
    />
  );
  if (!canWrite) {
    return (
      <Card title={t("leads.work.title")} titleAs="h2" className="leads-card">
        <DefinitionGrid
          items={[
            { id: "status", term: t("leads.work.status"), description: statusChip },
            {
              id: "nextTouch",
              term: t("leads.work.nextTouch"),
              description: lead.nextTouchAt ? formatLeadDate(lead.nextTouchAt, language) : "—",
            },
            { id: "note", term: t("leads.work.note"), description: lead.ownerNote ?? "—" },
          ]}
        />
      </Card>
    );
  }
  return (
    <Card title={t("leads.work.title")} titleAs="h2" className="leads-card">
      <div className="leads-work">
        <div className="leads-inline-form">
          <Select<LandingLeadStatus>
            label={t("leads.work.status")}
            value={lead.status}
            disabled={busy}
            options={LANDING_LEAD_STATUSES.map((value) => ({
              value,
              label: t(`leads.status.${value}`),
            }))}
            onValueChange={(value) => {
              if (value === lead.status) return;
              void run(
                "update",
                () => updateLead(lead.id, { status: value }),
                "leads.notice.statusChanged",
              );
            }}
          />
          {statusChip}
        </div>
        {lead.anonymizedAt ? null : (
          <div className="leads-inline-form">
            <Button
              disabled={busy}
              onClick={() =>
                void run("contacted", () => markLeadContacted(lead.id), "leads.notice.contacted")
              }
            >
              {t("leads.work.contacted")}
            </Button>
            <span className="leads-muted">
              {t("leads.work.contactedHint", { count: LANDING_LEAD_DEFAULT_TOUCH_DAYS })}
            </span>
          </div>
        )}
        <NextTouchForm key={lead.nextTouchAt ?? "none"} lead={lead} busy={busy} run={run} />
        {/* The API refuses note edits after anonymization: a note may hold personal data. */}
        {lead.anonymizedAt ? null : <NoteForm key={lead.id} lead={lead} busy={busy} run={run} />}
      </div>
    </Card>
  );
}

export function LeadPage() {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const queryClient = useQueryClient();
  const { leadId = "" } = useParams();
  const validId = platformLeadParamsSchema.safeParse({ id: leadId });
  const canRead = principal.capabilities.includes("leads.read");
  const canWrite = principal.capabilities.includes("leads.write");
  const canCreateTenant = canWrite && principal.capabilities.includes("tenants.write");
  const lead = useQuery({
    queryKey: leadKeys.detail(leadId),
    queryFn: () => getLead(leadId),
    enabled: canRead && validId.success,
  });
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; key: string } | null>(null);
  const [anonymizeOpen, setAnonymizeOpen] = useState(false);
  const action = useMutation({
    mutationFn: ({ call }: { operation: LeadOperation; call: () => Promise<LeadDetail> }) => call(),
  });
  const run: Run = async (operation, call, okKey) => {
    setNotice(null);
    try {
      const updated = await action.mutateAsync({ operation, call });
      queryClient.setQueryData(leadKeys.detail(leadId), updated);
      setNotice({ tone: "ok", key: okKey });
      void queryClient.invalidateQueries({ queryKey: leadKeys.all });
      if (operation === "createTenant") {
        void queryClient.invalidateQueries({ queryKey: ["platform", "tenants"] });
      }
      return true;
    } catch (error) {
      setNotice({ tone: "error", key: leadErrorMessageKey(operation, error) });
      return false;
    }
  };
  const language = i18n.resolvedLanguage ?? i18n.language;

  const shell = (title: string, body: ReactNode) => (
    <section className="leads-page lead-detail-page">
      <SectionHeader title={title} />
      {body}
    </section>
  );

  if (!canRead) return shell(t("leads.title"), <Alert tone="error">{t("leads.forbidden")}</Alert>);
  if (!validId.success) {
    return shell(
      t("leads.detail.invalidTitle"),
      <Alert tone="error">{t("leads.detail.invalidId")}</Alert>,
    );
  }
  // A failed background refetch keeps the loaded card; only a first load shows the error.
  if (lead.isPending || (lead.error && lead.data === undefined)) {
    return shell(
      t(lead.isPending ? "leads.detail.loadingTitle" : "leads.detail.loadErrorTitle"),
      <PanelState
        loading={lead.isPending}
        empty={false}
        error={lead.error}
        onRetry={() => void lead.refetch()}
        loadingText={t("leads.detail.loading")}
      >
        {null}
      </PanelState>,
    );
  }

  const detail = lead.data;
  const busy = action.isPending;

  return (
    <section className="leads-page lead-detail-page">
      <SectionHeader
        eyebrow="OPERATIONS / LEADS"
        title={detail.company ?? t("leads.noCompany")}
        description={t("leads.detail.description", {
          date: formatLeadDateTime(detail.createdAt, language),
        })}
        actionsLabel={t("leads.detail.actions")}
        actions={<Link to="/leads">{t("leads.detail.back")}</Link>}
      />
      {notice ? <Alert tone={notice.tone}>{t(notice.key)}</Alert> : null}
      <div className="leads-grid">
        <div className="leads-column">
          <LeadContacts lead={detail} language={language} />
          <LeadWork lead={detail} canWrite={canWrite} busy={busy} run={run} language={language} />
          <LeadTenantPanel
            lead={detail}
            canWrite={canWrite}
            canCreateTenant={canCreateTenant}
            busy={busy}
            onCreate={(input) =>
              run(
                "createTenant",
                () => createLeadTenant(detail.id, input),
                "leads.notice.tenantCreated",
              )
            }
            onLink={(tenantId) =>
              run(
                "link",
                () => linkLeadTenant(detail.id, { tenantId }),
                "leads.notice.tenantLinked",
              )
            }
          />
        </div>
        <div className="leads-column">
          <LeadFacts lead={detail} language={language} />
          <Card title={t("leads.journal.title")} titleAs="h2" className="leads-card">
            <LeadJournal events={detail.events} />
          </Card>
          {canWrite && !detail.anonymizedAt ? (
            <Card title={t("leads.anonymize.title")} titleAs="h2" className="leads-card">
              <p className="leads-muted">{t("leads.anonymize.hint")}</p>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  // The dialog shows only its own error, not an earlier action's.
                  setNotice(null);
                  setAnonymizeOpen(true);
                }}
              >
                {t("leads.anonymize.action")}
              </Button>
            </Card>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={anonymizeOpen}
        tone="destructive"
        title={t("leads.anonymize.confirmTitle")}
        description={t("leads.anonymize.confirmDescription")}
        entity={detail.company ?? t("leads.noCompany")}
        confirmLabel={t("leads.anonymize.action")}
        cancelLabel={t("leads.cancel")}
        busy={busy}
        {...(anonymizeOpen && notice?.tone === "error" ? { error: t(notice.key) } : {})}
        onCancel={() => setAnonymizeOpen(false)}
        onConfirm={() =>
          void run("anonymize", () => anonymizeLead(detail.id), "leads.notice.anonymized").then(
            (ok) => {
              if (ok) setAnonymizeOpen(false);
            },
          )
        }
      />
    </section>
  );
}
