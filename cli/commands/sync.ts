import { join } from "node:path";
import { run } from "../exec";
import { repositoryInfo } from "../github";
import { KitError, type Settings } from "../settings";
import { loadLocalConfig, loadSettings, tempDir } from "../store";
import { appFiles } from "../templates";
import { KIT_DIR } from "../tofu";

const MANAGED = "Managed by project-kit";
const BRANCH = "feature/project-kit-workflows";

/** Opens a pull request in the app repository that adds or updates the kit's caller workflows. */
export async function sync(name: string | undefined, options: { ref?: string; base?: string }): Promise<void> {
  if (!name) throw new KitError("Usage: kit sync <name> [--ref <kit commit>] [--base <branch>]");
  const config = await loadLocalConfig();
  const settings = await loadSettings(config, name);
  const { ref, version } = await kitRef(options.ref);

  const repo = await repositoryInfo(settings.repository);
  if (!repo) throw new KitError(`Can't read ${settings.repository}.`);
  const base = options.base ?? repo.defaultBranch;

  const dir = await tempDir();
  await run(["gh", "repo", "clone", settings.repository, dir, "--", "--depth", "1", "--branch", base, "--quiet"]);
  const git = (...args: string[]) => run(["git", "-C", dir, ...args]);
  await git("checkout", "-b", BRANCH);

  await writeAppFiles(dir, settings, ref, version);

  await git("add", "-A");
  const { code } = await run(["git", "-C", dir, "diff", "--cached", "--quiet"], { allowFailure: true });
  if (code === 0) {
    console.log(`${settings.repository} already has these workflows.`);
    return;
  }
  await git("commit", "-m", `Use project-kit workflows ${version}`);
  await git("push", "--force-with-lease", "origin", BRANCH);
  const body = [
    `Adds or updates the caller workflows of [project-kit](https://github.com/Heknon/project-kit) at ${ref.slice(0, 7)} (${version}).`,
    "",
    "- `preview.yml`: a preview deployment (and database branch) per pull request, then the `check` script.",
    "- `deploy.yml`: `dev` deploys dev; the production branch deploys production after `test:full`.",
    "- `dependabot.yml`: kit releases arrive as pull requests.",
    "",
    "The workflows read only GitHub environment secrets written by `kit apply`. Contract: docs/contract.md in the kit.",
  ].join("\n");
  await run(["gh", "pr", "create", "--repo", settings.repository, "--base", base, "--head", BRANCH, "--title", `Use project-kit workflows ${version}`, "--body", body], {
    inherit: true,
    allowFailure: true,
  });
}

/** Writes the caller workflows; a dependabot.yml that isn't the kit's is left alone. */
export async function writeAppFiles(dir: string, settings: Settings, ref: string, version: string): Promise<void> {
  for (const [path, content] of Object.entries(appFiles(settings, ref, version))) {
    const file = Bun.file(join(dir, path));
    if (path.endsWith("dependabot.yml") && (await file.exists()) && !(await file.text()).includes(MANAGED)) {
      console.log(`${path} exists and isn't the kit's; add a github-actions entry to it yourself.`);
      continue;
    }
    await Bun.write(file, content);
  }
}

export async function kitRef(override?: string): Promise<{ ref: string; version: string }> {
  const ref = override ?? (await run(["git", "-C", KIT_DIR, "rev-parse", "HEAD"])).stdout.trim();
  const remote = await run(["git", "-C", KIT_DIR, "branch", "-r", "--contains", ref], { allowFailure: true });
  if (!remote.stdout.trim()) throw new KitError(`Kit commit ${ref.slice(0, 7)} isn't pushed; app repositories can't call it yet.`);
  const version = (await run(["git", "-C", KIT_DIR, "describe", "--tags", "--always", ref])).stdout.trim();
  return { ref, version };
}
