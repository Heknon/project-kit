import { cp, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { kitRef, writeAppFiles } from "./commands/sync";
import { run } from "./exec";
import type { Settings } from "./settings";
import { tempDir } from "./store";
import { KIT_DIR } from "./tofu";

/** Files a repository may hold and still count as blank (what `gh repo create` adds). */
const BLANK = new Set(["README.md", "LICENSE", ".gitignore"]);

export async function isBlank(repository: string): Promise<boolean> {
  const result = await run(["gh", "api", `repos/${repository}/contents`, "--jq", ".[].name"], { allowFailure: true });
  if (result.code !== 0) return true;
  return result.stdout.split("\n").filter(Boolean).every((name) => BLANK.has(name));
}

export function starterDir(starter: string): string {
  return join(KIT_DIR, "starters", starter);
}

export async function starterExists(starter: string): Promise<boolean> {
  return stat(join(starterDir(starter), "package.json")).then(
    () => true,
    () => false,
  );
}

/**
 * First commit of a fresh repository: the starter and the caller workflows, straight to the
 * production branch (there is nothing to review yet), then `dev` moved to the same commit.
 * Both pushes start a deploy, so production and dev are live when this returns.
 */
export async function bootstrap(settings: Settings, starter: string): Promise<void> {
  const dir = await tempDir();
  await run(["gh", "repo", "clone", settings.repository, dir, "--", "--quiet"]);
  const git = (...args: string[]) => run(["git", "-C", dir, ...args]);

  await copyStarter(starterDir(starter), dir, settings.name);
  const { ref, version } = await kitRef();
  await writeAppFiles(dir, settings, ref, version);

  await git("add", "-A");
  await git("commit", "-q", "-m", `Start from the project-kit ${starter} starter (${version})`);
  await git("push", "-q", "origin", `HEAD:${settings.productionBranch}`);
  await git("push", "-q", "--force", "origin", `HEAD:dev`);
  console.log(`Pushed the ${starter} starter to ${settings.productionBranch} and dev; both are deploying.`);
}

/** Copies the starter, replacing __APP_NAME__ in text files. */
export async function copyStarter(from: string, to: string, name: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    filter: (source) => !/(^|[\\/])(node_modules|\.next|\.vercel|\.turbo)([\\/]|$)/.test(relative(from, source)),
  });
  for (const file of await walk(to)) {
    const handle = Bun.file(file);
    const text = await handle.text().catch(() => null);
    if (text?.includes("__APP_NAME__")) await Bun.write(file, text.replaceAll("__APP_NAME__", name));
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}
