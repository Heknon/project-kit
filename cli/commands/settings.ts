import { join } from "node:path";
import { run } from "../exec";
import { confirm } from "../prompt";
import { KitError, parseSettings } from "../settings";
import { listProjects, loadLocalConfig, loadSettings, loadSettingsVersion, saveSettings, settingsVersions, tempDir } from "../store";

export async function projects(): Promise<void> {
  const names = await listProjects(await loadLocalConfig());
  console.log(names.length > 0 ? names.join("\n") : "No projects. Create one with `kit new`.");
}

export async function settings(name: string | undefined, options: { edit?: boolean; history?: boolean }): Promise<void> {
  if (!name) throw new KitError("Usage: kit settings <name> [--edit | --history]");
  const config = await loadLocalConfig();

  if (options.history) {
    for (const version of await settingsVersions(config, name)) console.log(`${version.modified}  ${version.id}`);
    return;
  }

  const current = await loadSettings(config, name);
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
