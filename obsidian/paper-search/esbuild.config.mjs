import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view"],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  const pluginsDir = path.join(os.homedir(), "Documents", "Obsidian Vault", ".obsidian", "plugins");
  if (fs.existsSync(pluginsDir)) {
    const linkPath = path.join(pluginsDir, "daito-paper-search");
    try {
      const st = fs.lstatSync(linkPath);
      if (st.isSymbolicLink() || st.isFile()) {
        fs.unlinkSync(linkPath);
      }
    } catch {}
    try {
      if (!fs.existsSync(linkPath)) {
        fs.symlinkSync(process.cwd(), linkPath, "dir");
      }
    } catch {}
  }
  process.exit(0);
} else {
  await context.watch();
}
