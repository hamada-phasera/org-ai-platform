import { build } from "/Users/hamadahiromu/Desktop/AiProject/org-ai-platform/node_modules/esbuild/lib/main.js";
import { readFile } from "node:fs/promises";

await build({
  entryPoints: ["gen-export.mts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "gen-export.bundle.mjs",
  plugins: [{
    name: "raw",
    setup(b) {
      b.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: new URL(args.path.replace(/\?raw$/, ""), "file://" + args.resolveDir + "/").pathname,
        namespace: "raw",
      }));
      b.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({
        contents: `export default ${JSON.stringify(await readFile(args.path, "utf8"))};`,
      }));
    },
  }],
});
