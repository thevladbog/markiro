import { fileURLToPath } from "node:url";
import base from "../../vite.config.ts";

export default {
  ...base,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  build: {
    ...base.build,
    rolldownOptions: {
      ...base.build.rolldownOptions,
      input: fileURLToPath(new URL("./bundled-logo.html", import.meta.url)),
    },
  },
};
