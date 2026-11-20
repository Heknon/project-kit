import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./exec";
import { KitError, type Settings } from "./settings";

export const LOCAL_ORIGINS = ["http://localhost:3000", "http://localhost:5173"];

export interface ClientSpec {
  kind: "production" | "nonproduction";
  name: string;
  origins: string[];
  redirectUris: string[];
}

export function clientSpecs(settings: Settings): ClientSpec[] {
  const callback = (origin: string) => `${origin}/api/auth/callback/google`;
  const production = `https://${settings.domains.production}`;
  const dev = `https://${settings.domains.dev}`;
  return [
    { kind: "production", name: `${settings.name} production`, origins: [production], redirectUris: [callback(production)] },
    {
      kind: "nonproduction",
      name: `${settings.name} dev, previews and local`,
      origins: [dev, ...LOCAL_ORIGINS],
      redirectUris: [callback(dev), ...LOCAL_ORIGINS.map(callback)],
    },
  ];
}

export interface DownloadedClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  origins: string[];
}

/** Parses the JSON Google offers on "Download JSON" after creating a web client. */
export function parseClientFile(text: string): DownloadedClient {
  const parsed = JSON.parse(text) as { web?: { client_id?: string; client_secret?: string; redirect_uris?: string[]; javascript_origins?: string[] } };
  const web = parsed.web;
  if (!web?.client_id || !web.client_secret) throw new KitError("That file isn't a web application OAuth client.");
  return {
    clientId: web.client_id,
    clientSecret: web.client_secret,
    redirectUris: web.redirect_uris ?? [],
    origins: web.javascript_origins ?? [],
  };
}

export function missingConfiguration(spec: ClientSpec, client: DownloadedClient): string[] {
  return [
    ...spec.redirectUris.filter((uri) => !client.redirectUris.includes(uri)).map((uri) => `redirect URI ${uri}`),
    ...spec.origins.filter((origin) => !client.origins.includes(origin)).map((origin) => `JavaScript origin ${origin}`),
  ];
}

/**
 * Asks Google's authorization endpoint whether it accepts this client and redirect URI.
 * A mismatch answers 400 with redirect_uri_mismatch, an unknown client 401.
 */
export async function verifyRedirect(clientId: string, redirectUri: string): Promise<string | null> {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email" }).toString();
  const response = await fetch(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    return /error=|authError/.test(location) ? `Google refused ${redirectUri}` : null;
  }
  const body = await response.text();
  if (/redirect_uri_mismatch/.test(body)) return `Google doesn't have ${redirectUri} registered for this client yet`;
  if (/invalid_client|deleted_client/.test(body)) return "Google doesn't know this client id";
  return response.ok ? null : `Google answered ${response.status} for ${redirectUri}`;
}

export function consoleUrls(gcpProject: string) {
  const q = `?project=${encodeURIComponent(gcpProject)}`;
  return {
    branding: `https://console.cloud.google.com/auth/branding${q}`,
    audience: `https://console.cloud.google.com/auth/audience${q}`,
    createClient: `https://console.cloud.google.com/auth/clients/create${q}`,
  };
}

export async function openUrl(url: string): Promise<void> {
  const command =
    process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  await run(command, { allowFailure: true });
}

export async function copyToClipboard(text: string): Promise<void> {
  const command = process.platform === "win32" ? ["clip"] : process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
  await run(command, { stdin: text, allowFailure: true });
}

/** Waits for the next client_secret_*.json in Downloads, reads it and deletes it. */
export async function waitForDownload(since: number, timeoutMs = 15 * 60_000): Promise<string> {
  const downloads = join(homedir(), "Downloads");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await readdir(downloads).catch(() => [] as string[]);
    for (const name of names) {
      if (!/^client_secret_.*\.json$/.test(name)) continue;
      const path = join(downloads, name);
      const info = await stat(path);
      if (info.mtimeMs < since) continue;
      const text = await Bun.file(path).text();
      await rm(path, { force: true });
      return text;
    }
    await Bun.sleep(1000);
  }
  throw new KitError("No client_secret_*.json appeared in Downloads within 15 minutes.");
}
