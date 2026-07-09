// scripts/com-load.mjs — loads the REAL lib/com.ts (deterministic core + scoreVariant) into a
// plain Node .mjs runner (scripts/com-check.mjs, scripts/eval.mjs) via an esbuild bundle-and-import,
// not a hand-duplicated copy. Issue #45: the COM sanity suite must exercise the actual scorer so a
// mutation to lib/com.ts's math is caught here, not just in a stand-in.
//
// Same "standalone runner, no TS transpilation via ts-node/tsx" constraint scripts/com-check.mjs
// already documented for the LLM prompt/schema — esbuild (already a devDependency, used the same
// way by scripts/build-runtime.mjs) bundles lib/com.ts to ESM, external-izing its real runtime
// deps (ai, @ai-sdk/anthropic, zod) so they resolve normally from node_modules, then we write the
// bundle to a throwaway temp file (os.tmpdir(), never the repo) and dynamic-import it.

import { build } from "esbuild";
import { writeFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/** loadCom(): bundles lib/com.ts and returns its exports
 *  ({ computeDeterministicScore, scoreVariant }). */
export async function loadCom() {
  const result = await build({
    entryPoints: [join(ROOT, "lib", "com.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    external: ["ai", "@ai-sdk/anthropic", "zod"],
  });
  const code = result.outputFiles[0].text;

  // Written under the repo root (not os.tmpdir()) so `external`'s bare specifiers ("ai", ...)
  // resolve against this project's node_modules; deleted immediately after import.
  // .tmp-com-bundle-*.mjs is gitignored (see .gitignore) as a further guard against a stray
  // file surviving a crashed run.
  const tmpFile = join(ROOT, `.tmp-com-bundle-${process.pid}-${Date.now()}.mjs`);
  await writeFile(tmpFile, code, "utf-8");
  try {
    return await import(pathToFileURL(tmpFile).href);
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}
