import { LandingInvoiceRequestConfirmationEmail } from "../src/landing-invoice-request-confirmation.js";

export default function LandingInvoiceRequestConfirmationPreview() {
  return (
    <LandingInvoiceRequestConfirmationEmail
      locale="ru"
      company="ООО «Пивоварня»"
      inn="7707083893"
      tariffCode="line"
      email="buyer@example.test"
      contactEmail="hello@v-b.tech"
    />
  );
}
