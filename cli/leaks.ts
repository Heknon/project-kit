import { run } from "./exec";

/**
 * Lines in a repository that contain an identifier of the project's accounts, or workflows
 * that read repository variables (printed in logs, unlike secrets). Identifiers are never
 * printed: a finding names the file, the line and which kind of value it is.
 */
export async function findLeaks(repoDir: string, identifiers: string[]): Promise<string[]> {
  const findings: string[] = [];
  const values = identifiers.filter((value) => value.length >= 6);

  for (const [index, value] of values.entries()) {
    const result = await run(["git", "-C", repoDir, "grep", "-n", "-I", "-F", "-e", value], { allowFailure: true });
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const [file, lineNumber] = line.split(":");
      findings.push(`${file}:${lineNumber} contains identifier #${index + 1} (${describe(value)})`);
    }
  }

  const vars = await run(["git", "-C", repoDir, "grep", "-n", "-E", "\\$\\{\\{\\s*vars\\.", "--", ".github/workflows"], { allowFailure: true });
  for (const line of vars.stdout.split("\n").filter(Boolean)) {
    const [file, lineNumber] = line.split(":");
    findings.push(`${file}:${lineNumber} reads a repository variable; use a secret`);
  }
  return findings;
}

export function describe(value: string): string {
  if (value.startsWith("arn:aws:")) return "AWS ARN";
  if (value.startsWith("team_")) return "Vercel team id";
  if (value.startsWith("prj_")) return "Vercel project id";
  if (value.endsWith(".apps.googleusercontent.com")) return "Google client id";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return "domain";
  return "account identifier";
}
