import { getViteConfig } from "astro/config";

// Astro's Vite config, so tests can import and render `.astro` components
// directly instead of only asserting against a full site build.
export default getViteConfig({});
