import { rm } from "fs/promises";
import path from "path";

/**
 * e2e/global-setup.ts — full-suite `.memory/` isolation (PR #41 round-2 review).
 *
 * Every spec that submits a real URL against the pinned maxtechera.dev target (m1b, m2, m2b,
 * m3, the ux specs, …) now ALSO triggers M4's debounced fire-and-forget autosave (app/page.tsx),
 * which writes to `.memory/<hostname>/` — that's correct product behavior (site memory is
 * meant to persist from every analysis), but it turns `.memory/` into an unintentional
 * cross-test/cross-file side channel: an unrelated spec's real extraction can silently
 * overwrite `.memory/maxtechera.dev/` state that e2e/m4-memory.spec.ts's resume fixtures then
 * hydrate (and its own dying autosave can re-clobber the NEXT test's seed right back).
 *
 * Fix: clear the whole `.memory/` tree ONCE before the run — every test starts from a clean
 * slate, same as a fresh install. This runs once for the whole suite (not per-test): m4's own
 * resume tests deliberately read/write `.memory/maxtechera.dev/` across a single test's two
 * phases, and are already `test.describe.serial` so they never race EACH OTHER either.
 */
export default async function globalSetup(): Promise<void> {
  await rm(path.join(process.cwd(), ".memory"), { recursive: true, force: true });
}
