import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, SectionHeader, Spinner, StatusChip } from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import {
  activateNationalCatalogSchema,
  listNationalCatalogSchemas,
  refreshNationalCatalogSchemas,
  reviewNationalCatalogGroupMapping,
  type NationalCatalogSchemas,
} from "./api.js";

const QUERY_KEY = ["platform", "operations", "national-catalog", "schemas"] as const;

export function NationalCatalogPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const schemas = useQuery({ queryKey: QUERY_KEY, queryFn: listNationalCatalogSchemas });
  const canWrite = principal.capabilities.includes("catalog.write");

  const refresh = useMutation({
    mutationFn: (sourceTenantId: string) => refreshNationalCatalogSchemas(sourceTenantId),
    onSuccess: async (result) => {
      setNotice(t("nationalCatalog.refreshResult", result));
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
  const review = useMutation({
    mutationFn: (input: { groupCode: number; schemaVersionId: string }) =>
      reviewNationalCatalogGroupMapping(input.groupCode, input.schemaVersionId),
    onSuccess: (result) => {
      queryClient.setQueryData<NationalCatalogSchemas>(QUERY_KEY, (current) =>
        current
          ? {
              ...current,
              versions: current.versions.map((version) =>
                result.schemaVersionIds.includes(version.id)
                  ? {
                      ...version,
                      mappings: version.mappings.map((mapping) =>
                        mapping.chzProductGroupCode === result.chzProductGroupCode
                          ? { ...mapping, state: "exact", reviewedAt: result.reviewedAt }
                          : mapping,
                      ),
                    }
                  : version,
              ),
            }
          : current,
      );
      setNotice(t("nationalCatalog.reviewed"));
    },
  });
  const activate = useMutation({
    mutationFn: activateNationalCatalogSchema,
    onSuccess: (result) => {
      queryClient.setQueryData<NationalCatalogSchemas>(QUERY_KEY, (current) =>
        current
          ? {
              ...current,
              versions: current.versions.map((version) =>
                version.id === result.schemaVersionId
                  ? { ...version, status: "active", activatedAt: new Date().toISOString() }
                  : version,
              ),
            }
          : current,
      );
      setNotice(t("nationalCatalog.activated"));
    },
  });
  const mutationError = refresh.error ?? review.error ?? activate.error;
  const sourceTenantId = schemas.data?.sourceTenantId;

  return (
    <section className="national-catalog-page">
      <SectionHeader
        eyebrow="PLATFORM / NATIONAL CATALOG"
        title={t("nationalCatalog.title")}
        description={t("nationalCatalog.description")}
        actions={
          canWrite && sourceTenantId ? (
            <Button disabled={refresh.isPending} onClick={() => refresh.mutate(sourceTenantId)}>
              {t("nationalCatalog.refresh")}
            </Button>
          ) : null
        }
      />
      {!schemas.data?.configured && !schemas.isPending ? (
        <Alert tone="warn">{t("nationalCatalog.unconfigured")}</Alert>
      ) : null}
      {notice ? <Alert tone="ok">{notice}</Alert> : null}
      {mutationError ? <Alert tone="error">{t("nationalCatalog.actionFailed")}</Alert> : null}
      {schemas.isPending ? <Spinner label={t("nationalCatalog.loading")} /> : null}
      {schemas.error ? <Alert tone="error">{t("nationalCatalog.loadFailed")}</Alert> : null}
      <div className="national-catalog-grid">
        {(schemas.data?.versions ?? []).map((version) => {
          const exact = version.mappings.some((mapping) => mapping.state === "exact");
          const blocked = version.blockedReasons.length > 0;
          return (
            <article className="national-catalog-card" key={version.id}>
              <header>
                <div>
                  <h2>{version.categoryName}</h2>
                  <p className="national-catalog-card__id">{version.categoryId}</p>
                </div>
                <StatusChip
                  status={version.status === "active" ? "ok" : blocked ? "error" : "info"}
                  label={t(`nationalCatalog.status.${version.status}`)}
                />
              </header>
              {blocked ? (
                <ul className="national-catalog-card__reasons">
                  {version.blockedReasons.map((reason) => (
                    <li key={`${reason.code}:${reason.attributeId}`}>
                      {t(`nationalCatalog.blockReason.${reason.code}`)} · {reason.attributeId}
                    </li>
                  ))}
                </ul>
              ) : null}
              {version.mappings.map((mapping) => (
                <section className="national-catalog-mapping" key={mapping.chzProductGroupCode}>
                  <div>
                    <strong>{mapping.chzProductGroupName}</strong>
                    <span>{t(`nationalCatalog.mapping.${mapping.state}`)}</span>
                  </div>
                  {canWrite && mapping.state !== "exact" ? (
                    <Button
                      variant="secondary"
                      disabled={review.isPending || blocked}
                      onClick={() =>
                        review.mutate({
                          groupCode: mapping.chzProductGroupCode,
                          schemaVersionId: version.id,
                        })
                      }
                    >
                      {t("nationalCatalog.review")}
                    </Button>
                  ) : null}
                </section>
              ))}
              {canWrite && version.status !== "active" ? (
                <Button
                  disabled={!exact || blocked || activate.isPending}
                  onClick={() => activate.mutate(version.id)}
                >
                  {t("nationalCatalog.activate")}
                </Button>
              ) : null}
            </article>
          );
        })}
      </div>
      {schemas.data?.versions.length === 0 ? <p>{t("nationalCatalog.empty")}</p> : null}
    </section>
  );
}
