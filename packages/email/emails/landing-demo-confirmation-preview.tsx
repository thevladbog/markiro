import { LandingDemoConfirmationEmail } from "../src/landing-demo-confirmation.js";

export default function LandingDemoConfirmationPreview() {
  return (
    <LandingDemoConfirmationEmail
      locale="en"
      requestId="11111111-1111-4111-8111-111111111111"
      recipientName="Ada Lovelace"
      company="Factory & Co"
      email="ada@example.test"
      contactEmail="hello@v-b.tech"
    />
  );
}
