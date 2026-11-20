import { getToken } from "../credentials";
import { setEnvironmentSecret } from "../github";
import { askHidden, readPiped } from "../prompt";
import { KitError, type Scope, SCOPES } from "../settings";
import { loadLocalConfig, loadSettings } from "../store";
import { Vercel } from "../vercel";

const DATABASE_URLS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"];

/** GitHub environments that run with a scope's values. */
const GITHUB_ENVIRONMENTS: Record<Scope, string[]> = {
  production: ["production"],
  nonproduction: ["dev"],
  dev: ["dev"],
  preview: [],
};

/**
 * Writes a supplied secret straight to Vercel (and, for a `postgres` database's URLs, to the
 * GitHub environments that run migrations). The kit keeps no copy; run it again to rotate.
 */
export async function setSecret(name: string | undefined, key: string | undefined, scopeOption?: string): Promise<void> {
  if (!name || !key) throw new KitError("Usage: kit secret set <project> <NAME> [--scope production|nonproduction|preview|dev]");
  const config = await loadLocalConfig();
  const settings = await loadSettings(config, name);

  const isDatabaseUrl = settings.database.kind === "postgres" && DATABASE_URLS.includes(key);
  const declared = settings.supplied.find((s) => s.name === key);
  if (declared?.shared) {
    throw new KitError(`${key} is shared by your standard apps: set it with \`kit shared set ${key}\`, then \`kit apply ${name}\`.`);
  }
  if (!declared && !isDatabaseUrl) {
    throw new KitError(`${key} isn't a supplied secret of ${name}. Add it to "supplied" with \`kit settings ${name} --edit\`.`);
  }

  let scopes: Scope[] = declared?.scopes ?? ["production", "nonproduction"];
  if (scopeOption) {
    if (!SCOPES.includes(scopeOption as Scope)) throw new KitError(`--scope is one of ${SCOPES.join(", ")}.`);
    scopes = [scopeOption as Scope];
  }

  const vercel = new Vercel(await getToken("vercel"), settings.vercel.teamId);
  const project = await vercel.project(settings.name);
  if (!project) throw new KitError(`The Vercel project doesn't exist yet. Run \`kit apply ${name}\` first.`);

  const piped = await readPiped();
  for (const scope of scopes) {
    const value = piped ?? (await askHidden(`${key} for ${scope}`));
    await vercel.setSecret(project.id, key, value, scope);
    if (isDatabaseUrl) {
      for (const environment of GITHUB_ENVIRONMENTS[scope]) await setEnvironmentSecret(settings.repository, environment, key, value);
    }
    console.log(`Set ${key} for ${scope}.`);
  }
}
