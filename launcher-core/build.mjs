import esbuild from "esbuild";
import fs from "node:fs";

const result = await esbuild.build({
  entryPoints: ["src/api.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "neutral",
  outfile: "dist/ranker.js",
  logLevel: "info",
  legalComments: "none",
  metafile: true,
});

// The bundle runs in a bare JSContext: nothing from Node or the browser may be pulled in.
const bad = Object.keys(result.metafile.inputs).filter((p) => /node:|node_modules/.test(p));
if (bad.length) {
  console.error("ranker.js pulled in disallowed inputs:", bad);
  process.exit(1);
}
const src = fs.readFileSync("dist/ranker.js", "utf8");
for (const g of [/\brequire\(/, /\bprocess\./, /(^|[^A-Za-z])Buffer\b/, /\bTextDecoder\b/, /\bTextEncoder\b/, /\bconsole\./, /\bsetTimeout\b/, /\bnew URL\(/]) {
  if (g.test(src)) {
    console.error(`ranker.js references ${g}`);
    process.exit(1);
  }
}
