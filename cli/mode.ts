import { KitError, type Settings } from "./settings";

/**
 * Remote mode: the kit runs in the control repository's GitHub Actions, for standard
 * projects only. Credentials come from environment variables, nothing prompts, and isolated
 * projects are refused (their credentials stay on your machine).
 */
export function remote(): boolean {
  return process.env.KIT_REMOTE === "1";
}

/** --yes, or remote mode: answer every confirmation with yes and approve plans. */
export function assumeYes(): boolean {
  return remote() || process.env.KIT_YES === "1";
}

export function refuseIsolatedRemotely(settings: Pick<Settings, "security" | "name">): void {
  if (remote() && settings.security === "isolated") {
    throw new KitError(`${settings.name} is isolated: manage it from your machine, not from the control repository.`);
  }
}

/** Notes for the person who started a workflow: the job summary in Actions, the terminal otherwise. */
export async function notice(markdown: string): Promise<void> {
  console.log(markdown);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(summary, `${markdown}\n\n`);
  }
}
