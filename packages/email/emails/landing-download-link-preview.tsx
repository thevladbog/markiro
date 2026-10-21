import { LandingDownloadLinkEmail } from "../src/landing-download-link.js";

export default function LandingDownloadLinkPreview() {
  return (
    <LandingDownloadLinkEmail
      locale="ru"
      company="ООО «Пивоварня»"
      downloadPageUrl="https://markiro.app/skachat/"
      contactEmail="hello@v-b.tech"
    />
  );
}
