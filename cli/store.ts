import { homedir } from "node:os";
import { join } from "node:path";
import { json, run } from "./exec";
import { KitError, parseSettings, type Settings } from "./settings";

/** Where this machine finds the kit's state bucket; nothing in it is secret. */
export interface LocalConfig {
  bucket: string;
  region: string;
  profile?: string;
  /** What `kit new` uses when no flag says otherwise. */
  defaults?: {
    vercelTeamSlug?: string;
    neonOrgId?: string;
    features?: string[];
  };
}

const LOCAL_CONFIG = join(homedir(), ".project-kit.json");

export async function loadLocalConfig(): Promise<LocalConfig> {
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

function settingsKey(name: string): string {
  return `projects/${name}/settings.json`;
}

export async function loadSettings(config: LocalConfig, name: string): Promise<Settings> {
  const result = await run(["aws", "s3", "cp", `s3://${config.bucket}/${settingsKey(name)}`, "-", "--region", config.region], {
    env: awsEnv(config),
    allowFailure: true,
  });
  if (result.code !== 0) {
    if (/404|NoSuchKey|does not exist/i.test(result.stderr)) throw new KitError(`No project named ${name}. Run \`kit new ${name}\`.`);
    throw new KitError(`Couldn't read the settings of ${name}: ${result.stderr.trim()}`);
  }
  return parseSettings(JSON.parse(result.stdout));
}

export async function saveSettings(config: LocalConfig, settings: Settings): Promise<void> {
  const body = `${JSON.stringify(parseSettings(settings), null, 2)}\n`;
  await aws(config, ["s3", "cp", "-", `s3://${config.bucket}/${settingsKey(settings.name)}`, "--content-type", "application/json"], body);
}

export async function listProjects(config: LocalConfig): Promise<string[]> {
  const result = await json<{ CommonPrefixes?: { Prefix: string }[] }>(
    ["aws", "s3api", "list-objects-v2", "--bucket", config.bucket, "--prefix", "projects/", "--delimiter", "/", "--region", config.region],
    { env: awsEnv(config) },
  );
  return (result.CommonPrefixes ?? []).map((p) => p.Prefix.slice("projects/".length, -1)).sort();
}

export async function settingsVersions(config: LocalConfig, name: string): Promise<{ id: string; modified: string }[]> {
  const result = await json<{ Versions?: { VersionId: string; LastModified: string; Key: string }[] }>(
    ["aws", "s3api", "list-object-versions", "--bucket", config.bucket, "--prefix", settingsKey(name), "--region", config.region],
    { env: awsEnv(config) },
  );
  return (result.Versions ?? [])
    .filter((v) => v.Key === settingsKey(name))
    .map((v) => ({ id: v.VersionId, modified: v.LastModified }));
}

export async function loadSettingsVersion(config: LocalConfig, name: string, versionId: string): Promise<string> {
  const dir = await tempDir();
  const out = join(dir, "settings.json");
  await aws(config, ["s3api", "get-object", "--bucket", config.bucket, "--key", settingsKey(name), "--version-id", versionId, out]);
  return Bun.file(out).text();
}

export async function tempDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  return mkdtemp(join(tmpdir(), "project-kit-"));
}

export async function deleteSettings(config: LocalConfig, name: string): Promise<void> {
  await aws(config, ["s3", "rm", `s3://${config.bucket}/${settingsKey(name)}`]);
}
