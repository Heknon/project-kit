import { run } from "./exec";
import { remote } from "./mode";
import { KitError } from "./settings";

const SERVICE = "project-kit";

export const TOKENS = {
  vercel: { name: "vercel-token", env: "VERCEL_API_TOKEN", label: "Vercel token (Account Settings → Tokens, scoped to the team)" },
  neon: { name: "neon-api-key", env: "NEON_API_KEY", label: "Neon personal API key (Account settings → API keys; an organization key can't create the preview keys)" },
  cloudflare: { name: "cloudflare-api-token", env: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API token (Zone → DNS → Edit)" },
} as const;

export type TokenKind = keyof typeof TOKENS;

/** A keychain entry. Remote mode has no keychain: there, credentials come from the environment only. */
async function stored(name: string): Promise<string | null> {
  if (remote()) return null;
  return Bun.secrets.get({ service: SERVICE, name });
}

/** Tokens live in the OS keychain (Windows Credential Manager, macOS Keychain, libsecret). */
export async function getToken(kind: TokenKind): Promise<string> {
  const token = TOKENS[kind];
  const fromEnv = process.env[token.env];
  if (fromEnv) return fromEnv;
  const value = await stored(token.name);
  if (!value) throw new KitError(`No ${token.label} saved. Run \`kit login ${kind}\`.`);
  return value;
}

export async function hasToken(kind: TokenKind): Promise<boolean> {
  return Boolean(process.env[TOKENS[kind].env] || (await stored(TOKENS[kind].name)));
}

export async function saveToken(kind: TokenKind, value: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: TOKENS[kind].name, value });
}

/**
 * A deploy token for one app (GitHub secret VERCEL_TOKEN). Isolated apps need their own, so a
 * leaked token from another app's repository can be revoked without touching them, and theirs
 * without touching the others.
 */
export async function getAppVercelToken(app: string): Promise<string | null> {
  return stored(`vercel-token/${app}`);
}

export async function saveAppVercelToken(app: string, value: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: `vercel-token/${app}`, value });
}

/** The Google OAuth client every standard app signs in with. */
export interface SharedGoogleClient {
  clientId: string;
  clientSecret: string;
  gcpProject: string;
}

export async function getSharedGoogleClient(): Promise<SharedGoogleClient | null> {
  const { KIT_GOOGLE_CLIENT_ID: clientId, KIT_GOOGLE_CLIENT_SECRET: clientSecret, KIT_GOOGLE_PROJECT: gcpProject } = process.env;
  if (clientId && clientSecret && gcpProject) return { clientId, clientSecret, gcpProject };
  const value = await stored("google-shared-client");
  return value ? (JSON.parse(value) as SharedGoogleClient) : null;
}

export async function saveSharedGoogleClient(client: SharedGoogleClient): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: "google-shared-client", value: JSON.stringify(client) });
}

/** Secrets standard apps reuse (an SMTP URL, an API key), by environment variable name. */
export async function getSharedSecret(name: string): Promise<string | null> {
  const fromEnv = process.env[`KIT_SHARED_${name}`];
  if (fromEnv) return fromEnv;
  return stored(`shared/${name}`);
}

export async function saveSharedSecret(name: string, value: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: `shared/${name}`, value });
}

export async function githubToken(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const { stdout, code } = await run(["gh", "auth", "token"], { allowFailure: true });
  if (code !== 0 || !stdout.trim()) throw new KitError("GitHub CLI isn't signed in. Run `gh auth login`.");
  return stdout.trim();
}
