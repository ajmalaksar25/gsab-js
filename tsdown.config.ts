import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/node.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  platform: "neutral", // isomorphic: no Node-only globals baked in
});
