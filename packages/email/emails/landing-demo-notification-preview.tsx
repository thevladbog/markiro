import { LandingDemoNotificationEmail } from "../src/landing-demo-notification.js";

export default function LandingDemoNotificationPreview() {
  return (
    <LandingDemoNotificationEmail
      locale="en"
      requestId="11111111-1111-4111-8111-111111111111"
      receivedAt={new Date("2026-08-14T12:00:00Z")}
      sourcePath="/en/"
      consentVersion="2026-08-14"
      recipientName="Ada Lovelace"
      company="Factory & Co"
      email="ada@example.test"
      phone="+12025550114"
    />
  );
}
