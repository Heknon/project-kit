import { saveSharedGoogleClient, saveSharedSecret } from "../credentials";
import { LOCAL_ORIGINS, openUrl } from "../google";
import { ask, askHidden, readPiped } from "../prompt";
import { KitError } from "../settings";

/**
 * The Google OAuth client every standard app signs in with. Created once in the console with
 * the localhost redirect URIs; each app's own URIs are added when `kit apply` asks for them.
 */
export async function setSharedGoogleClient(): Promise<void> {
  const gcpProject = ask("Google Cloud project id of the shared client (create one at https://console.cloud.google.com/projectcreate)");
  console.log(
    [
      "",
      "In the console that opens: Clients → Create client → Web application. Name it \"kit shared\".",
      "Authorized redirect URIs, for now only the local ones:",
      ...LOCAL_ORIGINS.map((origin) => `  ${origin}/api/auth/callback/google`),
      "Then publish the app under Audience, so anyone can sign in, not just test users.",
      "",
    ].join("\n"),
  );
  await openUrl(`https://console.cloud.google.com/auth/clients/create?project=${encodeURIComponent(gcpProject)}`);
  const clientId = ask("Client ID");
  if (!clientId.endsWith(".apps.googleusercontent.com")) throw new KitError("That isn't a Google OAuth client ID.");
  const clientSecret = await askHidden("Client secret");
  await saveSharedGoogleClient({ clientId, clientSecret, gcpProject });
  console.log("Saved the shared Google client in the OS keychain. Every `kit apply` of a standard app writes it to Vercel.");
}

export async function setSharedSecret(name: string | undefined): Promise<void> {
  if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new KitError("Usage: kit shared set <NAME>");
  const value = (await readPiped()) ?? (await askHidden(name));
  await saveSharedSecret(name, value);
  console.log(`Saved ${name}. Standard apps that list it as a shared secret get it on their next \`kit apply\`.`);
}
