import { createContext, useContext } from "react";

import type { GalleryLocale } from "./gallery-fixtures.js";

/** `instructions` is the gallery's original test data; the printed instructions are shot from it. */
export type GalleryProfileId = "instructions" | "landing";

/** The demo data a visitor sees on gallery screens. */
export interface GalleryProfile {
  readonly productName: string;
  readonly counterpartyName: string | null;
  readonly station: string;
  readonly line: string;
  readonly operator: string;
  readonly shift: string;
  /** The serial of the n-th demo marking code. */
  readonly serial: (n: number) => string;
  /** The label of the n-th demo terminal. */
  readonly terminal: (n: number) => string;
}

const LANDING_SERIALS = [
  "5aB7Kq1Zx9nT4",
  "Q2m8Rd6hT3wP0",
  "9Lk2Vb7Rf4Nq8",
  "cX5tY1uI8oP3a",
  "M4nB6vC2xZ7lK",
  "7jH3gF9dS1aQ5",
  "W2eR8tY4uI6oP",
  "zX1cV5bN9mL3k",
] as const;

function landingSerial(n: number): string {
  return LANDING_SERIALS[Math.abs(n) % LANDING_SERIALS.length] ?? LANDING_SERIALS[0];
}

function instructionSerial(n: number): string {
  return `DEMO-SERIAL-${String(n).padStart(6, "0")}`;
}

const PROFILES: Readonly<
  Record<GalleryProfileId, Readonly<Record<GalleryLocale, GalleryProfile>>>
> = {
  instructions: {
    ru: {
      productName: "Тестовый товар А",
      counterpartyName: "ООО «Тестовый производитель»",
      station: "Демо-станция 01",
      line: "Тестовая линия А",
      operator: "Оператор Тестов",
      shift: "Смена ДЕМО-01",
      serial: instructionSerial,
      terminal: (n) => `DEMO-TERM-${n}`,
    },
    en: {
      productName: "Sample product A",
      counterpartyName: "Sample Manufacturer Ltd",
      station: "Demo station 01",
      line: "Test line A",
      operator: "Sample Operator",
      shift: "Shift DEMO-01",
      serial: instructionSerial,
      terminal: (n) => `DEMO-TERM-${n}`,
    },
  },
  landing: {
    ru: {
      productName: "Сок яблочный, 1 л",
      counterpartyName: null,
      station: "Станция упаковки 1",
      line: "Линия 1",
      operator: "Мария Соколова",
      shift: "Смена 12",
      serial: landingSerial,
      terminal: (n) => `Терминал ${n}`,
    },
    en: {
      productName: "Apple juice, 1 L",
      counterpartyName: null,
      station: "Packing station 1",
      line: "Line 1",
      operator: "Maria Sokolova",
      shift: "Shift 12",
      serial: landingSerial,
      terminal: (n) => `Terminal ${n}`,
    },
  },
};

export function galleryProfile(id: GalleryProfileId, locale: GalleryLocale): GalleryProfile {
  return PROFILES[id][locale];
}

export const GalleryProfileContext = createContext<GalleryProfile>(PROFILES.instructions.ru);

export function useGalleryProfile(): GalleryProfile {
  return useContext(GalleryProfileContext);
}
