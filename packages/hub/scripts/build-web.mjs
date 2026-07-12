#!/usr/bin/env node
/**
 * Bundle the hub SPA (src/web/main.tsx) into dist/web/. esbuild resolves from
 * the monorepo root install; its built-in css loader emits assets/main.css
 * alongside assets/main.js (@xyflow/react imports its stylesheet). Pass
 * --watch to rebuild on change during development.
 */
import * as esbuild from "esbuild"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUT = path.join(PKG, "dist", "web")

const options = {
  entryPoints: [path.join(PKG, "src", "web", "main.tsx")],
  outdir: path.join(OUT, "assets"),
  entryNames: "main",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  sourcemap: true,
  logLevel: "info",
  // Self-hosted fonts: @font-face url()s in theme.css resolve to src/web/fonts/*.woff2;
  // the file loader content-hashes each into assets/ and rewrites the url in main.css.
  loader: { ".woff2": "file" },
  define: { "process.env.NODE_ENV": '"production"' },
}

fs.mkdirSync(OUT, { recursive: true })
for (const asset of ["index.html", "favicon.svg"]) {
  fs.copyFileSync(path.join(PKG, "public", asset), path.join(OUT, asset))
}

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log("build-web: watching src/web/ …")
} else {
  await esbuild.build(options)
}
