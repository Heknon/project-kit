import { run } from "./exec";

export async function repositoryInfo(repository: string): Promise<{ defaultBranch: string; isPrivate: boolean; isEmpty: boolean } | null> {
  const result = await run(["gh", "repo", "view", repository, "--json", "defaultBranchRef,isPrivate,isEmpty"], { allowFailure: true });
  if (result.code !== 0) return null;
  const parsed = JSON.parse(result.stdout) as { defaultBranchRef: { name: string } | null; isPrivate: boolean; isEmpty: boolean };
  return { defaultBranch: parsed.defaultBranchRef?.name || "main", isPrivate: parsed.isPrivate, isEmpty: parsed.isEmpty };
}

export async function environments(repository: string): Promise<string[]> {
  const result = await run(["gh", "api", `repos/${repository}/environments`, "--jq", ".environments[].name"], { allowFailure: true });
  return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
}

export async function branchExists(repository: string, branch: string): Promise<boolean> {
  const result = await run(["gh", "api", `repos/${repository}/branches/${encodeURIComponent(branch)}`, "--silent"], { allowFailure: true });
  return result.code === 0;
}

export async function setEnvironmentSecret(repository: string, environment: string, name: string, value: string): Promise<void> {
  await run(["gh", "secret", "set", name, "--repo", repository, "--env", environment], { stdin: value });
}
