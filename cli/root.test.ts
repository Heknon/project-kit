import { describe, expect, test } from "bun:test";
import { FIXTURES } from "./fixtures";
import { hcl, providersFor, rootModule } from "./root";

const backend = { bucket: "state", region: "eu-central-1" };

describe("hcl", () => {
  test("strings never interpolate", () => {
    expect(hcl("${var.x} %{if}")).toBe('"$${var.x} %%{if}"');
  });

  test("objects and lists", () => {
    expect(hcl({ a: [1, true, null], b: "x" })).toBe('{\n  "a" = [1, true, null]\n  "b" = "x"\n}');
    expect(hcl({})).toBe("{}");
  });
});

describe("root module", () => {
  test("only the providers a project uses", () => {
    expect(providersFor(FIXTURES.minimal)).toEqual(["vercel", "github", "random"]);
    expect(providersFor(FIXTURES.full)).toEqual(["vercel", "github", "random", "neon", "aws", "cloudflare"]);
    const minimal = rootModule(FIXTURES.minimal, backend);
    expect(minimal).not.toContain('provider "aws"');
    expect(minimal).not.toContain('module "neon"');
    expect(minimal).toContain("database                  = null");
  });

  test("state per project", () => {
    expect(rootModule(FIXTURES.full, backend)).toContain('key          = "projects/app/tofu.tfstate"');
  });

  test("imports adopt existing resources", () => {
    const root = rootModule(FIXTURES.minimal, backend, { "module.platform.vercel_project.this": "team_abc/prj_1" });
    expect(root).toContain('import {\n  to = module.platform.vercel_project.this\n  id = "team_abc/prj_1"\n}');
  });

  test("Google is left out until both clients exist", () => {
    expect(rootModule(FIXTURES.postgres, backend)).toContain("google                    = null");
    expect(rootModule(FIXTURES.full, backend)).toContain('"production_client_id" = "p.apps.googleusercontent.com"');
  });
});

describe("permissions boundary", () => {
  test("standard apps' roles carry the kit boundary, isolated apps' don't", () => {
    expect(rootModule(FIXTURES.full, backend)).toContain("permissions_boundary_arn = data.aws_iam_policy.app_boundary.arn");
    const isolated = rootModule(FIXTURES.postgres, backend);
    expect(isolated).toContain("permissions_boundary_arn = null");
    expect(isolated).toContain('key          = "isolated/app/tofu.tfstate"');
  });
});
