import { join } from "node:path";
import { run } from "../exec";
import { refuseIsolatedRemotely } from "../mode";
import { confirm } from "../prompt";
import { KitError, parseSettings, type Settings } from "../settings";
import { listProjects, loadLocalConfig, loadSettings, loadSettingsVersion, saveSettings, settingsVersions, tempDir } from "../store";

export async function projects(): Promise<void> {
  const names = await listProjects(await loadLocalConfig());
  console.log(names.length > 0 ? names.join("\n") : "No projects. Create one with `kit new`.");
}

export async function settings(name: string | undefined, options: { edit?: boolean; history?: boolean; set?: string[] }): Promise<void> {
  if (!name) throw new KitError("Usage: kit settings <name> [--edit | --set path=value ... | --history]");
  const config = await loadLocalConfig();

  if (options.history) {
    for (const version of await settingsVersions(config, name)) console.log(`${version.modified}  ${version.id}`);
    return;
  }

  const current = await loadSettings(config, name);
  if (options.set?.length) {
    refuseIsolatedRemotely(current);
    const edited = parseSettings(applyAssignments(current, options.set));
    if (edited.security !== current.security) throw new KitError("--set can't change security; use `kit settings --edit` on your machine.");
    await saveSettings(config, edited);
    console.log(`Saved ${options.set.join(", ")}. Run \`kit apply ${name}\` to make it so.`);
    return;
  }
  if (!options.edit) {
    console.log(JSON.stringify(current, null, 2));
    return;
  }

  const dir = await tempDir();
  const file = join(dir, `${name}.json`);
  await Bun.write(file, `${JSON.stringify(current, null, 2)}\n`);
  try {
    for (;;) {
      await run([...editorCommand(), file], { inherit: true });
      try {
        const edited = parseSettings(JSON.parse(await Bun.file(file).text()));
        if (edited.name !== name) throw new KitError("The name can't change; create a new project instead.");
        await saveSettings(config, edited);
        console.log(`Saved. Run \`kit apply ${name}\` to make it so.`);
        return;
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
        if (!confirm("Edit again?", true)) return;
      }
    }
  } finally {
    await Bun.write(file, "");
  }
}

export async function showVersion(name: string, versionId: string): Promise<void> {
  console.log(await loadSettingsVersion(await loadLocalConfig(), name, versionId));
}

function editorCommand(): string[] {
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (editor) return editor.split(" ");
  if (Bun.which("code")) return ["code", "--wait"];
  return process.platform === "win32" ? ["notepad"] : ["vi"];
}

/**
 * `path=value` assignments, path dotted (domains.production). The value is JSON when it parses
 * (true, 3, ["a"]), a string otherwise. The name can't change.
 */
export function applyAssignments(current: Settings, assignments: string[]): Record<string, unknown> {
  const result = structuredClone(current) as Record<string, unknown>;
  for (const assignment of assignments) {
    const match = /^([A-Za-z][\w.]*)=(.*)$/s.exec(assignment);
    if (!match) throw new KitError(`--set ${assignment}: expected path=value, for example domains.production=app.example.com.`);
    const [, path, raw] = match as unknown as [string, string, string];
    const keys = path.split(".");
    if (keys[0] === "name") throw new KitError("The name can't change; create a new project instead.");
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {}
    let target = result;
    for (const key of keys.slice(0, -1)) {
      const next = target[key];
      if (next === undefined || next === null) target[key] = {};
      else if (typeof next !== "object" || Array.isArray(next)) throw new KitError(`--set ${path}: ${key} isn't an object.`);
      target = target[key] as Record<string, unknown>;
    }
    target[keys.at(-1) as string] = value;
  }
  return result;
}
