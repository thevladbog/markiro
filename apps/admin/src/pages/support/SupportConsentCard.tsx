import { useTranslation } from "react-i18next";
import { supportTranscriptNotice, type SupportProposal } from "@markiro/platform-contracts";
import { Alert, Button, Card } from "@markiro/ui";

export function SupportConsentCard({
  proposal,
  busy,
  onDecision,
}: {
  proposal: SupportProposal;
  busy: boolean;
  onDecision: (decision: "accept" | "decline", locale: "ru" | "en") => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith("ru") ? "ru" : "en";
  const notice = supportTranscriptNotice(locale);
  return (
    <Card title={proposal.title} titleAs="h2">
      <p style={{ overflowWrap: "anywhere" }}>{proposal.summary}</p>
      <Alert tone="warn">{notice.text}</Alert>
      <div className="mk-support-actions">
        <Button disabled={busy} onClick={() => onDecision("accept", locale)}>
          {t("support.confirm")}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => onDecision("decline", locale)}>
          {t("support.decline")}
        </Button>
      </div>
    </Card>
  );
}
