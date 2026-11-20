import { join } from "node:path";
import { getSharedGoogleClient, getToken, hasToken, saveAppVercelToken, saveToken, TOKENS, type TokenKind } from "../credentials";
import { neonOrg } from "./new";
import { setSharedGoogleClient } from "./shared";
import { json, run } from "../exec";
import { oidcSubjectPrefixes } from "../github";
import { ask, askHidden, confirm } from "../prompt";
import { KitError } from "../settings";
import { aws, awsEnv, type LocalConfig, loadLocalConfig, saveLocalConfig } from "../store";
import { KIT_DIR } from "../tofu";
import { Vercel } from "../vercel";

export async function login(kind: string | undefined, app?: string): Promise<void> {
  if (!kind || !(kind in TOKENS)) throw new KitError(`Usage: kit login <${Object.keys(TOKENS).join("|")}> [--app <name>]`);
  if (app) {
    if (kind !== "vercel") throw new KitError("Only Vercel has per-app tokens.");
    await saveAppVercelToken(app, await askHidden(`Vercel token for ${app} (Account Settings → Tokens; name it after the app)`));
    console.log(`Saved ${app}'s deploy token. \`kit apply ${app}\` puts it in its GitHub environments.`);
    return;
  }
  const token = TOKENS[kind as TokenKind];
  await saveToken(kind as TokenKind, await askHidden(token.label));
  console.log(`Saved the ${kind} token in the OS keychain.`);
}

/** Once per machine: the state bucket, the tokens, and the account-wide OIDC providers. */
export async function init(): Promise<void> {
  for (const binary of ["aws", "gh", "tofu"]) {
    if (!Bun.which(binary)) throw new KitError(`${binary} isn't installed or isn't on PATH.`);
  }

  const existing = await loadLocalConfig().catch(() => null);
  const region = ask("AWS region for the kit's state", existing?.region ?? "eu-central-1");
  const profile = ask("AWS profile (empty for the default credentials)", existing?.profile ?? "") || undefined;
  const identity = await json<{ Account: string }>(["aws", "sts", "get-caller-identity", "--output", "json"], {
    env: awsEnv({ profile, region }),
  }).catch(() => {
    throw new KitError("AWS credentials don't work. Sign in first (`aws login` or `aws sso login`).");
  });

  const bucket = existing?.bucket ?? (await findOrCreateBucket({ bucket: "", region, profile }));
  const config: LocalConfig = { bucket, region, profile };
  await saveLocalConfig(config);
  console.log(`State bucket ready in account ${identity.Account}.`);

  for (const kind of Object.keys(TOKENS) as TokenKind[]) {
    if (await hasToken(kind)) continue;
    const required = kind === "vercel";
    if (required || confirm(`Save a ${kind} token now?`, kind === "neon")) {
      await saveToken(kind, await askHidden(TOKENS[kind].label));
    }
  }

  const vercel = new Vercel(await getToken("vercel"));
  const teams = await vercel.teams();
  const slugs = teams.map((t) => t.slug);
  console.log(`Vercel teams: ${slugs.join(", ")}`);
  const chosen = ask("Teams whose functions may use AWS (comma-separated)", slugs.join(",")).split(",").map((s) => s.trim()).filter(Boolean);

  config.accountTeams = chosen;
  await saveLocalConfig(config);
  await applyAccountStack(config);

  const defaultTeam = ask("Vercel team for new apps", existing?.defaults?.vercelTeamSlug ?? chosen[0] ?? slugs[0]);
  const features = ask("Features of a new app", (existing?.defaults?.features ?? ["neon", "s3", "google"]).join(","))
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const neonOrgId = features.includes("neon") && (await hasToken("neon")) ? (existing?.defaults?.neonOrgId ?? (await neonOrg())) : undefined;
  await saveLocalConfig({ ...config, defaults: { vercelTeamSlug: defaultTeam, neonOrgId, features } });

  if (!(await getSharedGoogleClient()) && confirm("Save the shared Google client that standard apps sign in with?", true)) {
    await setSharedGoogleClient();
  }
  console.log("\nReady. Create an app with `kit new <name>`.");
}

