import { LandingLeadNotificationEmail } from "../src/landing-lead-notification.js";

export default function LandingLeadNotificationPreview() {
  return (
    <LandingLeadNotificationEmail
      intent="invoice"
      locale="ru"
      requestId="11111111-1111-4111-8111-111111111111"
      receivedAt={new Date("2026-10-21T09:00:00Z")}
      sourcePath="/stoimost/"
      consentVersion="2026-08-14"
      company="ООО «Пивоварня»"
      email="buyer@example.test"
      inn="7707083893"
      tariffCode="line"
      productGroup="Пиво и сидр"
      linesBucket="1"
      utm={{ source: "yandex", medium: "cpc" }}
      firstContact={false}
      leadUrl="https://admin.markiro.app/leads/22222222-2222-4222-8222-222222222222"
    />
  );
}
