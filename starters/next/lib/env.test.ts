import { describe, expect, test } from "bun:test";
import { parseEnv } from "./env";

describe("parseEnv", () => {
  test("accepts an empty environment", () => {
    const env = parseEnv({});
    expect(env.APP_ENV).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.S3_PREFIX).toBe("");
  });

  test("treats empty strings as unset", () => {
    const env = parseEnv({ S3_BUCKET: "", DATABASE_URL: "", S3_PREFIX: "" });
    expect(env.S3_BUCKET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.S3_PREFIX).toBe("");
  });

  test("reads the contract's values", () => {
    const env = parseEnv({
      APP_ENV: "preview",
      APP_URL: "https://example.test",
      DATABASE_URL: "postgres://user:pass@localhost:5432/app",
      S3_PREFIX: "preview/pr-12/",
      S3_ROLE_ARN: "arn:aws:iam::000000000000:role/app",
    });
    expect(env.APP_ENV).toBe("preview");
    expect(env.APP_URL).toBe("https://example.test");
    expect(env.S3_PREFIX).toBe("preview/pr-12/");
  });

  test("rejects an unknown APP_ENV", () => {
    expect(() => parseEnv({ APP_ENV: "staging" })).toThrow("APP_ENV");
  });

  test("rejects a prefix without a trailing slash", () => {
    expect(() => parseEnv({ S3_PREFIX: "dev" })).toThrow("S3_PREFIX");
  });

  test("rejects an APP_URL with a trailing slash", () => {
    expect(() => parseEnv({ APP_URL: "https://example.test/" })).toThrow("APP_URL");
  });

  test("names the variables without printing their values", () => {
    expect(() => parseEnv({ DATABASE_URL: "not a url with s3cret" })).toThrow(
      /^Invalid environment variables: DATABASE_URL$/,
    );
  });
});
