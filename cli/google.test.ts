import { describe, expect, test } from "bun:test";
import { FIXTURES } from "./fixtures";
import { clientSpecs, missingConfiguration, parseClientFile } from "./google";
import { KitError } from "./settings";

describe("Google OAuth clients", () => {
  const [production, nonproduction] = clientSpecs(FIXTURES.minimal);
  if (!production || !nonproduction) throw new Error("two clients");

  test("production only accepts production; dev, previews and local share the other client", () => {
    expect(production?.redirectUris).toEqual(["https://app.example.com/api/auth/callback/google"]);
    expect(nonproduction?.redirectUris).toContain("https://dev.app.example.com/api/auth/callback/google");
    expect(nonproduction?.redirectUris).toContain("http://localhost:3000/api/auth/callback/google");
    expect(nonproduction?.redirectUris.some((u) => u.includes("vercel.app"))).toBe(false);
  });

  test("reads the downloaded client and finds what's missing", () => {
    const client = parseClientFile(
      JSON.stringify({
        web: {
          client_id: "id.apps.googleusercontent.com",
          client_secret: "secret",
          redirect_uris: ["https://app.example.com/api/auth/callback/google"],
          javascript_origins: [],
        },
      }),
    );
    expect(client.clientId).toBe("id.apps.googleusercontent.com");
    expect(missingConfiguration(production, client)).toEqual(["JavaScript origin https://app.example.com"]);
  });

  test("rejects other credential files", () => {
    expect(() => parseClientFile(JSON.stringify({ installed: { client_id: "x" } }))).toThrow(KitError);
  });
});
