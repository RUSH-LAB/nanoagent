// Builds the runner as one minified bundle, dist/index.js, that runs with plain node and needs no
// node_modules beside it; dist/models.js, the catalog, imports it.
import {readFileSync} from "node:fs";
import {build} from "esbuild";

// The release of PI the bundle holds, read from the package it bundles: the runner reports it as the harness's version.
const piVersion = JSON.parse(readFileSync("node_modules/@earendil-works/pi-coding-agent/package.json", "utf8")).version;

const common = {
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: ["src/index.ts"],
  define: {PI_VERSION: JSON.stringify(piVersion)},
  outfile: "dist/index.js",
  // Some SDKs pi-ai bundles require() Node's modules, which an ES module has no require for.
  banner: {js: 'import{createRequire}from"node:module";const require=createRequire(import.meta.url);'},
});
await build({...common, entryPoints: ["src/models.ts"], outfile: "dist/models.js", external: ["./index.js"]});
