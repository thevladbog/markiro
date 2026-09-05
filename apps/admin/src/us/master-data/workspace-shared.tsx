import type { CSSProperties } from "react";
import { Button } from "@markiro/ui";
import type { UsLocation, UsParty } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import type { UsBrowserClient } from "../client.js";

export type ArchiveFilter = "false" | "true" | "all";
export type NoticeKind = "status" | "alert";
export type MutationRelease = () => void;

export type MasterDataViewProps = {
  client: UsBrowserClient;
  canWrite: boolean;
  mutationPending: boolean;
  beginMutation: () => MutationRelease;
  onDirtyChange: (dirty: boolean) => void;
  onNotice: (kind: NoticeKind, key: string) => void;
  onForbidden: () => Promise<void>;
  onClientFailure: (error: unknown, fallbackKey: string) => void;
  onSessionLost: () => void;
};

export const roleKeys = {
  supplier: "roleSupplier",
  processor: "roleProcessor",
  ship_from: "roleShipFrom",
  receive_at: "roleReceiveAt",
  recipient: "roleRecipient",
  tlc_source: "roleTlcSource",
} as const;

export function partyContact(party: UsParty): string {
  return party.contactEmail ?? party.contactPhone ?? party.contactName ?? "—";
}

export function locationCityRegion(location: UsLocation): string {
  return [location.city, location.stateOrRegion].filter(Boolean).join(", ") || "—";
}

export function navStyle(active: boolean): CSSProperties {
  return {
    justifyContent: "flex-start",
    background: active ? "var(--mk-rail-bg-active)" : "transparent",
    color: active ? "var(--mk-rail-fg)" : "var(--mk-rail-muted)",
    border: "1px solid transparent",
    borderLeft: `3px solid ${active ? "var(--accent-module)" : "transparent"}`,
  };
}

export function Pager({
  page,
  hasPrevious,
  hasNext,
  disabled,
  onPrevious,
  onNext,
}: {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  disabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="us-md-pager">
      <Button
        variant="secondary"
        size="compact"
        disabled={disabled || !hasPrevious}
        onClick={onPrevious}
      >
        {t("md.previousPage")}
      </Button>
      <span>{t("md.page", { page })}</span>
      <Button variant="secondary" size="compact" disabled={disabled || !hasNext} onClick={onNext}>
        {t("md.nextPage")}
      </Button>
    </div>
  );
}
