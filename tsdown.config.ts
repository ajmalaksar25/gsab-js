import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/node.ts", "src/react.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  platform: "neutral", // isomorphic: no Node-only globals baked in
  deps: { neverBundle: [/^node:/] }, // the /node entry's builtins — external by design
});
