import { branchExists, environments, repositoryFile } from "./github";
import { RepoEnvError, readDeclaration, type RepoVariable } from "./repo-env";
import type { Imports } from "./root";
import { CONTRACT_NAMES, KitError, type Settings } from "./settings";
import { integrationVariables, type Vercel, type VercelEnv } from "./vercel";

export interface Adoption {
  imports: Imports;
  /** Variables already in the Vercel project under names the kit will set. */
  conflicts: VercelEnv[];
  /** Variables a Marketplace integration manages; the integration has to be removed. */
  integrations: string[];
}

/** What already exists for a project, so the first apply adopts it instead of failing. */
export async function survey(settings: Settings, vercel: Vercel, repoOwned: ReadonlySet<string> = new Set()): Promise<Adoption> {
  const imports: Imports = {};
  const repo = settings.repository.split("/")[1] as string;
  const team = settings.vercel.teamId;
  let conflicts: VercelEnv[] = [];
  let integrations: string[] = [];

  const project = await vercel.project(settings.name);
  if (project) {
    imports["module.platform.vercel_project.this"] = `${team}/${project.id}`;
    const domains = new Set((await vercel.domains(project.id)).map((d) => d.name));
    if (domains.has(settings.domains.production)) {
      imports["module.platform.vercel_project_domain.production"] = `${team}/${project.id}/${settings.domains.production}`;
    }
    if (domains.has(settings.domains.dev)) {
      imports["module.platform.vercel_project_domain.dev"] = `${team}/${project.id}/${settings.domains.dev}`;
    }
    const envs = await vercel.envKeys(project.id);
    const managed = managedNames(settings, repoOwned);
    integrations = [...new Set(integrationVariables(envs))];
    conflicts = envs.filter((env) => managed.has(env.key) && !integrations.includes(env.key));
  }

  const existing = await environments(settings.repository);
  for (const name of ["preview", "dev", "production"]) {
    const match = existing.find((e) => e.toLowerCase() === name);
    if (match) imports[`module.platform.github_repository_environment.this["${name}"]`] = `${repo}:${match}`;
  }
  if (await branchExists(settings.repository, "dev")) {
    imports["module.platform.github_branch.dev"] = `${repo}:dev`;
  }

  if (settings.storage.kind === "s3" && settings.storage.existingBuckets) {
    imports['module.storage.aws_s3_bucket.this["production"]'] = settings.storage.existingBuckets.production;
    imports['module.storage.aws_s3_bucket.this["dev"]'] = settings.storage.existingBuckets.dev;
  }

  return { imports, conflicts, integrations };
}

/** Names the kit's apply sets; the ones the repository declares are its own and never in it. */
export function managedNames(settings: Settings, repoOwned: ReadonlySet<string> = new Set()): Set<string> {
  const names = [
    ...[...CONTRACT_NAMES].filter((name) => name !== "AUTH_GOOGLE_SECRET"),
    ...settings.generated,
    ...Object.keys(settings.env.production),
    ...Object.keys(settings.env.preview),
    ...Object.keys(settings.env.dev),
  ];
  return new Set(names.filter((name) => !repoOwned.has(name)));
}

/**
 * The variables the app repository declares (docs/contract.md), on the production branch and
 * on dev: its Deploy and Preview workflows set them, so the kit leaves them alone.
 */
export async function repoDeclared(settings: Settings): Promise<RepoVariable[]> {
  const found = new Map<string, RepoVariable>();
  for (const branch of [settings.productionBranch, "dev"]) {
    const [pyproject, packageJson] = await Promise.all([
      repositoryFile(settings.repository, "pyproject.toml", branch),
      repositoryFile(settings.repository, "package.json", branch),
    ]);
    try {
      for (const variable of readDeclaration({ pyproject, packageJson })?.variables ?? []) found.set(variable.name, variable);
    } catch (error) {
      if (!(error instanceof RepoEnvError)) throw error;
      throw new KitError(`${settings.repository} (${branch}) declares invalid variables:\n${error.message}\nFix them in the repository, then run this again.`);
    }
  }
  return [...found.values()];
}

/** Names both the settings and the repository declare: one of them has to let go. */
export function ownershipConflicts(settings: Settings, repoOwned: ReadonlySet<string>): string[] {
  const own = [
    ...settings.generated,
    ...settings.supplied.map((s) => s.name),
    ...Object.keys(settings.env.production),
    ...Object.keys(settings.env.preview),
    ...Object.keys(settings.env.dev),
  ];
  return [...new Set(own.filter((name) => repoOwned.has(name)))];
}