async function findOrCreateBucket(config: LocalConfig): Promise<string> {
  const buckets = await json<{ Buckets?: { Name: string }[] }>(["aws", "s3api", "list-buckets", "--output", "json"], {
    env: awsEnv(config),
  });
  const found = (buckets.Buckets ?? []).map((b) => b.Name).find((name) => name.startsWith("project-kit-state-"));
  if (found && confirm(`Use the existing state bucket ${found}?`, true)) return found;

  const name = `project-kit-state-${crypto.randomUUID().slice(0, 8)}`;
  const location = config.region === "us-east-1" ? [] : ["--create-bucket-configuration", `LocationConstraint=${config.region}`];
  const target = { ...config, bucket: name };
  await aws(target, ["s3api", "create-bucket", "--bucket", name, ...location]);
  await aws(target, [
    "s3api",
    "put-public-access-block",
    "--bucket",
    name,
    "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true",
  ]);
  await aws(target, ["s3api", "put-bucket-versioning", "--bucket", name, "--versioning-configuration", "Status=Enabled"]);
  await aws(target, [
    "s3api",
    "put-bucket-lifecycle-configuration",
    "--bucket",
    name,
    "--lifecycle-configuration",
    JSON.stringify({
      Rules: [{ ID: "old-versions", Status: "Enabled", Filter: {}, NoncurrentVersionExpiration: { NoncurrentDays: 90 } }],
    }),
  ]);
  return name;
}

/** The account-wide stack: OIDC providers, the app boundary, and the control role when there is a control repository. */
export async function applyAccountStack(config: LocalConfig): Promise<string | null> {
  const teamSlugs = config.accountTeams ?? [];
  const providers = await json<{ OpenIDConnectProviderList: { Arn: string }[] }>(
    ["aws", "iam", "list-open-id-connect-providers", "--output", "json"],
    { env: awsEnv(config) },
  );
  const arns = providers.OpenIDConnectProviderList.map((p) => p.Arn);
  const github = arns.find((arn) => arn.endsWith("/token.actions.githubusercontent.com")) ?? null;
  const vercel = Object.fromEntries(
    teamSlugs.flatMap((slug) => {
      const arn = arns.find((a) => a.endsWith(`/oidc.vercel.com/${slug}`));
      return arn ? [[slug, arn]] : [];
    }),
  );

  // Whatever an interrupted earlier apply created is adopted instead of failing as a duplicate.
  const account = (await json<{ Account: string }>(["aws", "sts", "get-caller-identity", "--output", "json"], { env: awsEnv(config) })).Account;
  const boundaryArn = `arn:aws:iam::${account}:policy/project-kit/project-kit-app-boundary`;
  const boundaryExists = (await run(["aws", "iam", "get-policy", "--policy-arn", boundaryArn], { env: awsEnv(config), allowFailure: true })).code === 0;
  const controlExists =
    (await run(["aws", "iam", "get-role", "--role-name", "project-kit-control"], { env: awsEnv(config), allowFailure: true })).code === 0;

  const dir = join(KIT_DIR, "stacks", "account");
  const tofu = (args: string[]) => run(["tofu", `-chdir=${dir}`, ...args], { env: awsEnv(config), inherit: true });
  await tofu(["init", "-input=false", "-reconfigure", `-backend-config=bucket=${config.bucket}`, `-backend-config=region=${config.region}`]);
  await tofu([
    "apply",
    `-var=region=${config.region}`,
    `-var=vercel_team_slugs=${JSON.stringify(teamSlugs)}`,
    `-var=existing_vercel_provider_arns=${JSON.stringify(vercel)}`,
    `-var=state_bucket=${config.bucket}`,
    ...(github ? [`-var=existing_github_provider_arn=${github}`] : []),
    ...(boundaryExists ? [`-var=existing_app_boundary_arn=${boundaryArn}`] : []),
    ...(config.controlRepository
      ? [
          `-var=control_repository=${config.controlRepository}`,
          `-var=control_subject_prefixes=${JSON.stringify(await oidcSubjectPrefixes(config.controlRepository))}`,
        ]
      : []),
    ...(controlExists ? ["-var=existing_control_role=true"] : []),
  ]);
  const output = await run(["tofu", `-chdir=${dir}`, "output", "-json", "control_role_arn"], { env: awsEnv(config), allowFailure: true });
  return output.code === 0 ? (JSON.parse(output.stdout) as string | null) : null;
}
