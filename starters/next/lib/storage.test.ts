import { describe, expect, test } from "bun:test";
import { parseEnv } from "./env";
import { clientConfig, objectKey, stripPrefix } from "./storage";

describe("objectKey", () => {
  test("prefixes every key with S3_PREFIX", () => {
    expect(objectKey("preview/pr-7/", "uploads", "user", "a.txt")).toBe("preview/pr-7/uploads/user/a.txt");
    expect(objectKey("dev/", "a.txt")).toBe("dev/a.txt");
  });

  test("uses no prefix in production", () => {
    expect(objectKey("", "uploads", "a.txt")).toBe("uploads/a.txt");
  });

  test("refuses parts that escape their folder", () => {
    for (const part of ["", ".", "..", "a/b"]) {
      expect(() => objectKey("dev/", "uploads", part)).toThrow();
    }
  });

  test("stripPrefix reverses the prefix", () => {
    expect(stripPrefix("dev/uploads/", "dev/uploads/a.txt")).toBe("a.txt");
  });
});

describe("clientConfig", () => {
  test("uses static keys and path-style addressing for a local endpoint", () => {
    const config = clientConfig(
      parseEnv({ S3_ENDPOINT: "http://localhost:8333", S3_ACCESS_KEY_ID: "key", S3_SECRET_ACCESS_KEY: "secret" }),
    );
    expect(config.forcePathStyle).toBe(true);
    expect(config.credentials).toEqual({ accessKeyId: "key", secretAccessKey: "secret" });
  });

  test("assumes the role with the Vercel OIDC token when S3_ROLE_ARN is set", () => {
    const config = clientConfig(
      parseEnv({ S3_ROLE_ARN: "arn:aws:iam::000000000000:role/app", S3_REGION: "eu-west-1" }),
    );
    expect(typeof config.credentials).toBe("function");
    expect(config.region).toBe("eu-west-1");
    expect(config.forcePathStyle).toBe(false);
  });

  test("falls back to the default credential chain", () => {
    expect(clientConfig(parseEnv({})).credentials).toBeUndefined();
  });
});
