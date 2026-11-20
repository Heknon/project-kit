import { z } from "zod";

/** Names the kit sets itself (docs/contract.md); a project's own values may not reuse them. */
export const CONTRACT_NAMES = new Set([
  "APP_ENV",
  "APP_URL",
  "CRON_SECRET",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "S3_BUCKET",
  "S3_REGION",
  "S3_PREFIX",
  "S3_ROLE_ARN",
  "AUTH_SECRET",
  "AUTH_URL",
  "AUTH_REDIRECT_PROXY_URL",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
]);

const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "environment variable names are upper case")
  .refine((name) => !CONTRACT_NAMES.has(name), { message: "this name is set by the kit (docs/contract.md)" });

const envMap = z
  .record(z.string(), z.string().min(1))
  .superRefine((map, ctx) => {
    for (const key of Object.keys(map)) {
      const result = envName.safeParse(key);
      if (!result.success) ctx.addIssue({ code: "custom", path: [key], message: result.error.issues[0]?.message ?? "invalid name" });
    }
  })
  .default({});

export const SCOPES = ["production", "nonproduction", "preview", "dev"] as const;
export type Scope = (typeof SCOPES)[number];

const domain = z.string().regex(/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/, "a domain name, without https://");

export const Settings = z
  .object({
    kitVersion: z.string(),
    name: z.string().regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/, "lower-case letters, digits and hyphens"),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
    /**
     * standard: may use the credentials shared by your apps (the shared Google client, shared
     * secrets). isolated: shares nothing with any other app.
     */
    security: z.enum(["standard", "isolated"]).default("standard"),
    productionBranch: z.string().min(1).default("main"),
    productionDeploy: z.enum(["push", "dispatch"]).default("push"),
    protectBranches: z.boolean().default(true),
    region: z.string().default("eu-central-1"),
    vercel: z.object({
      teamId: z.string().startsWith("team_"),
      teamSlug: z.string().min(1),
      functionRegion: z.string().default("fra1"),
    }),
    domains: z.object({ production: domain, dev: domain }),
    dns: z
      .discriminatedUnion("provider", [
        z.object({ provider: z.literal("none") }),
        z.object({ provider: z.literal("cloudflare"), zoneId: z.string().min(1) }),
      ])
      .default({ provider: "none" }),
    database: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }),
        z.object({ kind: z.literal("neon"), orgId: z.string().min(1), region: z.string().default("aws-eu-central-1") }),
        z.object({ kind: z.literal("postgres") }),
      ])
      .default({ kind: "none" }),
    storage: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }),
        z.object({
          kind: z.literal("s3"),
          existingBuckets: z.object({ production: z.string(), dev: z.string() }).optional(),
          versioning: z.boolean().default(false),
        }),
      ])
      .default({ kind: "none" }),
    google: z
      .object({
        /** shared: the client saved by `kit init`; own: two clients made by `kit google`. By default shared for standard apps and own for isolated ones. */
        client: z.enum(["shared", "own"]).optional(),
        gcpProject: z.string().optional(),
        productionClientId: z.string().endsWith(".apps.googleusercontent.com").optional(),
        nonproductionClientId: z.string().endsWith(".apps.googleusercontent.com").optional(),
      })
      .optional(),
    cron: z.boolean().default(false),
    generated: z.array(envName).default([]),
    supplied: z
      .array(
        z.object({
          name: envName,
          scopes: z.array(z.enum(SCOPES)).min(1),
          /** The value saved once with `kit shared set`, written by every apply. */
          shared: z.boolean().default(false),
        }),
      )
      .default([]),
    env: z
      .object({ production: envMap, dev: envMap, preview: envMap })
      .default({ production: {}, dev: {}, preview: {} }),
    awsDeploy: z.object({ policyArns: z.array(z.string()).default([]) }).optional(),
  })
  .superRefine((settings, ctx) => {
    if (settings.domains.production === settings.domains.dev) {
      ctx.addIssue({ code: "custom", path: ["domains", "dev"], message: "dev needs its own domain" });
    }
    const supplied = settings.supplied.map((s) => s.name);
    for (const name of settings.generated) {
      if (supplied.includes(name)) {
        ctx.addIssue({ code: "custom", path: ["generated"], message: `${name} is both generated and supplied` });
      }
    }
    if (settings.security === "standard" && settings.storage.kind === "s3" && settings.storage.existingBuckets) {
      for (const bucket of Object.values(settings.storage.existingBuckets)) {
        if (!bucket.startsWith("kit-")) {
          ctx.addIssue({ code: "custom", path: ["storage", "existingBuckets"], message: `standard apps only use kit-* buckets; adopt ${bucket} in an isolated project` });
        }
      }
    }
    if (settings.security === "isolated") {
      if (settings.google?.client === "shared") {
        ctx.addIssue({ code: "custom", path: ["google", "client"], message: "an isolated app has its own Google clients" });
      }
      for (const secret of settings.supplied.filter((s) => s.shared)) {
        ctx.addIssue({ code: "custom", path: ["supplied"], message: `an isolated app can't use the shared ${secret.name}` });
      }
    }
  });


export type Settings = z.output<typeof Settings>;

export function parseSettings(input: unknown): Settings {
  const result = Settings.safeParse(input);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new KitError(`Invalid project settings:\n${lines.join("\n")}`);
}

/** Parts of the project `kit apply` leaves out until they are set up. */
export function pending(settings: Settings): string[] {
  const notes: string[] = [];
  if (settings.google && !googleReady(settings)) {
    notes.push(
      googleClient(settings) === "shared"
        ? "Google sign-in is left out until the shared client is saved: run `kit init`."
        : `Google sign-in is left out until it has OAuth clients: run \`kit google ${settings.name}\`.`,
    );
  }
  return notes;
}

export function googleClient(settings: Settings): "shared" | "own" {
  return settings.google?.client ?? (settings.security === "isolated" ? "own" : "shared");
}

export function googleReady(settings: Settings): boolean {
  return Boolean(settings.google?.productionClientId && settings.google.nonproductionClientId);
}

export class KitError extends Error {}
