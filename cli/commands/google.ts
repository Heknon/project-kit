import { getToken } from "../credentials";
import {
  type ClientSpec,
  clientSpecs,
  consoleUrls,
  copyToClipboard,
  type DownloadedClient,
  missingConfiguration,
  openUrl,
  parseClientFile,
  verifyRedirect,
  waitForDownload,
} from "../google";
import { ask, confirm } from "../prompt";
import { googleClient, KitError, type Settings } from "../settings";
import { loadLocalConfig, loadSettings, saveSettings } from "../store";
import { Vercel } from "../vercel";
import { apply } from "./apply";

/**
 * Google has no API for OAuth web clients, so this walks through the console: it opens each
 * page, puts the values on the clipboard, reads the client file you download, checks it with
 * Google, deletes it, and stores the secret in Vercel. Nothing is kept on disk.
 */
export async function google(name: string | undefined): Promise<void> {
  if (!name) throw new KitError("Usage: kit google <name>");
  const config = await loadLocalConfig();
  const settings = await loadSettings(config, name);
  if (googleClient(settings) === "shared") {
    throw new KitError(`${name} signs in with the shared client; \`kit apply ${name}\` writes it. Save the client once with \`kit shared google\`.`);
  }
  const vercel = new Vercel(await getToken("vercel"), settings.vercel.teamId);
  const project = await vercel.project(settings.name);
  if (!project) throw new KitError(`The Vercel project doesn't exist yet. Run \`kit apply ${name}\` first.`);

  const gcpProject = settings.google?.gcpProject ?? ask("Google Cloud project id (create one at https://console.cloud.google.com/projectcreate)");
  const urls = consoleUrls(gcpProject);

  console.log(`\n1. Consent screen. In the page that opens: app name ${settings.name}, your support email, audience External.`);
  await openUrl(urls.branding);
  ask("Press Enter when the consent screen is saved", "");

  const google: NonNullable<Settings["google"]> = { ...settings.google, client: "own", gcpProject };
  for (const spec of clientSpecs(settings)) {
    const client = await createClient(spec, urls.createClient);
    await vercel.setSecret(project.id, "AUTH_GOOGLE_SECRET", client.clientSecret, spec.kind);
    if (spec.kind === "production") google.productionClientId = client.clientId;
    else google.nonproductionClientId = client.clientId;
    console.log(`   Saved: client id in the project settings, secret in Vercel (${spec.kind}).`);
  }

  console.log("\n4. Publish the app (Audience → Publish app). In Testing mode only listed test users can sign in.");
  await openUrl(urls.audience);
  ask("Press Enter when it's published", "");

  await saveSettings(config, { ...settings, google });
  if (confirm(`Apply ${name} now, so Vercel gets the client ids?`, true)) await apply(name);
}

async function createClient(spec: ClientSpec, createUrl: string): Promise<DownloadedClient> {
  const step = spec.kind === "production" ? 2 : 3;
  console.log(`\n${step}. OAuth client "${spec.name}" (type Web application).`);
  console.log(`   Authorized JavaScript origins:\n${spec.origins.map((o) => `     ${o}`).join("\n")}`);
  console.log(`   Authorized redirect URIs (on the clipboard):\n${spec.redirectUris.map((u) => `     ${u}`).join("\n")}`);
  console.log("   Create it, then click Download JSON. The file is read from Downloads and deleted.");
  await copyToClipboard(spec.redirectUris.join("\n"));
  const since = Date.now();
  await openUrl(createUrl);

  for (;;) {
    const client = parseClientFile(await waitForDownload(since));
    const missing = missingConfiguration(spec, client);
    if (missing.length === 0) {
      for (const uri of spec.redirectUris) {
        const problem = await verifyRedirect(client.clientId, uri);
        if (problem) console.log(`   Warning: ${problem}. New clients can take a few minutes to reach Google's servers.`);
      }
      return client;
    }
    console.log(`   The client is missing:\n${missing.map((m) => `     ${m}`).join("\n")}`);
    console.log("   Add them in the console (the client's edit page), save, and download its JSON again.");
  }
}
