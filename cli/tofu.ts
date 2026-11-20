import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAppVercelToken, getToken, githubToken } from "./credentials";
import { run } from "./exec";
import { type Imports, providersFor, rootModule } from "./root";
import { assumeYes } from "./mode";
import { KitError, type Settings } from "./settings";
import { awsEnv, type LocalConfig } from "./store";

export const KIT_DIR = dirname(import.meta.dir);

function tofuBinary(): string {
  const binary = Bun.which("tofu");
  if (!binary) throw new KitError("OpenTofu isn't installed: https://opentofu.org/docs/intro/install/ (winget install OpenTofu.Tofu).");
  return binary;
}

/** Provider credentials as environment variables; nothing is written to disk. */
export async function providerEnv(settings: Settings, config: LocalConfig): Promise<Record<string, string | undefined>> {
  const providers = providersFor(settings);
  const vercel = await getToken("vercel");
  const own = await getAppVercelToken(settings.name);
  if (settings.security === "isolated" && !own) {
    throw new KitError(`${settings.name} is isolated and deploys with its own Vercel token: run \`kit login vercel --app ${settings.name}\`.`);
  }
  return {
    ...awsEnv(config),
    VERCEL_API_TOKEN: vercel,
    TF_VAR_vercel_deploy_token: own ?? vercel,
    GITHUB_TOKEN: await githubToken(),
    NEON_API_KEY: providers.includes("neon") ? await getToken("neon") : undefined,
    CLOUDFLARE_API_TOKEN: providers.includes("cloudflare") ? await getToken("cloudflare") : undefined,
    TF_IN_AUTOMATION: "1",
  };
}

export class Workspace {
  private constructor(
    readonly dir: string,
    private readonly env: Record<string, string | undefined>,
  ) {}

  static async open(settings: Settings, config: LocalConfig, imports: Imports = {}): Promise<Workspace> {
    const dir = join(KIT_DIR, ".work", settings.name);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "main.tf"), rootModule(settings, { bucket: config.bucket, region: config.region }, imports));
    const workspace = new Workspace(dir, await providerEnv(settings, config));
    await workspace.tofu(["init", "-input=false", "-reconfigure", "-upgrade=false"]);
    return workspace;
  }

  tofu(args: string[], interactive = false) {
    return run([tofuBinary(), `-chdir=${this.dir}`, ...args], { env: this.env, inherit: interactive });
  }

  async plan(detailedExitCode = false): Promise<number> {
    const args = ["plan", "-input=false"];
    if (detailedExitCode) args.push("-detailed-exitcode");
    const result = await run([tofuBinary(), `-chdir=${this.dir}`, ...args], { env: this.env, inherit: true, allowFailure: true });
    if (result.code === 1) throw new KitError("tofu plan failed.");
    return result.code;
  }

  async apply(): Promise<void> {
    await this.tofu(["apply", assumeYes() ? "-auto-approve" : "-input=true"], true);
  }

  async destroy(): Promise<void> {
    await this.tofu(["destroy", assumeYes() ? "-auto-approve" : "-input=true"], true);
  }

  async output<T>(name: string): Promise<T> {
    const { stdout } = await this.tofu(["output", "-json", name]);
    return JSON.parse(stdout) as T;
  }

  /** The generated root module holds settings, not secrets, but it leaves the disk anyway. */
  async close(): Promise<void> {
    await rm(join(this.dir, "main.tf"), { force: true });
  }
}
