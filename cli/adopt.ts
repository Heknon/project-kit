import { branchExists, environments } from "./github";
import type { Imports } from "./root";
import { CONTRACT_NAMES, type Settings } from "./settings";
import { integrationVariables, type Vercel, type VercelEnv } from "./vercel";

export interface Adoption {
  imports: Imports;
  /** Variables already in the Vercel project under names the kit will set. */
  conflicts: VercelEnv[];
  /** Variables a Marketplace integration manages; the integration has to be removed. */
  integrations: string[];
  gitConnected: boolean;
}

/** What already exists for a project, so the first apply adopts it instead of failing. */
export async function survey(settings: Settings, vercel: Vercel): Promise<Adoption> {
  const imports: Imports = {};
  const repo = settings.repository.split("/")[1] as string;
  const team = settings.vercel.teamId;
  let conflicts: VercelEnv[] = [];
  let integrations: string[] = [];
  let gitConnected = false;

  const project = await vercel.project(settings.name);
  if (project) {
    imports["module.platform.vercel_project.this"] = `${team}/${project.id}`;
    gitConnected = Boolean(project.link);
    const domains = new Set((await vercel.domains(project.id)).map((d) => d.name));
    if (domains.has(settings.domains.production)) {
      imports["module.platform.vercel_project_domain.production"] = `${team}/${project.id}/${settings.domains.production}`;
    }
    if (domains.has(settings.domains.dev)) {
      imports["module.platform.vercel_project_domain.dev"] = `${team}/${project.id}/${settings.domains.dev}`;
    }
    const envs = await vercel.envKeys(project.id);
    const managed = managedNames(settings);
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

  return { imports, conflicts, integrations, gitConnected };
}

export function managedNames(settings: Settings): Set<string> {
  return new Set([
    ...[...CONTRACT_NAMES].filter((name) => name !== "AUTH_GOOGLE_SECRET"),
    ...settings.generated,
    ...Object.keys(settings.env.production),
    ...Object.keys(settings.env.preview),
    ...Object.keys(settings.env.dev),
  ]);
}
