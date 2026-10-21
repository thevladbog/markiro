import { LandingLeadDigestEmail } from "../src/landing-lead-digest.js";

export default function LandingLeadDigestPreview() {
  return (
    <LandingLeadDigestEmail
      digestDate="2026-10-21"
      leadsUrl="https://admin.markiro.app/leads"
      sections={[
        {
          section: "new_uncontacted",
          leads: [
            {
              company: "ООО «Пивоварня»",
              leadUrl: "https://admin.markiro.app/leads/22222222-2222-4222-8222-222222222222",
            },
          ],
        },
        {
          section: "day_3",
          leads: [
            {
              company: "Сидрерия «Яблоко»",
              leadUrl: "https://admin.markiro.app/leads/33333333-3333-4333-8333-333333333333",
            },
          ],
        },
      ]}
    />
  );
}
