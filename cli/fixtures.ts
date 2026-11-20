import { parseSettings, type Settings } from "./settings";

const base = {
  kitVersion: "0.1.0",
  name: "app",
  repository: "owner/app",
  vercel: { teamId: "team_abc", teamSlug: "owner-team" },
  domains: { production: "app.example.com", dev: "dev.app.example.com" },
};

/** Project settings covering each kind, shared by the tests and the root-module validation. */
export const FIXTURES = {
  minimal: parseSettings(base),
  full: parseSettings({
    ...base,
    database: { kind: "neon", orgId: "org-abc" },
    storage: { kind: "s3" },
    google: { productionClientId: "p.apps.googleusercontent.com", nonproductionClientId: "n.apps.googleusercontent.com" },
    cron: true,
    generated: ["COOKIE_SECRET"],
    supplied: [{ name: "SMTP_URL", scopes: ["production", "nonproduction"] }],
    env: { production: { VITE_RUNTIME: "server" }, preview: { VITE_RUNTIME: "server" }, dev: {} },
    awsDeploy: { policyArns: [] },
    dns: { provider: "cloudflare", zoneId: "zone" },
  }),
  postgres: parseSettings({
    ...base,
    database: { kind: "postgres" },
    storage: { kind: "s3", existingBuckets: { production: "old-prod", dev: "old-dev" } },
    google: {},
  }),
} satisfies Record<string, Settings>;
