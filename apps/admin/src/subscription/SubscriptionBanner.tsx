import { Link } from "react-router";
import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import { useAccess } from "../access/context.js";

function daysRemaining(endsAt: string | null): number | null {
  if (!endsAt) return null;
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000));
}

export function SubscriptionBanner() {
  const { t } = useTranslation();
  const access = useAccess();
  const subscription = access.subscription;
  if (!subscription || subscription.status === "unmanaged") return null;
  const days = daysRemaining(subscription.endsAt);
  const message =
    subscription.status === "pending_activation"
      ? t("subscription.banner.pending")
      : subscription.status === "trial" && days !== null
        ? t("subscription.banner.trial", { days })
        : subscription.status === "expired" || subscription.access === "read_only"
          ? t("subscription.banner.expired")
          : access.quotas &&
              access.usage &&
              Object.entries(access.quotas).some(
                ([key, limit]) =>
                  limit !== null && (access.usage?.[key as keyof typeof access.usage] ?? 0) > limit,
              )
            ? t("subscription.banner.overLimit")
            : null;
  if (!message) return null;
  return (
    <Alert tone={subscription.access === "read_only" ? "error" : "warn"}>
      <span>{message}</span>{" "}
      <Link to="/settings/subscription">{t("subscription.banner.link")}</Link>
    </Alert>
  );
}
