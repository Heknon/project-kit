import { bootstrap, isBlank, starterExists } from "../bootstrap";
import { getAppVercelToken, getToken, saveAppVercelToken } from "../credentials";
import { run } from "../exec";
import { repositoryInfo } from "../github";
import { ask, askHidden, confirm } from "../prompt";
import { refuseIsolatedRemotely } from "../mode";
import { KitError, parseSettings, type Scope, SCOPES, type Settings } from "../settings";
import { loadLocalConfig, loadSettings, saveSettings } from "../store";
import { Vercel } from "../vercel";
import { KIT_VERSION } from "../version";
import { apply } from "./apply";
import { sync } from "./sync";

export interface NewOptions {
  repo?: string;
  with?: string;
  security?: string;
  domain?: string;
  devDomain?: string;
  productionBranch?: string;
  deploy?: string;
  generate?: string;
  supply?: string;
  shared?: string;
  env?: string[];
  public?: boolean;
  yes?: boolean;
  /** next (default for a blank repository), python or none: a directory under starters/ */
  starter?: string;
}

const FEATURES = ["neon", "postgres", "s3", "google", "cron", "aws-deploy"] as const;

/**
 * One command from nothing to a deployed app: settings (from your defaults), the repository
 * if it doesn't exist, `kit apply`, then `kit sync`. An existing repository is adopted.
 */
