import type { ImageMetadata } from "astro";

import filmPage from "../assets/home/film-page.jpg";
import cosmeticsLabel from "../assets/home/labels/cosmetics-box.png";
import juicesLabel from "../assets/home/labels/juices-box.png";
import mapPhone from "../assets/home/map-phone.jpg";
import mapWide from "../assets/home/map-wide.jpg";
import cabinetChzEn from "../assets/home/screens/en/cabinet-chz.png";
import cabinetShiftsEn from "../assets/home/screens/en/cabinet-shifts.png";
import stationAggregationEn from "../assets/home/screens/en/station-aggregation.png";
import stationBoxEn from "../assets/home/screens/en/station-box.png";
import stationConflictsEn from "../assets/home/screens/en/station-conflicts.png";
import stationOfflineEn from "../assets/home/screens/en/station-offline.png";
import cabinetChzRu from "../assets/home/screens/ru/cabinet-chz.png";
import cabinetShiftsRu from "../assets/home/screens/ru/cabinet-shifts.png";
import handheld from "../assets/home/screens/ru/handheld.png";
import kiosk from "../assets/home/screens/ru/kiosk.png";
import stationAggregationRu from "../assets/home/screens/ru/station-aggregation.png";
import stationBoxRu from "../assets/home/screens/ru/station-box.png";
import stationConflictsRu from "../assets/home/screens/ru/station-conflicts.png";
import stationOfflineRu from "../assets/home/screens/ru/station-offline.png";
import type { PlantSpotId } from "../scripts/film/world/plant";
import type { Locale } from "./pages";

export type HomeScreenId =
  | "station-aggregation"
  | "station-box"
  | "station-offline"
  | "station-conflicts"
  | "handheld"
  | "kiosk"
  | "cabinet-shifts"
  | "cabinet-chz";

// The kiosk and the handheld ship a Russian interface, so both locales show the Russian frames.
const SCREENS: Readonly<Record<Locale, Readonly<Record<HomeScreenId, ImageMetadata>>>> = {
  ru: {
    "station-aggregation": stationAggregationRu,
    "station-box": stationBoxRu,
    "station-offline": stationOfflineRu,
    "station-conflicts": stationConflictsRu,
    handheld,
    kiosk,
    "cabinet-shifts": cabinetShiftsRu,
    "cabinet-chz": cabinetChzRu,
  },
  en: {
    "station-aggregation": stationAggregationEn,
    "station-box": stationBoxEn,
    "station-offline": stationOfflineEn,
    "station-conflicts": stationConflictsEn,
    handheld,
    kiosk,
    "cabinet-shifts": cabinetShiftsEn,
    "cabinet-chz": cabinetChzEn,
  },
};

export function homeScreen(locale: Locale, id: HomeScreenId): ImageMetadata {
  return SCREENS[locale][id];
}

/** The screen each map hotspot previews in its tooltip. */
export const SPOT_SCREENS: Readonly<Record<PlantSpotId, HomeScreenId>> = {
  line: "station-aggregation",
  packing: "station-box",
  warehouse: "handheld",
  kiosk: "kiosk",
  office: "cabinet-shifts",
};

export const HOME_MAP_IMAGE = mapWide;
export const HOME_MAP_PHONE_IMAGE = mapPhone;
export const HOME_FILM_PAGE_IMAGE = filmPage;
export const HOME_LABELS = { juices: juicesLabel, cosmetics: cosmeticsLabel } as const;

export type HomeCoverCode = "mkr-ins-01" | "mkr-ins-02" | "mkr-ins-09";

const COVERS = import.meta.glob<{ default: ImageMetadata }>("../assets/home/docs/*.png", {
  eager: true,
});

/** The first page of the newest published release (the file name carries the release). */
export function homeCover(locale: Locale, code: HomeCoverCode): ImageMetadata {
  const entry = Object.entries(COVERS).find(
    ([file]) => file.includes(`/${code}_`) && file.endsWith(`_${locale}.png`),
  );
  if (entry === undefined) throw new Error(`missing home cover ${code} (${locale})`);
  return entry[1].default;
}
