import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  minify: false,
  sourcemap: false,
  // Prepend the shebang so `dist/cli.js` is directly executable as the `bin`.
  banner: {
    js: "#!/usr/bin/env node",
  },
});
