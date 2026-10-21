import { describe, expect, it } from "vitest";

import {
  captureFirstTouch,
  FIRST_TOUCH_STORAGE_KEY,
  firstTouchFrom,
  readFirstTouch,
  type SessionStore,
} from "./first-touch";

function memoryStore(): SessionStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("first touch", () => {
  it("keeps the five UTM fields and an external referrer", () => {
    const url = new URL(
      "https://markiro.app/stoimost/?utm_source=yandex&utm_medium=cpc&utm_campaign=pivo&utm_content=a&utm_term=%D0%B0%D0%B3%D1%80%D0%B5%D0%B3%D0%B0%D1%86%D0%B8%D1%8F&gclid=x",
    );
    expect(firstTouchFrom(url, "https://yandex.ru/search/?text=x")).toEqual({
      utm: { source: "yandex", medium: "cpc", campaign: "pivo", content: "a", term: "агрегация" },
      referrer: "https://yandex.ru/search/?text=x",
    });
  });

  it("ignores the site itself and non-web referrers", () => {
    const url = new URL("https://markiro.app/skachat/");
    expect(firstTouchFrom(url, "https://markiro.app/")).toEqual({});
    expect(firstTouchFrom(url, "android-app://org.telegram")).toEqual({});
    expect(firstTouchFrom(url, "not a url")).toEqual({});
  });

  it("records the first page of the session and leaves it alone afterwards", () => {
    const store = memoryStore();
    captureFirstTouch(store, new URL("https://markiro.app/?utm_source=vc"), "https://vc.ru/");
    captureFirstTouch(store, new URL("https://markiro.app/skachat/?utm_source=other"), "");
    expect(readFirstTouch(store)).toEqual({ utm: { source: "vc" }, referrer: "https://vc.ru/" });
  });

  it("remembers a direct visit so a later tagged link does not rewrite the source", () => {
    const store = memoryStore();
    captureFirstTouch(store, new URL("https://markiro.app/"), "");
    captureFirstTouch(store, new URL("https://markiro.app/?utm_source=late"), "");
    expect(store.values.get(FIRST_TOUCH_STORAGE_KEY)).toBe("{}");
    expect(readFirstTouch(store)).toEqual({});
  });

  it("drops damaged or foreign values instead of sending them", () => {
    const store = memoryStore();
    store.setItem(FIRST_TOUCH_STORAGE_KEY, "{");
    expect(readFirstTouch(store)).toEqual({});
    store.setItem(
      FIRST_TOUCH_STORAGE_KEY,
      JSON.stringify({ utm: { source: 5, medium: "cpc", extra: "x" }, referrer: 3 }),
    );
    expect(readFirstTouch(store)).toEqual({ utm: { medium: "cpc" } });
  });

  it("survives disabled storage", () => {
    const broken: SessionStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => captureFirstTouch(broken, new URL("https://markiro.app/"), "")).not.toThrow();
    expect(readFirstTouch(broken)).toEqual({});
  });
});
