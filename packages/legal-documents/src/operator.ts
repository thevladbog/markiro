import type { LegalOperatorProfile, LegalOperatorProfileId } from "./types.js";

export const OPERATOR_PROFILES = {
  "operator-2026-08-15": {
    name: "Богатырев Владислав Сергеевич",
    address:
      "353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26",
    email: "hello@v-b.tech",
    phone: "+7 934 355-14-90",
    site: "https://markiro.app",
  },
} as const satisfies Readonly<Record<LegalOperatorProfileId, LegalOperatorProfile>>;
