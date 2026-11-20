import { z } from "zod";

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const origin = z.url({ protocol: /^https?$/ }).refine((value) => !value.endsWith("/"), "no trailing slash");

const schema = z.object({
  APP_ENV: optional(z.enum(["production", "dev", "preview"])),
  APP_URL: optional(origin),
  DATABASE_URL: optional(z.url()),
  DATABASE_URL_UNPOOLED: optional(z.url()),
  S3_BUCKET: optional(z.string()),
  S3_REGION: optional(z.string()),
  S3_PREFIX: z.preprocess(
    (value) => value ?? "",
    z.string().refine((value) => value === "" || value.endsWith("/"), "must end with /"),
  ),
  S3_ROLE_ARN: optional(z.string().startsWith("arn:aws:iam::")),
  S3_ENDPOINT: optional(z.url()),
  S3_ACCESS_KEY_ID: optional(z.string()),
  S3_SECRET_ACCESS_KEY: optional(z.string()),
  AUTH_SECRET: optional(z.string()),
  AUTH_GOOGLE_ID: optional(z.string()),
  AUTH_GOOGLE_SECRET: optional(z.string()),
  AUTH_URL: optional(z.url()),
  AUTH_REDIRECT_PROXY_URL: optional(z.url()),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment variables: ${names.join(", ")}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);
