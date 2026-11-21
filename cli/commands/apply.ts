import { type Adoption, survey } from "../adopt";
import { getSharedGoogleClient, getSharedSecret, getToken, type SharedGoogleClient } from "../credentials";
import { run } from "../exec";
import { clientSpecs, copyToClipboard, openUrl, verifyRedirect } from "../google";
import { findLeaks } from "../leaks";
import { confirm } from "../prompt";
import { notice, refuseIsolatedRemotely, remote } from "../mode";
import { googleClient, KitError, pending, type Settings } from "../settings";
import { deleteSettings, type LocalConfig, loadLocalConfig, loadSettings, tempDir } from "../store";
import { Workspace } from "../tofu";
import { scopeTargets, Vercel } from "../vercel";

export async function load(name: string | undefined): Promise<{ config: LocalConfig; settings: Settings; vercel: Vercel }> {
  if (!name) throw new KitError("Name the project: kit <command> <name>.");
  const config = await loadLocalConfig();
  const settings = await withSharedClient(await loadSettings(config, name));
  refuseIsolatedRemotely(settings);
  return { config, settings, vercel: new Vercel(await getToken("vercel"), settings.vercel.teamId) };
}

/** A standard app signs in with the shared client: its id fills both scopes. */
async function withSharedClient(settings: Settings): Promise<Settings> {
  if (!settings.google || googleClient(settings) !== "shared") return settings;
  const shared = await getSharedGoogleClient();
  if (!shared) return settings;
  return {
    ...settings,
    google: { ...settings.google, gcpProject: shared.gcpProject, productionClientId: shared.clientId, nonproductionClientId: shared.clientId },
  };
}

/**
 * What the kit writes outside the state on every apply: the shared Google client's secret and
 * shared supplied secrets (so rotating one reaches every app), and a check that Google accepts
 * the app's redirect URIs, opening the client's page with the missing ones on the clipboard.
 */
async function writeSharedCredentials(settings: Settings, vercel: Vercel, projectId: string): Promise<void> {
  if (settings.google && googleClient(settings) === "shared") {
    const shared = await getSharedGoogleClient();
    if (shared) {
      for (const scope of ["production", "nonproduction"] as const) {
        await vercel.setSecret(projectId, "AUTH_GOOGLE_SECRET", shared.clientSecret, scope);
      }
      await registerRedirects(settings, shared);
    }
  }
  for (const secret of settings.supplied.filter((s) => s.shared)) {
    const value = await getSharedSecret(secret.name);
    if (!value) {
      console.log(`No shared ${secret.name} saved yet: run \`kit shared set ${secret.name}\`, then apply again.`);
      continue;
    }
    for (const scope of secret.scopes) await vercel.setSecret(projectId, secret.name, value, scope);
  }
}

async function registerRedirects(settings: Settings, shared: SharedGoogleClient): Promise<void> {
  const wanted = clientSpecs(settings).flatMap((spec) => spec.redirectUris);
  const missing: string[] = [];
  for (const uri of wanted) if (await verifyRedirect(shared.clientId, uri)) missing.push(uri);
  if (missing.length === 0) return;

  const page = `https://console.cloud.google.com/auth/clients/${encodeURIComponent(shared.clientId)}?project=${encodeURIComponent(shared.gcpProject)}`;
  await notice(
    [
      `**Google doesn't accept these redirect URIs of ${settings.name} yet.** Add them to the shared client's Authorized redirect URIs and save (${page}):`,
      "",
      "```",
      ...missing,
      "```",
    ].join("\n"),
  );
  if (!remote()) {
    await copyToClipboard(missing.join("\n"));
    await openUrl(page);
  }
}

export const PROJECT_ADDRESS = "module.platform.vercel_project.this";

/**
 * Vercel attaches `<name>.vercel.app` to a project as it creates it, so adding the same domain
 * in the same apply fails. When the project doesn't exist yet, the kit creates it alone first;
 * the next survey then adopts the domains Vercel gave it.
 */
export function createsProjectFirst(adoption: Adoption, inState: Set<string>): boolean {
  return !inState.has(PROJECT_ADDRESS) && !(PROJECT_ADDRESS in adoption.imports);
}

