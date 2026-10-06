import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, Button, Input, Spinner } from "@markiro/ui";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { listSupportEpisodes } from "./api.js";
import "./support.css";

export function SupportEpisodesPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const client = useQueryClient();
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: ["platform", "support", principal.userId, "list"] });
      client.removeQueries({ queryKey: ["platform", "support", principal.userId, "list"] });
    },
    [client, principal.userId],
  );
  const [tenant, setTenant] = useState("");
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const canRead = principal.capabilities.includes("billing.read");
  const query = useQuery({
    queryKey: ["platform", "support", principal.userId, "list", filter, cursor],
    queryFn: () => listSupportEpisodes(cursor ?? undefined, filter || undefined),
    enabled: canRead,
    retry: false,
  });
  if (!canRead) return <Alert tone="error">{t("support.forbidden")}</Alert>;
  return (
    <section className="catalog-page platform-support-page">
      <h1>{t("support.title")}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFilter(tenant.trim());
          setCursor(null);
        }}
      >
        <Input
          label={t("support.tenant")}
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
        />
        <Button type="submit">{t("support.filter")}</Button>
      </form>
      {query.isPending ? <Spinner label={t("support.loading")} /> : null}
      {query.isError ? (
        <Alert tone="error">
          {t("support.loadError")}{" "}
          <Button onClick={() => void query.refetch()}>{t("support.retry")}</Button>
        </Alert>
      ) : null}
      {query.data?.items.length === 0 ? <p>{t("support.empty")}</p> : null}
      {query.data && !query.isError ? (
        <ul>
          {query.data.items.map((item) => (
            <li key={item.id}>
              <Link to={`/support/${item.id}`}>
                {item.proposal?.title ?? item.request?.number ?? t("support.question")}
              </Link>
              {item.request ? <span> · {item.request.number}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {query.data?.nextCursor ? (
        <Button variant="secondary" onClick={() => setCursor(query.data.nextCursor)}>
          {t("support.more")}
        </Button>
      ) : null}
    </section>
  );
}
