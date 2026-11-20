import { run } from "./exec";
import { KitError } from "./settings";

const SERVICE = "project-kit";

export const TOKENS = {
  vercel: { name: "vercel-token", env: "VERCEL_API_TOKEN", label: "Vercel token (Account Settings → Tokens, scoped to the team)" },
  neon: { name: "neon-api-key", env: "NEON_API_KEY", label: "Neon API key (Organization settings → API keys)" },
  cloudflare: { name: "cloudflare-api-token", env: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API token (Zone → DNS → Edit)" },
} as const;

export type TokenKind = keyof typeof TOKENS;

/** Tokens live in the OS keychain (Windows Credential Manager, macOS Keychain, libsecret). */
export async function getToken(kind: TokenKind): Promise<string> {
  const token = TOKENS[kind];
  const fromEnv = process.env[token.env];
  if (fromEnv) return fromEnv;
  const stored = await Bun.secrets.get({ service: SERVICE, name: token.name });
  if (!stored) throw new KitError(`No ${token.label} saved. Run \`kit login ${kind}\`.`);
  return stored;
}

export async function hasToken(kind: TokenKind): Promise<boolean> {
  return Boolean(process.env[TOKENS[kind].env] || (await Bun.secrets.get({ service: SERVICE, name: TOKENS[kind].name })));
}

export async function saveToken(kind: TokenKind, value: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: TOKENS[kind].name, value });
}

/** The Google OAuth client every standard app signs in with. */
export interface SharedGoogleClient {
  clientId: string;
  clientSecret: string;
  gcpProject: string;
}

export async function getSharedGoogleClient(): Promise<SharedGoogleClient | null> {
  const stored = await Bun.secrets.get({ service: SERVICE, name: "google-shared-client" });
  return stored ? (JSON.parse(stored) as SharedGoogleClient) : null;
}

export async function saveSharedGoogleClient(client: SharedGoogleClient): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: "google-shared-client", value: JSON.stringify(client) });
}

/** Secrets standard apps reuse (an SMTP URL, an API key), by environment variable name. */
export async function getSharedSecret(name: string): Promise<string | null> {
  return Bun.secrets.get({ service: SERVICE, name: `shared/${name}` });
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
