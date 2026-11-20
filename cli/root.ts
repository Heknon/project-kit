import { googleReady, type Settings } from "./settings";

export const PROVIDER_VERSIONS = {
  aws: { source: "hashicorp/aws", version: "~> 6.73" },
  vercel: { source: "vercel/vercel", version: "~> 5.27" },
  github: { source: "integrations/github", version: "~> 6.13" },
  neon: { source: "kislerdm/neon", version: "~> 0.18" },
  cloudflare: { source: "cloudflare/cloudflare", version: "~> 5.29" },
  random: { source: "hashicorp/random", version: "~> 3.9" },
} as const;

type Provider = keyof typeof PROVIDER_VERSIONS;

export interface Backend {
  bucket: string;
  region: string;
}

/** Existing resources to adopt on the first apply, by resource address. */
export type Imports = Record<string, string>;

/** An HCL expression for a JSON value; strings never interpolate. */
export function hcl(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return JSON.stringify(value)
      .replaceAll("${", () => "$${")
      .replaceAll("%{", () => "%%{");
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(hcl).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, v]) => `  ${JSON.stringify(k)} = ${indent(hcl(v))}`).join("\n")}\n}`;
}

function indent(text: string): string {
  return text.replaceAll("\n", "\n  ");
}

export function providersFor(settings: Settings): Provider[] {
  const used: Provider[] = ["vercel", "github", "random"];
  if (settings.database.kind === "neon") used.push("neon");
  if (settings.storage.kind === "s3" || settings.awsDeploy) used.push("aws");
  if (settings.dns.provider === "cloudflare") used.push("cloudflare");
  return used;
}

/**
 * The root module for one project. It lives in `.work/<name>/` inside the kit, so module
 * sources are relative, and it only declares the providers the project uses: a project
 * without Neon never needs a Neon token.
 */
export function rootModule(settings: Settings, backend: Backend, imports: Imports = {}): string {
  const providers = providersFor(settings);
  const owner = settings.repository.split("/")[0];
  const modules = "../../modules";
  const blocks: string[] = [];

  blocks.push(`terraform {
  required_version = ">= 1.10"

  backend "s3" {
    bucket       = ${hcl(backend.bucket)}
    key          = ${hcl(`projects/${settings.name}/tofu.tfstate`)}
    region       = ${hcl(backend.region)}
    use_lockfile = true
    encrypt      = true
  }

  required_providers {
${providers.map((p) => `    ${p} = { source = ${hcl(PROVIDER_VERSIONS[p].source)}, version = ${hcl(PROVIDER_VERSIONS[p].version)} }`).join("\n")}
  }
}

variable "vercel_deploy_token" {
  type      = string
  sensitive = true
}

provider "vercel" {
  team = ${hcl(settings.vercel.teamId)}
}

provider "github" {
  owner = ${hcl(owner)}
}`);

  if (providers.includes("aws")) {
    blocks.push(`provider "aws" {
  region = ${hcl(settings.region)}
  default_tags {
    tags = { managed-by = "project-kit", project = ${hcl(settings.name)} }
  }
}`);
  }
  if (providers.includes("neon")) blocks.push(`provider "neon" {}`);
  if (providers.includes("cloudflare")) blocks.push(`provider "cloudflare" {}`);

  if (settings.database.kind === "neon") {
    blocks.push(`module "neon" {
  source = "${modules}/neon"
  name   = ${hcl(settings.name)}
  org_id = ${hcl(settings.database.orgId)}
  region = ${hcl(settings.database.region)}
}`);
  }

  if (settings.storage.kind === "s3") {
    blocks.push(`module "storage" {
  source              = "${modules}/s3"
  name                = ${hcl(settings.name)}
  vercel_team_slug    = ${hcl(settings.vercel.teamSlug)}
  vercel_project_name = ${hcl(settings.name)}
  app_origins         = ${hcl([`https://${settings.domains.production}`, `https://${settings.domains.dev}`])}
  existing_buckets    = ${hcl(settings.storage.existingBuckets ?? null)}
  versioning          = ${hcl(settings.storage.versioning)}
}`);
  }

  if (settings.awsDeploy) {
    blocks.push(`module "aws_deploy" {
  source      = "${modules}/aws-deploy"
  name        = ${hcl(settings.name)}
  repository  = ${hcl(settings.repository)}
  policy_arns = ${hcl(settings.awsDeploy.policyArns)}
}`);
  }

  const database =
    settings.database.kind === "neon"
      ? `{
    production = module.neon.production
    dev        = module.neon.dev
    neon = {
      project_id      = module.neon.project_id
      database        = module.neon.database
      role            = module.neon.role
      parent_branch   = module.neon.preview_parent_branch
      preview_api_key = module.neon.preview_api_key
    }
  }`
      : "null";

  const google = googleReady(settings)
    ? hcl({
        production_client_id: settings.google?.productionClientId,
        nonproduction_client_id: settings.google?.nonproductionClientId,
      })
    : "null";

  blocks.push(`module "platform" {
  source                    = "${modules}/platform"
  name                      = ${hcl(settings.name)}
  repository                = ${hcl(settings.repository)}
  production_branch         = ${hcl(settings.productionBranch)}
  protect_production_branch = ${hcl(settings.protectBranches)}
  vercel_team_id            = ${hcl(settings.vercel.teamId)}
  vercel_team_slug          = ${hcl(settings.vercel.teamSlug)}
  vercel_deploy_token       = var.vercel_deploy_token
  function_region           = ${hcl(settings.vercel.functionRegion)}
  domains                   = ${indent(hcl(settings.domains))}
  database                  = ${database}
  storage                   = ${settings.storage.kind === "s3" ? "module.storage" : "null"}
  google                    = ${indent(google)}
  cron                      = ${hcl(settings.cron)}
  generated                 = ${hcl(settings.generated)}
  env                       = ${indent(hcl(settings.env))}
  aws_deploy                = ${settings.awsDeploy ? `{ role_arn = module.aws_deploy.role_arn, region = ${hcl(settings.region)} }` : "null"}
}`);

  if (settings.dns.provider === "cloudflare") {
    blocks.push(`module "dns" {
  source  = "${modules}/dns-cloudflare"
  zone_id = ${hcl(settings.dns.zoneId)}
  domains = ${hcl([settings.domains.production, settings.domains.dev])}
}`);
  }

  for (const [address, id] of Object.entries(imports)) {
    blocks.push(`import {
  to = ${address}
  id = ${hcl(id)}
}`);
  }

  const identifiers = [
    "module.platform.identifiers",
    settings.database.kind === "neon" ? "[module.neon.project_id]" : null,
  ].filter(Boolean);
  blocks.push(`output "identifiers" {
  value = concat(${identifiers.join(", ")})
}

output "vercel_project_id" {
  value = module.platform.vercel_project_id
}`);

  if (settings.database.kind === "neon") {
    blocks.push(`output "neon_project_id" {
  value = module.neon.project_id
}`);
  }

  return `${blocks.join("\n\n")}\n`;
}
