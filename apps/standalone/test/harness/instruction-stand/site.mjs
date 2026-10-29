// The stand's site: everything a person types is fixed here, so every run builds the same
// organization, catalog, staff and shifts.

export const ADMIN = { login: "admin", name: "Анна Смирнова", password: "stand-admin-1" };

export const ORG = {
  name: "ООО «Родник»",
  inn: "7727012347",
  gln: "4601234567008",
};

export const LINES = ["Линия розлива 1", "Линия розлива 2"];

/** The address the screens show for the host: a LAN address, as on a site. */
export const HOST_ADDRESS = "https://192.168.10.5:45710";

export const PRODUCTS = [
  {
    key: "still05",
    gtin14: "04601234567015",
    name: "Вода питьевая «Родник» негазированная 0,5 л",
    printName: "Вода «Родник» негаз. 0,5 л",
    chzProductGroupCode: 13,
    boxCapacity: 12,
    palletBoxCapacity: 60,
    shelfLifeDays: 365,
    photo: true,
  },
  {
    key: "sparkling15",
    gtin14: "04601234567022",
    name: "Вода питьевая «Родник» газированная 1,5 л",
    printName: "Вода «Родник» газ. 1,5 л",
    chzProductGroupCode: 13,
    boxCapacity: 6,
    palletBoxCapacity: 84,
    shelfLifeDays: 365,
  },
  {
    key: "kids033",
    gtin14: "04601234567039",
    name: "Вода детская «Родничок» 0,33 л",
    printName: "Вода детская «Родничок» 0,33 л",
    chzProductGroupCode: 13,
    boxCapacity: 24,
    palletBoxCapacity: 50,
    shelfLifeDays: 540,
  },
];

export const OPERATORS = [
  {
    login: "1001",
    name: "Иванов Сергей",
    role: "Оператор линии",
    pin: "2580",
    badge: "RODNIK-BADGE-1001",
  },
  {
    login: "1002",
    name: "Петрова Мария",
    role: "Оператор линии",
    pin: "1470",
    badge: "RODNIK-BADGE-1002",
  },
  { login: "1003", name: "Кузнецов Алексей", role: "Наладчик", pin: "3690" },
];

/** The station on line 1 and its name in the office. */
export const STATION = { name: "Станция линии 1", line: 0 };

/** The day the stand's shifts are made for: the browser's clock stands on it. */
export const PRODUCTION_DATE = "2026-10-29";
export const NEXT_DATE = "2026-10-30";
/** When the seed starts, for the host and the browser alike: 10:40 Moscow on the production day. */
export const BROWSER_TIME = "2026-10-29T07:40:00Z";

const GS = "\u001d";

/** Code of marking `n` of product `gtin14`, shaped like a real water code (AI 01, 21, 91, 92). */
export function markingCode(gtin14, n) {
  const serial = `RDN${String(n).padStart(10, "0")}`;
  const signature = `StandSignature${String(n).padStart(6, "0")}`.padEnd(44, "Q");
  return `01${gtin14}21${serial}${GS}91EE10${GS}92${signature}`;
}
