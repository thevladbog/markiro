import { createContext, useContext, type ReactNode } from "react";

import { createTauriAboutApi, type AboutApi } from "./about-api.js";

/** The shell and the webview as «Информация» reads them; a test passes its own through `AboutProvider`. */
export const TAURI_ABOUT: AboutApi = createTauriAboutApi();

const AboutContext = createContext<AboutApi>(TAURI_ABOUT);

export function AboutProvider({ value, children }: { value: AboutApi; children: ReactNode }) {
  return <AboutContext value={value}>{children}</AboutContext>;
}

export function useAbout(): AboutApi {
  return useContext(AboutContext);
}
