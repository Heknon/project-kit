import { getSharedGoogleClient, getSharedSecret, getToken, hasToken } from "../credentials";
import { run } from "../exec";
import { repositoryInfo, setEnvironmentSecret } from "../github";
import { askHidden } from "../prompt";
import { KitError } from "../settings";
import { loadLocalConfig, saveLocalConfig } from "../store";
import { applyAccountStack } from "./init";

const ENVIRONMENT = "apps";

/**
 * Sets up the private control repository, whose workflows run the kit for standard projects
 * (from Claude on your phone, or any session that can start a GitHub workflow): an AWS role
 * that can only reach standard projects and kit resources, and an `apps` environment, limited
 * to the default branch, holding what your keychain holds. Isolated projects never go there.
 */
export async function control(repository: string | undefined, options: { shared?: string }): Promise<void> {
  if (!repository) throw new KitError("Usage: kit control <owner/repo> [--shared NAME,...]");
  const repo = await repositoryInfo(repository);
  if (!repo) throw new KitError(`Can't read ${repository}.`);
  if (!repo.isPrivate) throw new KitError(`${repository} is public. The control repository must be private: its logs show plans and project names.`);

  const config = await loadLocalConfig();
  config.controlRepository = repository;
  await saveLocalConfig(config);
  const roleArn = await applyAccountStack(config);
  if (!roleArn) throw new KitError("The account stack didn't create the control role.");

  await run([
    "gh",
    "api",
    "--method",
    "PUT",
    `repos/${repository}/environments/${ENVIRONMENT}`,
    "-F",
    "deployment_branch_policy[protected_branches]=false",
    "-F",
    "deployment_branch_policy[custom_branch_policies]=true",
  ]);
  await run(
    ["gh", "api", "--method", "POST", `repos/${repository}/environments/${ENVIRONMENT}/deployment-branch-policies`, "-f", `name=${repo.defaultBranch}`],
    { allowFailure: true },
  );

  const google = await getSharedGoogleClient();
  if (!google) throw new KitError("Save the shared Google client first: `kit shared google`.");

  console.log(
    [
      "",
      "The workflows need a GitHub token that can create repositories and set their secrets.",
      "Create a fine-grained token (https://github.com/settings/personal-access-tokens/new):",
      "  Resource owner: you. Repository access: All repositories.",
      "  Repository permissions: Administration, Contents, Environments, Secrets, Workflows, Pull requests: Read and write;",
      "  Actions: Read (private repositories' environments can't be read without it).",
      "  Expiration: a year; `kit control` again replaces it.",
      "",
    ].join("\n"),
  );
  const githubToken = await askHidden("Fine-grained GitHub token");

  const secrets: Record<string, string | undefined> = {
    AWS_ROLE_ARN: roleArn,
    KIT_STATE_BUCKET: config.bucket,
    KIT_STATE_REGION: config.region,
    KIT_VERCEL_TEAM: config.defaults?.vercelTeamSlug,
    KIT_NEON_ORG: config.defaults?.neonOrgId,
    KIT_FEATURES: config.defaults?.features?.join(","),
    KIT_GITHUB_TOKEN: githubToken,
    VERCEL_API_TOKEN: await getToken("vercel"),
    NEON_API_KEY: (await hasToken("neon")) ? await getToken("neon") : undefined,
    CLOUDFLARE_API_TOKEN: (await hasToken("cloudflare")) ? await getToken("cloudflare") : undefined,
    KIT_GOOGLE_CLIENT_ID: google.clientId,
    KIT_GOOGLE_CLIENT_SECRET: google.clientSecret,
    KIT_GOOGLE_PROJECT: google.gcpProject,
  };
  for (const name of (options.shared ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const value = await getSharedSecret(name);
    if (!value) throw new KitError(`No shared ${name} saved: \`kit shared set ${name}\` first.`);
    secrets[`KIT_SHARED_${name}`] = value;
  }

  for (const [name, value] of Object.entries(secrets)) {
    if (value) await setEnvironmentSecret(repository, ENVIRONMENT, name, value);
  }
  console.log(`\n${repository} is ready: its workflows manage standard projects. Isolated projects stay on this machine.`);
}
