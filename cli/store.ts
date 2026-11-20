import { homedir } from "node:os";
import { join } from "node:path";
import { json, run } from "./exec";
import { remote } from "./mode";
import { KitError, parseSettings, type Settings } from "./settings";

/** Where the kit finds its state bucket; nothing in it is secret. */
export interface LocalConfig {
  bucket: string;
  region: string;
  profile?: string;
  /** Vercel teams whose functions may assume roles in the AWS account. */
  accountTeams?: string[];
  /** The private repository whose workflows run the kit for standard projects. */
  controlRepository?: string;
  /** What `kit new` uses when no flag says otherwise. */
  defaults?: {
    vercelTeamSlug?: string;
    neonOrgId?: string;
    features?: string[];
  };
}

const LOCAL_CONFIG = join(homedir(), ".project-kit.json");

/**
 * On your machine: ~/.project-kit.json. In the control repository's workflows: environment
 * variables (KIT_STATE_BUCKET, KIT_STATE_REGION, KIT_VERCEL_TEAM, KIT_NEON_ORG, KIT_FEATURES).
 */
export async function loadLocalConfig(): Promise<LocalConfig> {
  if (process.env.KIT_STATE_BUCKET) {
    return {
      bucket: process.env.KIT_STATE_BUCKET,
      region: process.env.KIT_STATE_REGION ?? "eu-central-1",
      defaults: {
        vercelTeamSlug: process.env.KIT_VERCEL_TEAM,
        neonOrgId: process.env.KIT_NEON_ORG,
        features: process.env.KIT_FEATURES?.split(",").map((f) => f.trim()),
      },
    };
  }
  const file = Bun.file(LOCAL_CONFIG);
  if (!(await file.exists())) throw new KitError("This machine isn't set up. Run `kit init`.");
  return (await file.json()) as LocalConfig;
}

export async function saveLocalConfig(config: LocalConfig): Promise<void> {
  await Bun.write(LOCAL_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
}

export function awsEnv(config: Pick<LocalConfig, "profile" | "region">): Record<string, string | undefined> {
  return { AWS_PROFILE: config.profile, AWS_REGION: config.region, AWS_PAGER: "" };
}

export function aws(config: LocalConfig, args: string[], stdin?: string) {
  return run(["aws", ...args, "--region", config.region], { env: awsEnv(config), stdin });
}

/**
 * Standard projects live under projects/, isolated ones under isolated/. The control
 * repository's AWS role can only read projects/, so it never sees an isolated project's state
 * (database passwords, auth secrets).
 */
export type Folder = "projects" | "isolated";

export function folderOf(settings: Pick<Settings, "security">): Folder {
  return settings.security === "isolated" ? "isolated" : "projects";
}

export function stateKey(folder: Folder, name: string): string {
  return `${folder}/${name}/tofu.tfstate`;
}

function settingsKey(folder: Folder, name: string): string {
  return `${folder}/${name}/settings.json`;
}

async function readSettings(config: LocalConfig, folder: Folder, name: string): Promise<Settings | null> {
  const result = await run(["aws", "s3", "cp", `s3://${config.bucket}/${settingsKey(folder, name)}`, "-", "--region", config.region], {
    env: awsEnv(config),
    allowFailure: true,
  });
  if (result.code === 0) return parseSettings(JSON.parse(result.stdout));
  if (/404|NoSuchKey|does not exist|AccessDenied|403/i.test(result.stderr)) return null;
  throw new KitError(`Couldn't read the settings of ${name}: ${result.stderr.trim()}`);
}

export async function findFolder(config: LocalConfig, name: string): Promise<Folder | null> {
  for (const folder of remote() ? (["projects"] as const) : (["projects", "isolated"] as const)) {
    if (await readSettings(config, folder, name)) return folder;
  }
  return null;
}

export async function loadSettings(config: LocalConfig, name: string): Promise<Settings> {
  for (const folder of remote() ? (["projects"] as const) : (["projects", "isolated"] as const)) {
    const settings = await readSettings(config, folder, name);
    if (settings) return settings;
  }
  throw new KitError(`No project named ${name}. Run \`kit new ${name}\`.`);
}

export async function saveSettings(config: LocalConfig, settings: Settings): Promise<void> {
  const body = `${JSON.stringify(parseSettings(settings), null, 2)}\n`;
  const key = settingsKey(folderOf(settings), settings.name);
  await aws(config, ["s3", "cp", "-", `s3://${config.bucket}/${key}`, "--content-type", "application/json"], body);
}

export async function listProjects(config: LocalConfig): Promise<string[]> {
  const names: string[] = [];
  for (const folder of remote() ? (["projects"] as const) : (["projects", "isolated"] as const)) {
    const result = await json<{ CommonPrefixes?: { Prefix: string }[] }>(
      ["aws", "s3api", "list-objects-v2", "--bucket", config.bucket, "--prefix", `${folder}/`, "--delimiter", "/", "--region", config.region],
      { env: awsEnv(config) },
    );
    const suffix = folder === "isolated" ? " (isolated)" : "";
    names.push(...(result.CommonPrefixes ?? []).map((p) => `${p.Prefix.slice(folder.length + 1, -1)}${suffix}`));
  }
  return names.sort();
}

export async function settingsVersions(config: LocalConfig, name: string): Promise<{ id: string; modified: string }[]> {
  const folder = (await findFolder(config, name)) ?? "projects";
  const key = settingsKey(folder, name);
  const result = await json<{ Versions?: { VersionId: string; LastModified: string; Key: string }[] }>(
    ["aws", "s3api", "list-object-versions", "--bucket", config.bucket, "--prefix", key, "--region", config.region],
    { env: awsEnv(config) },
  );
  return (result.Versions ?? []).filter((v) => v.Key === key).map((v) => ({ id: v.VersionId, modified: v.LastModified }));
}

export async function loadSettingsVersion(config: LocalConfig, name: string, versionId: string): Promise<string> {
  const folder = (await findFolder(config, name)) ?? "projects";
  const dir = await tempDir();
  const out = join(dir, "settings.json");
  await aws(config, ["s3api", "get-object", "--bucket", config.bucket, "--key", settingsKey(folder, name), "--version-id", versionId, out]);
  return Bun.file(out).text();
}

export async function tempDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  return mkdtemp(join(tmpdir(), "project-kit-"));
}

export async function deleteSettings(config: LocalConfig, settings: Settings): Promise<void> {
  await aws(config, ["s3", "rm", `s3://${config.bucket}/${settingsKey(folderOf(settings), settings.name)}`]);
}