export async function newProject(name: string | undefined, options: NewOptions): Promise<void> {
  if (!name) throw new KitError("Usage: kit new <name> [--repo owner/name] [--with neon,s3,google] [--security isolated]");
  const config = await loadLocalConfig();
  const exists = await loadSettings(config, name).then(
    () => true,
    () => false,
  );
  if (exists) throw new KitError(`${name} already exists. Change it with \`kit settings ${name} --edit\`.`);

  const security = (options.security ?? "standard") as Settings["security"];
  if (security !== "standard" && security !== "isolated") throw new KitError("--security is standard or isolated.");
  refuseIsolatedRemotely({ security, name });

  const features = new Set(
    (options.with ?? config.defaults?.features?.join(",") ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean),
  );
  for (const feature of features) {
    if (!FEATURES.includes(feature as (typeof FEATURES)[number])) throw new KitError(`Unknown feature ${feature}. Known: ${FEATURES.join(", ")}.`);
  }
  if (features.has("neon") && features.has("postgres")) throw new KitError("Pick one database: neon or postgres.");

  const repository = options.repo ?? `${await githubLogin()}/${name}`;
  let repo = await repositoryInfo(repository);
  if (!repo) {
    if (!options.yes && !confirm(`Create the ${options.public ? "public" : "private"} repository ${repository}?`, true)) {
      throw new KitError("Create the repository first, or pass --repo.");
    }
    await run(["gh", "repo", "create", repository, options.public ? "--public" : "--private", "--add-readme"], { inherit: true });
    repo = await repositoryInfo(repository);
    if (!repo) throw new KitError(`Couldn't read ${repository} after creating it.`);
  }

  const team = await vercelTeam(config.defaults?.vercelTeamSlug);
  const settings: Record<string, unknown> = {
    kitVersion: KIT_VERSION,
    name,
    repository,
    security,
    productionBranch: options.productionBranch ?? repo.defaultBranch,
    productionDeploy: options.deploy ?? "push",
    // Rulesets on private repositories need a paid GitHub plan; turn it on with --set if yours has one.
    protectBranches: !repo.isPrivate,
    region: config.region,
    vercel: { teamId: team.id, teamSlug: team.slug },
    domains: {
      production: options.domain ?? `${name}.vercel.app`,
      dev: options.devDomain ?? `${name}-dev.vercel.app`,
    },
    cron: features.has("cron"),
    generated: list(options.generate),
    supplied: [...list(options.supply).map((s) => parseSupplied(s)), ...list(options.shared).map((s) => parseSupplied(s, true))],
    env: parseEnv(options.env ?? []),
  };
  if (features.has("neon")) settings.database = { kind: "neon", orgId: config.defaults?.neonOrgId ?? (await neonOrg()) };
  if (features.has("postgres")) settings.database = { kind: "postgres" };
  if (features.has("s3")) settings.storage = { kind: "s3" };
  if (features.has("google")) settings.google = {};
  if (features.has("aws-deploy")) settings.awsDeploy = { policyArns: [] };

  const parsed = parseSettings(settings);
  const blank = await isBlank(repository);
  const starter = options.starter ?? (blank && (await starterExists("next")) ? "next" : "none");
  if (starter !== "none" && !blank) throw new KitError(`${repository} already has code; a starter only goes into a blank repository.`);
  if (starter !== "none" && !(await starterExists(starter))) throw new KitError(`There's no ${starter} starter in this kit.`);

  if (parsed.security === "isolated" && !(await getAppVercelToken(name))) {
    console.log(`${name} is isolated, so it deploys with its own Vercel token.`);
    await saveAppVercelToken(name, await askHidden(`Vercel token for ${name} (Account Settings → Tokens; name it after the app)`));
  }

  await saveSettings(config, parsed);
  console.log(`Saved the settings of ${name} (${security}).`);

  await apply(name);
  if (parsed.security === "isolated" && parsed.google) {
    console.log(`\nIsolated apps have their own Google clients: run \`kit google ${name}\`.`);
  }

  const failed = (error: unknown) => {
    console.log(`\nWorkflows not set up: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`Run \`kit sync ${name}\` when that's fixed.`);
  };
  if (starter !== "none") await bootstrap(parsed, starter).catch(failed);
  else await sync(name, {}).catch(failed);
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** NAME or NAME:production+nonproduction */
export function parseSupplied(entry: string, shared = false): { name: string; scopes: Scope[]; shared: boolean } {
  const [name, scopes] = entry.split(":");
  const parsed = (scopes ?? "production+nonproduction").split("+") as Scope[];
  for (const scope of parsed) {
    if (!SCOPES.includes(scope)) throw new KitError(`Unknown scope ${scope} in ${entry}. Scopes: ${SCOPES.join(", ")}.`);
  }
  return { name: name ?? entry, scopes: parsed, shared };
}

/** scope:KEY=value, scope one of production, preview, dev, all */
export function parseEnv(entries: string[]): Settings["env"] {
  const env: Settings["env"] = { production: {}, preview: {}, dev: {} };
  for (const entry of entries) {
    const match = /^(production|preview|dev|all):([A-Z][A-Z0-9_]*)=(.+)$/.exec(entry);
    if (!match) throw new KitError(`--env ${entry}: expected scope:NAME=value (scope production, preview, dev or all).`);
    const [, scope, key, value] = match as unknown as [string, string, string, string];
    for (const target of scope === "all" ? (["production", "preview"] as const) : [scope as keyof Settings["env"]]) {
      env[target][key] = value;
    }
  }
  return env;
}

async function githubLogin(): Promise<string> {
  return (await run(["gh", "api", "user", "--jq", ".login"])).stdout.trim();
}

async function vercelTeam(preferred: string | undefined): Promise<{ id: string; slug: string }> {
  const teams = await new Vercel(await getToken("vercel")).teams();
  const team =
    teams.find((t) => t.slug === preferred) ??
    (teams.length === 1 ? teams[0] : teams.find((t) => t.slug === ask(`Vercel team (${teams.map((t) => t.slug).join(", ")})`)));
  if (!team) throw new KitError("No such Vercel team.");
  return team;
}

export async function neonOrg(): Promise<string> {
  const response = await fetch("https://console.neon.tech/api/v2/users/me/organizations", {
    headers: { Authorization: `Bearer ${await getToken("neon")}` },
  });
  if (!response.ok) throw new KitError(`Neon refused the API key (${response.status}).`);
  const { organizations } = (await response.json()) as { organizations: { id: string; name: string }[] };
  if (organizations.length === 1 && organizations[0]) return organizations[0].id;
  const name = ask(`Neon organization (${organizations.map((o) => o.name).join(", ")})`);
  const org = organizations.find((o) => o.name === name);
  if (!org) throw new KitError(`No Neon organization named ${name}.`);
  return org.id;
}
