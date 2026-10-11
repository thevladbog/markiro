import type { ImageMetadata } from "astro";

import districtTall from "../assets/film/district-tall.jpg";
import districtWide from "../assets/film/district-wide.jpg";
import kioskTall from "../assets/film/kiosk-tall.jpg";
import kioskWide from "../assets/film/kiosk-wide.jpg";
import lineTall from "../assets/film/line-tall.jpg";
import lineWide from "../assets/film/line-wide.jpg";
import officeTall from "../assets/film/office-tall.jpg";
import officeWide from "../assets/film/office-wide.jpg";
import offlineTall from "../assets/film/offline-tall.jpg";
import offlineWide from "../assets/film/offline-wide.jpg";
import packingTall from "../assets/film/packing-tall.jpg";
import packingWide from "../assets/film/packing-wide.jpg";
import warehouseTall from "../assets/film/warehouse-tall.jpg";
import warehouseWide from "../assets/film/warehouse-wide.jpg";
import type { FilmChapterId } from "./film";

export interface FilmPoster {
  readonly wide: ImageMetadata;
  readonly tall: ImageMetadata;
}

const POSTERS: Readonly<Record<FilmChapterId, FilmPoster>> = {
  district: { wide: districtWide, tall: districtTall },
  line: { wide: lineWide, tall: lineTall },
  packing: { wide: packingWide, tall: packingTall },
  warehouse: { wide: warehouseWide, tall: warehouseTall },
  offline: { wide: offlineWide, tall: offlineTall },
  kiosk: { wide: kioskWide, tall: kioskTall },
  office: { wide: officeWide, tall: officeTall },
};

export function posterFor(id: FilmChapterId): FilmPoster {
  return POSTERS[id];
}