interface Prepared {
  workspace: Workspace;
  /** The Vercel project is neither in the state nor on Vercel. */
  projectMissing: boolean;
}

/**
 * Generates the root module, adopts what already exists (imports for resources that aren't
 * in the state yet), and refuses to start while a Marketplace integration owns names the kit
 * is about to set.
 */
async function prepare(config: LocalConfig, settings: Settings, vercel: Vercel, notes = true): Promise<Prepared> {
  if (notes) for (const note of pending(settings)) console.log(note);

  const adoption = await survey(settings, vercel);
  if (adoption.integrations.length > 0) {
    throw new KitError(
      [
        `The Vercel project ${settings.name} still has Marketplace integration variables: ${adoption.integrations.join(", ")}.`,
        "Remove the integrations from the project (Vercel → Project → Settings → Integrations), then run this again.",
      ].join("\n"),
    );
  }
  if (adoption.conflicts.length > 0) {
    const names = [...new Set(adoption.conflicts.map((c) => c.key))].join(", ");
    if (!confirm(`The Vercel project already has ${names}, which the kit manages. Delete them so the kit can set them?`)) {
      throw new KitError("Stopped; nothing changed.");
    }
    const project = await vercel.project(settings.name);
    for (const env of adoption.conflicts) await vercel.deleteEnv(project?.id as string, env.id);
  }

  let workspace = await Workspace.open(settings, config);
  const { stdout } = await workspace.tofu(["state", "list"]).catch(() => ({ stdout: "" }));
  const inState = new Set(stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  const imports = Object.fromEntries(Object.entries(adoption.imports).filter(([address]) => !inState.has(address)));
  if (Object.keys(imports).length > 0) {
    console.log(`Adopting existing resources:\n${Object.keys(imports).map((a) => `  ${a}`).join("\n")}`);
    workspace = await Workspace.open(settings, config, imports);
  }
  return { workspace, projectMissing: createsProjectFirst(adoption, inState) };
}

export async function plan(name: string | undefined): Promise<void> {
  const { config, settings, vercel } = await load(name);
  const { workspace } = await prepare(config, settings, vercel);
  try {
    await workspace.plan();
  } finally {
    await workspace.close();
  }
}

export async function apply(name: string | undefined): Promise<void> {
  const { config, settings, vercel } = await load(name);
  let { workspace, projectMissing } = await prepare(config, settings, vercel);
  if (projectMissing) {
    console.log("Creating the Vercel project first, so the domain Vercel gives it is adopted, not added twice.");
    try {
      await workspace.apply([`-target=${PROJECT_ADDRESS}`]);
    } finally {
      await workspace.close();
    }
    ({ workspace } = await prepare(config, settings, vercel, false));
  }
  try {
    await workspace.apply();
  } finally {
    await workspace.close();
  }

  const project = await vercel.project(settings.name);
  if (project) {
    await writeSharedCredentials(settings, vercel, project.id);
    await reportMissingSecrets(settings, vercel, project.id);
  }
}

async function reportMissingSecrets(settings: Settings, vercel: Vercel, projectId: string): Promise<void> {
  const envs = await vercel.envKeys(projectId);
  const present = (key: string, scope: Parameters<typeof scopeTargets>[0]) =>
    scopeTargets(scope).every((t) =>
      envs.some((e) => e.key === key && e.target?.includes(t.target) && (t.gitBranch ? e.gitBranch === t.gitBranch : !e.gitBranch)),
    );

  const missing: string[] = [];
  for (const secret of settings.supplied.filter((s) => !s.shared)) {
    for (const scope of secret.scopes) if (!present(secret.name, scope)) missing.push(`kit secret set ${settings.name} ${secret.name} --scope ${scope}`);
  }
  if (settings.google && googleClient(settings) === "own" && !present("AUTH_GOOGLE_SECRET", "production")) {
    missing.push(`kit google ${settings.name}`);
  }
  if (settings.database.kind === "postgres" && !present("DATABASE_URL", "production")) {
    missing.push(`kit secret set ${settings.name} DATABASE_URL`, `kit secret set ${settings.name} DATABASE_URL_UNPOOLED`);
  }
  if (missing.length > 0) console.log(`\nStill to set:\n${[...new Set(missing)].map((m) => `  ${m}`).join("\n")}`);
}

/** Drift (`tofu plan`) and leaks: identifiers of the project's accounts in its repository. */
export async function check(name: string | undefined): Promise<void> {
  const { config, settings, vercel } = await load(name);
  const { workspace } = await prepare(config, settings, vercel);
  let drift: number;
  let identifiers: string[];
  try {
    drift = await workspace.plan(true);
    identifiers = await workspace.output<string[]>("identifiers").catch(() => []);
  } finally {
    await workspace.close();
  }

  const dir = await tempDir();
  await run(["gh", "repo", "clone", settings.repository, dir, "--", "--depth", "1", "--quiet"]);
  const leaks = await findLeaks(dir, identifiers);
  for (const leak of leaks) console.log(`leak: ${leak}`);

  console.log(drift === 2 ? "Drift: the plan above shows changes." : "No drift.");
  console.log(leaks.length > 0 ? `${leaks.length} leak(s) in ${settings.repository}.` : `No leaks in ${settings.repository}.`);
  if (drift === 2 || leaks.length > 0) process.exitCode = 1;
}

/** Resources that hold production data or code. `kit destroy` forgets them instead of deleting them. */
export const KEPT_ON_DESTROY = [
  "module.platform.github_branch.dev",
  "module.neon.neon_project.this",
  "module.storage.aws_s3_bucket.this",
  "module.storage.aws_s3_bucket_public_access_block.this",
  "module.storage.aws_s3_bucket_ownership_controls.this",
  "module.storage.aws_s3_bucket_server_side_encryption_configuration.this",
  "module.storage.aws_s3_bucket_versioning.production",
  "module.storage.aws_s3_bucket_cors_configuration.this",
  "module.storage.aws_s3_bucket_lifecycle_configuration.dev",
];

/**
 * Takes an app off the air: the Vercel project, GitHub environments and secrets, IAM roles, the
 * preview database key, DNS records, and every database branch except production's (they are
 * copies) go. Production data stays: the Neon project with its main branch, the buckets (still
 * private and encrypted) and the repository, and the settings stay in the state bucket's
 * history. Delete those by hand if you really mean to.
 */
export async function destroy(name: string | undefined): Promise<void> {
  const { config, settings } = await load(name);
  if (!confirm(`Take ${settings.name} down (its data stays)?`)) return;
  const workspace = await Workspace.open(settings, config);
  try {
    const { stdout } = await workspace.tofu(["state", "list"]);
    const inState = stdout.split("\n").map((l) => l.trim());
    const kept = inState.filter((address) => KEPT_ON_DESTROY.some((prefix) => address === prefix || address.startsWith(`${prefix}[`)));
    const neonProjectId = settings.database.kind === "neon" ? await workspace.output<string>("neon_project_id").catch(() => null) : null;
    if (kept.length > 0) await workspace.tofu(["state", "rm", ...kept]);
    await workspace.destroy();
    if (neonProjectId) await deletePreviewBranches(neonProjectId);
  } finally {
    await workspace.close();
  }
  await deleteSettings(config, settings);
  console.log(`${settings.name} is down. Kept: ${describeKept(settings)}.`);
}

function describeKept(settings: Settings): string {
  const kept = ["the repository"];
  if (settings.database.kind === "neon") kept.push(`the Neon project ${settings.name} with its main branch`);
  if (settings.storage.kind === "s3") kept.push("both S3 buckets");
  return kept.join(", ");
}

/** Preview branches a failed or cancelled cleanup left behind; dev went with the destroy. */
async function deletePreviewBranches(projectId: string): Promise<void> {
  const headers = { Authorization: `Bearer ${await getToken("neon")}` };
  const base = `https://console.neon.tech/api/v2/projects/${projectId}/branches`;
  const response = await fetch(base, { headers });
  if (!response.ok) return;
  const { branches } = (await response.json()) as { branches: { id: string; name: string }[] };
  for (const branch of branches.filter((b) => b.name.startsWith("preview/"))) {
    await fetch(`${base}/${branch.id}`, { method: "DELETE", headers });
  }
}
