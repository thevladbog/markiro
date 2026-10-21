import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm, type FieldError } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import {
  platformLeadCreateTenantSchema,
  type PlatformLeadCreateTenant,
} from "@markiro/platform-contracts";
import { Button, Card, Combobox, Input, StatusChip } from "@markiro/ui";

import { listTenants } from "../tenants/api.js";
import type { LeadDetail } from "./api.js";
import { suggestLeadTenantSlug } from "./leadFormat.js";

const TENANT_PAGE_SIZE = 100;

type Mode = "idle" | "create" | "link";

function validationMessage(error: FieldError, t: (key: string) => string): string {
  return t(
    `leads.createTenant.validation.${typeof error.message === "string" ? error.message : "required"}`,
  );
}

function CreateTenantForm({
  lead,
  busy,
  onSubmit,
  onCancel,
}: {
  lead: LeadDetail;
  busy: boolean;
  onSubmit: (input: PlatformLeadCreateTenant) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const form = useForm<PlatformLeadCreateTenant>({
    resolver: zodResolver(platformLeadCreateTenantSchema),
    defaultValues: {
      // The invoice form gives no company; the operator types the name then.
      tenantName: (lead.company ?? "").slice(0, 300),
      tenantSlug: suggestLeadTenantSlug(lead.company ?? "", lead.inn),
    },
  });
  const submit = form.handleSubmit(async (values) => {
    await onSubmit(values);
  });
  const { errors } = form.formState;

  return (
    <form
      className="leads-tenant-form"
      aria-label={t("leads.createTenant.title")}
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <p className="leads-muted">{t("leads.createTenant.hint")}</p>
      <Input
        label={t("leads.createTenant.name")}
        required
        {...(errors.tenantName ? { error: validationMessage(errors.tenantName, t) } : {})}
        {...form.register("tenantName")}
      />
      <Input
        label={t("leads.createTenant.slug")}
        hint={t("leads.createTenant.slugHint")}
        required
        mono
        autoCapitalize="none"
        autoCorrect="off"
        {...(errors.tenantSlug ? { error: validationMessage(errors.tenantSlug, t) } : {})}
        {...form.register("tenantSlug")}
      />
      <div className="leads-actions">
        <Button type="submit" loading={busy}>
          {t("leads.createTenant.submit")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t("leads.cancel")}
        </Button>
      </div>
    </form>
  );
}

function LinkTenantForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (tenantId: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [tenantId, setTenantId] = useState("");
  const tenants = useQuery({
    queryKey: ["platform", "tenants", "lead-link", page],
    queryFn: () => listTenants({ page, limit: TENANT_PAGE_SIZE }),
  });
  const options = (tenants.data?.items ?? []).map((tenant) => ({
    value: tenant.id,
    label: tenant.name,
    description: tenant.slug,
    keywords: [tenant.slug],
  }));
  const hasNext = page * TENANT_PAGE_SIZE < (tenants.data?.total ?? 0);

  return (
    <form
      className="leads-tenant-form"
      aria-label={t("leads.linkTenant.title")}
      onSubmit={(event) => {
        event.preventDefault();
        if (tenantId) void onSubmit(tenantId);
      }}
    >
      <Combobox
        label={t("leads.linkTenant.tenant")}
        options={options}
        {...(tenantId ? { value: tenantId } : {})}
        onValueChange={setTenantId}
        placeholder={t("leads.linkTenant.placeholder")}
        searchPlaceholder={t("leads.linkTenant.search")}
        emptyText={t("leads.linkTenant.empty")}
        loadingText={t("leads.linkTenant.loading")}
        loading={tenants.isPending}
        {...(tenants.error ? { error: t("leads.linkTenant.loadError") } : {})}
        footer={
          page > 1 || hasNext || tenants.error ? (
            <div className="leads-actions">
              {tenants.error ? (
                <Button variant="secondary" onClick={() => void tenants.refetch()}>
                  {t("leads.retry")}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                disabled={page === 1 || tenants.isFetching}
                onClick={() => setPage(page - 1)}
              >
                {t("leads.pagination.previous")}
              </Button>
              <Button
                variant="secondary"
                disabled={!hasNext || tenants.isFetching}
                onClick={() => setPage(page + 1)}
              >
                {t("leads.pagination.next")}
              </Button>
            </div>
          ) : undefined
        }
      />
      <p className="leads-muted">{t("leads.linkTenant.scope")}</p>
      <div className="leads-actions">
        <Button type="submit" disabled={!tenantId} loading={busy}>
          {t("leads.linkTenant.submit")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t("leads.cancel")}
        </Button>
      </div>
    </form>
  );
}

export function LeadTenantPanel({
  lead,
  canWrite,
  canCreateTenant,
  busy,
  onCreate,
  onLink,
}: {
  lead: LeadDetail;
  canWrite: boolean;
  canCreateTenant: boolean;
  busy: boolean;
  onCreate: (input: PlatformLeadCreateTenant) => Promise<boolean>;
  onLink: (tenantId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("idle");
  const done = (ok: boolean) => {
    if (ok) setMode("idle");
    return ok;
  };

  return (
    <Card title={t("leads.tenant.title")} titleAs="h2" className="leads-card">
      {lead.tenant ? (
        <p className="leads-tenant">
          <Link className="table-link" to={`/tenants/${lead.tenant.id}`}>
            {lead.tenant.name}
          </Link>
          {lead.tenant.cabinetAccess === "none" ? (
            <StatusChip phase="none" label={t("tenants.cabinet.none")} />
          ) : null}
        </p>
      ) : (
        <>
          <p className="leads-muted">{t("leads.tenant.none")}</p>
          {canWrite && mode === "idle" ? (
            <div className="leads-actions">
              {canCreateTenant ? (
                <Button variant="secondary" onClick={() => setMode("create")}>
                  {t("leads.tenant.create")}
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => setMode("link")}>
                {t("leads.tenant.link")}
              </Button>
            </div>
          ) : null}
          {canWrite && canCreateTenant && mode === "create" ? (
            <CreateTenantForm
              lead={lead}
              busy={busy}
              onSubmit={async (input) => done(await onCreate(input))}
              onCancel={() => setMode("idle")}
            />
          ) : null}
          {canWrite && mode === "link" ? (
            <LinkTenantForm
              busy={busy}
              onSubmit={async (tenantId) => done(await onLink(tenantId))}
              onCancel={() => setMode("idle")}
            />
          ) : null}
        </>
      )}
    </Card>
  );
}
