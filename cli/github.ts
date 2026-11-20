import { run } from "./exec";
import { KitError } from "./settings";

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

export interface RepositoryIds {
  owner: string;
  ownerId: number;
  name: string;
  id: number;
}

/**
 * The `repo:` part of the OIDC subject GitHub issues for a repository. Repositories created,
 * renamed or transferred after 15 July 2026 carry the owner and repository ids in it; older
 * ones carry names only. A trust policy lists both: a re-registered name gets new ids and
 * can only issue the form with ids, so the names-only form stays safe.
 */
export function subjectPrefixes(repo: RepositoryIds): string[] {
  return [`repo:${repo.owner}/${repo.name}`, `repo:${repo.owner}@${repo.ownerId}/${repo.name}@${repo.id}`];
}

export async function oidcSubjectPrefixes(repository: string): Promise<string[]> {
  const result = await run(["gh", "api", `repos/${repository}`, "--jq", "{owner: .owner.login, ownerId: .owner.id, name: .name, id: .id}"], { allowFailure: true });
  if (result.code !== 0) throw new KitError(`Can't read ${repository} to build its OIDC subject. Check \`gh auth status\` and the repository name.`);
  return subjectPrefixes(JSON.parse(result.stdout) as RepositoryIds);
}
