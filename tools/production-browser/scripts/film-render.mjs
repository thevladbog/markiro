import { spawn } from "node:child_process";
import path from "node:path";

export const toolRoot = path.resolve(import.meta.dirname, "..");
export const landingRoot = path.resolve(toolRoot, "../../apps/landing");
export const baseUrl = "http://127.0.0.1:5473";
export const filmUrl = `${baseUrl}/kak-rabotaet/?film-tier=high&film-budget=off`;

// Scene renders carry the scene only: the pages draw their own text over them.
export const SCENE_ONLY = `
  .film-top, .film-hero, .film-card, .film__rail, [data-consent-panel],
  .film-chapter__poster, .film-chapter--hero::before { visibility: hidden !important; }
`;

export const HIDE_CONSENT = "[data-consent-panel] { display: none !important; }";

export async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error("landing server exited early");
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("landing server did not start");
}

/** Builds and serves the landing on port 5473; returns the child process. */
export async function startLandingServer() {
  const server = spawn(process.execPath, [path.join(toolRoot, "scripts/serve-landing.mjs")], {
    stdio: "inherit",
  });
  try {
    await waitForServer(`${baseUrl}/kak-rabotaet/`, server);
  } catch (error) {
    server.kill("SIGTERM");
    throw error;
  }
  return server;
}

/** Opens the film, waits for the live scene. */
export async function openLiveFilm(page, { sceneOnly }) {
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[page] ${message.text()}`);
  });
  await page.goto(filmUrl, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: sceneOnly ? SCENE_ONLY : HIDE_CONSENT });
  await page.evaluate(() => window.scrollBy({ top: 1, behavior: "instant" }));
  await page.waitForFunction(
    () => document.querySelector("[data-film]")?.classList.contains("film--live"),
    null,
    { timeout: 120_000 },
  );
}

export async function scrollToFilmTime(page, filmTime) {
  await page.evaluate((target) => {
    const sections = [...document.querySelectorAll("[data-film-chapter]")];
    const index = Math.min(sections.length - 1, Math.floor(target));
    const local = target - index;
    const section = sections[index];
    const top = section.getBoundingClientRect().top + window.scrollY;
    const viewport = window.innerHeight;
    const y =
      index === 0
        ? top + local * (section.offsetHeight - viewport)
        : top - viewport + local * section.offsetHeight;
    window.scrollTo({ top: Math.round(y), behavior: "instant" });
  }, filmTime);
  await page.waitForFunction(
    (target) =>
      Math.abs(Number(document.querySelector("[data-film]")?.dataset.filmTime ?? -1) - target) <
      0.01,
    filmTime,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(500);
}
