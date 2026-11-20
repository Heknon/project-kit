import { describe, expect, test } from "bun:test";
import { parseEnv, parseSupplied } from "./commands/new";
import { FIXTURES } from "./fixtures";
import { googleClient, googleReady, KitError, parseSettings, pending } from "./settings";

const valid = FIXTURES.minimal;

describe("settings", () => {
  test("defaults", () => {
    expect(valid.productionBranch).toBe("main");
    expect(valid.productionDeploy).toBe("push");
    expect(valid.database.kind).toBe("none");
    expect(valid.vercel.functionRegion).toBe("fra1");
  });

  test("project values can't reuse contract names", () => {
    expect(() => parseSettings({ ...valid, generated: ["AUTH_SECRET"] })).toThrow(KitError);
    expect(() => parseSettings({ ...valid, env: { production: { DATABASE_URL: "x" }, preview: {}, dev: {} } })).toThrow(/set by the kit/);
  });

  test("dev needs its own domain", () => {
    expect(() => parseSettings({ ...valid, domains: { production: "a.example.com", dev: "a.example.com" } })).toThrow(/own domain/);
  });

  test("domains are host names", () => {
    expect(() => parseSettings({ ...valid, domains: { production: "https://a.example.com", dev: "b.example.com" } })).toThrow();
  });

  test("a secret is either generated or supplied", () => {
    expect(() =>
      parseSettings({ ...valid, generated: ["COOKIE_SECRET"], supplied: [{ name: "COOKIE_SECRET", scopes: ["production"] }] }),
    ).toThrow(/both generated and supplied/);
  });

  test("standard apps share the Google client, isolated apps have their own and share nothing", () => {
    expect(googleClient(valid)).toBe("shared");
    const isolated = parseSettings({ ...valid, security: "isolated", google: {} });
    expect(googleClient(isolated)).toBe("own");
    expect(isolated.productionDeploy).toBe("push");
    expect(() => parseSettings({ ...valid, security: "isolated", google: { client: "shared" } })).toThrow(/own Google clients/);
    expect(() =>
      parseSettings({ ...valid, security: "isolated", supplied: [{ name: "SMTP_URL", scopes: ["production"], shared: true }] }),
    ).toThrow(/shared SMTP_URL/);
  });

  test("Google waits for both clients", () => {
    expect(googleReady(FIXTURES.postgres)).toBe(false);
    expect(pending(FIXTURES.postgres)).toHaveLength(1);
    expect(googleReady(FIXTURES.full)).toBe(true);
  });
});

describe("flags", () => {
  test("--env", () => {
    expect(parseEnv(["all:VITE_RUNTIME=server", "dev:FLAG=on"])).toEqual({
      production: { VITE_RUNTIME: "server" },
      preview: { VITE_RUNTIME: "server" },
      dev: { FLAG: "on" },
    });
    expect(() => parseEnv(["VITE_RUNTIME=server"])).toThrow(KitError);
  });

  test("--supply", () => {
    expect(parseSupplied("SMTP_URL")).toEqual({ name: "SMTP_URL", scopes: ["production", "nonproduction"], shared: false });
    expect(parseSupplied("KEY:production")).toEqual({ name: "KEY", scopes: ["production"], shared: false });
    expect(() => parseSupplied("KEY:staging")).toThrow(KitError);
  });
});
