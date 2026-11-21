import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Declaration, RepoEnvError, parseRotate, planScope, randomHex, readDeclaration, syncRepoEnv } from "./repo-env";
import { tempDir } from "./store";

const PYPROJECT = `[project]
name = "bot"
requires-python = ">=3.14"

[tool.project-kit.env]
PERSONALITY_SECRET = { scopes = ["production"], generate = true }
ATTRIBUTION_SECRET = { scopes = ["production"], generate = true }
PUBLIC_BOT = { scopes = ["production"], sensitive = false, optional = true }
`;

const declaration = (variables: Record<string, unknown>): Declaration => {
  const parsed = readDeclaration({ packageJson: JSON.stringify({ "project-kit": { env: variables } }) });
  if (!parsed) throw new Error("no declaration");
  return parsed;
};

describe("the declaration", () => {
  test("in [tool.project-kit.env] of pyproject.toml", () => {
    expect(readDeclaration({ pyproject: PYPROJECT })).toEqual({
      source: "[tool.project-kit.env] of pyproject.toml",
      variables: [
        { name: "PERSONALITY_SECRET", scopes: ["production"], generate: true, sensitive: true, optional: false },
        { name: "ATTRIBUTION_SECRET", scopes: ["production"], generate: true, sensitive: true, optional: false },
        { name: "PUBLIC_BOT", scopes: ["production"], generate: false, sensitive: false, optional: true },
      ],
    });
  });

  test('in "project-kit".env of package.json', () => {
    const parsed = declaration({ SMTP_URL: { scopes: ["production", "dev"] } });
    expect(parsed.variables).toEqual([{ name: "SMTP_URL", scopes: ["production", "dev"], generate: false, sensitive: true, optional: false }]);
  });

  test("none: no table, or no files", () => {
    expect(readDeclaration({ pyproject: '[project]\nname = "x"\n', packageJson: "{}" })).toBeNull();
    expect(readDeclaration({})).toBeNull();
  });

  test("one place, not both", () => {
    const packageJson = JSON.stringify({ "project-kit": { env: {} } });
    expect(() => readDeclaration({ pyproject: PYPROJECT, packageJson })).toThrow(/one place/);
  });

  test("broken files say which", () => {
    expect(() => readDeclaration({ pyproject: "[tool" })).toThrow(/pyproject.toml isn't valid TOML/);
    expect(() => readDeclaration({ packageJson: "{" })).toThrow(/package.json isn't valid JSON/);
  });

  const invalid: [string, Record<string, unknown>, RegExp][] = [
    ["lower-case name", { secret: { scopes: ["production"], generate: true } }, /upper case/],
    ["a contract name", { AUTH_SECRET: { scopes: ["production"], generate: true } }, /set by the kit/],
    ["the deploy token", { VERCEL_TOKEN: { scopes: ["production"] } }, /reserved for the kit's workflows/],
    ["a Neon key", { NEON_API_KEY: { scopes: ["preview"] } }, /reserved/],
    ["no table", { KEY: "production" }, /give a table/],
    ["a typo", { KEY: { scopes: ["production"], generated: true } }, /unknown generated/],
    ["no scopes", { KEY: { generate: true } }, /scopes is a list of production, dev, preview/],
    ["an unknown scope", { KEY: { scopes: ["staging"] } }, /scopes is a list/],
    ["nonproduction (a settings scope)", { KEY: { scopes: ["nonproduction"] } }, /scopes is a list/],
    ["a scope twice", { KEY: { scopes: ["dev", "dev"] } }, /twice/],
    ["a string flag", { KEY: { scopes: ["dev"], optional: "yes" } }, /true or false/],
    ["a readable generated value", { KEY: { scopes: ["dev"], generate: true, sensitive: false } }, /always sensitive/],
    ["an optional generated value", { KEY: { scopes: ["dev"], generate: true, optional: true } }, /never missing/],
  ];
  for (const [what, variables, message] of invalid) {
    test(`refuses ${what}`, () => {
      expect(() => declaration(variables)).toThrow(RepoEnvError);
      expect(() => declaration(variables)).toThrow(message);
    });
  }

  test("every problem at once, each with its source and name", () => {
    let message = "";
    try {
      declaration({ a: {}, B: { scopes: [] } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split("\n")).toEqual([
      '"project-kit".env of package.json: a: names are upper case letters, digits and underscores',
      '"project-kit".env of package.json: B: scopes is a list of production, dev, preview',
    ]);
  });
});

describe("a scope's plan", () => {
  let counter = 0;
  const random = () => `random-${++counter}`;
  const plan = (options: Partial<Parameters<typeof planScope>[0]> & { declaration: Declaration }) =>
    planScope({ scope: "production", existing: [], secrets: {}, vars: {}, rotate: [], random, ...options });

  test("generates a missing value once, and keeps one that exists", () => {
    const generated = declaration({ COOKIE_SECRET: { scopes: ["production", "dev", "preview"], generate: true } });
    const first = plan({ declaration: generated });
    expect(first.writes).toEqual([{ key: "COOKIE_SECRET", value: expect.stringMatching(/^random-/), type: "sensitive", target: "production", gitBranch: undefined, from: "a new random value" }]);

    const existing = [{ key: "COOKIE_SECRET", target: ["production"] }];
    const second = plan({ declaration: generated, existing });
    expect(second.writes).toEqual([]);
    expect(second.notes).toEqual(["COOKIE_SECRET (production): kept."]);
  });

  test("dev and preview are separate: a dev-branch value isn't a preview value, nor the other way", () => {
    const generated = declaration({ COOKIE_SECRET: { scopes: ["dev", "preview"], generate: true } });
    const devOnly = [{ key: "COOKIE_SECRET", target: ["preview"], gitBranch: "dev" }];
    expect(plan({ declaration: generated, scope: "dev", existing: devOnly }).writes).toEqual([]);
    const preview = plan({ declaration: generated, scope: "preview", existing: devOnly }).writes;
    expect(preview).toMatchObject([{ key: "COOKIE_SECRET", target: "preview", gitBranch: undefined }]);

    const previewOnly = [{ key: "COOKIE_SECRET", target: ["preview"], gitBranch: null }];
    expect(plan({ declaration: generated, scope: "dev", existing: previewOnly }).writes).toMatchObject([{ target: "preview", gitBranch: "dev" }]);
  });

  test("rotate replaces named generated values, in the scopes that declare them", () => {
    const generated = declaration({ A: { scopes: ["production"], generate: true }, B: { scopes: ["dev"], generate: true } });
    const result = plan({ declaration: generated, existing: [{ key: "A", target: ["production"] }], rotate: ["A", "B"] });
    expect(result.writes).toMatchObject([{ key: "A", type: "sensitive", from: "a new random value (rotate)" }]);
    expect(result.notes).toEqual(["B isn't in the production scope; not rotated here."]);
    expect(result.errors).toEqual([]);
  });

  test("rotate refuses names that aren't generated", () => {
    const declared = declaration({ A: { scopes: ["production"] } });
    expect(plan({ declaration: declared, secrets: { A: "x" }, rotate: ["A", "NOPE"] }).errors).toEqual([
      'rotate names A, which "project-kit".env of package.json doesn\'t declare with generate = true.',
      'rotate names NOPE, which "project-kit".env of package.json doesn\'t declare with generate = true.',
    ]);
  });

  test("a value from GitHub is written every time, sensitive from a secret", () => {
    const declared = declaration({ SMTP_URL: { scopes: ["production"] } });
    const existing = [{ key: "SMTP_URL", target: ["production"] }];
    expect(plan({ declaration: declared, existing, secrets: { SMTP_URL: "smtp://x" } }).writes).toEqual([
      { key: "SMTP_URL", value: "smtp://x", type: "sensitive", target: "production", gitBranch: undefined, from: "the GitHub secret" },
    ]);
  });

  test("a sensitive value never comes from a GitHub variable", () => {
    const declared = declaration({ SMTP_URL: { scopes: ["production"] } });
    const result = plan({ declaration: declared, vars: { SMTP_URL: "smtp://x" } });
    expect(result.writes).toEqual([]);
    expect(result.errors).toEqual([
      "SMTP_URL has no value for production: add a GitHub secret SMTP_URL to the production environment or the repository, or mark it optional = true.",
    ]);
  });

  test("a non-sensitive value comes from a secret first, then a variable, and is stored readable", () => {
    const declared = declaration({ PUBLIC_BOT: { scopes: ["production"], sensitive: false } });
    expect(plan({ declaration: declared, vars: { PUBLIC_BOT: "bot-1" } }).writes).toMatchObject([
      { key: "PUBLIC_BOT", value: "bot-1", type: "encrypted", from: "the GitHub variable" },
    ]);
    expect(plan({ declaration: declared, secrets: { PUBLIC_BOT: "s" }, vars: { PUBLIC_BOT: "v" } }).writes).toMatchObject([
      { value: "s", type: "encrypted", from: "the GitHub secret" },
    ]);
    expect(plan({ declaration: declared }).errors[0]).toContain("add a GitHub secret or variable PUBLIC_BOT");
  });

  test("an optional value with nothing in GitHub is left out; empty counts as nothing", () => {
    const declared = declaration({ PUBLIC_BOT: { scopes: ["production"], sensitive: false, optional: true } });
    const result = plan({ declaration: declared, vars: { PUBLIC_BOT: "" } });
    expect(result).toEqual({ writes: [], notes: ["PUBLIC_BOT (production): no value in GitHub; left out."], errors: [] });
  });

  test("other scopes' variables are not touched", () => {
    const declared = declaration({ A: { scopes: ["dev"], generate: true }, B: { scopes: ["preview"] } });
    expect(plan({ declaration: declared })).toEqual({ writes: [], notes: [], errors: [] });
  });
});

test("rotate takes commas or spaces", () => {
  expect(parseRotate(" A,B  C,,A ")).toEqual(["A", "B", "C"]);
  expect(parseRotate(undefined)).toEqual([]);
});

test("random values are 32 bytes of hex, and differ", () => {
  expect(randomHex()).toMatch(/^[0-9a-f]{64}$/);
  expect(randomHex()).not.toBe(randomHex());
});

describe("the workflow step", () => {
  interface Call {
    method: string;
    url: string;
    body?: Record<string, unknown>;
  }

  async function step(files: Record<string, string>, args: string[], env: Record<string, string>, existing: unknown[] = []) {
    const cwd = await tempDir();
    for (const [path, content] of Object.entries(files)) await Bun.write(join(cwd, path), content);
    const calls: Call[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const code = await syncRepoEnv(args, {
      cwd,
      env: { VERCEL_TOKEN: "tok", VERCEL_PROJECT_ID: "prj_1", VERCEL_ORG_ID: "team_1", ...env },
      fetch: async (url, init) => {
        calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
        return Response.json(init.method === "GET" ? { envs: existing } : {});
      },
      print: (line) => out.push(line),
      printError: (line) => err.push(line),
      random: () => "f".repeat(64),
    });
    return { code, out, err, calls };
  }

  test("--check says whether there is a declaration, and whether it needs GitHub variables", async () => {
    expect((await step({ "pyproject.toml": PYPROJECT }, ["--check"], {})).out).toEqual(["declared=true", "vars=true"]);
    const secretsOnly = JSON.stringify({ "project-kit": { env: { A: { scopes: ["dev"], generate: true } } } });
    expect((await step({ "package.json": secretsOnly }, ["--check"], {})).out).toEqual(["declared=true"]);
    const none = await step({ "package.json": "{}" }, ["--check"], {});
    expect(none).toMatchObject({ code: 0, out: [], calls: [] });
  });

  test("--check fails on an invalid declaration, on stderr", async () => {
    const bad = JSON.stringify({ "project-kit": { env: { AUTH_SECRET: { scopes: ["dev"] } } } });
    const result = await step({ "package.json": bad }, ["--check"], {});
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual(['::error::"project-kit".env of package.json: AUTH_SECRET: this name is set by the kit (docs/contract.md)']);
  });

  test("writes production: generated values masked first, values never printed", async () => {
    const env = { APP_ENV: "production", KIT_SECRETS: JSON.stringify({ VERCEL_TOKEN: "tok" }), KIT_VARS: JSON.stringify({ PUBLIC_BOT: "bot-1" }) };
    const existing = [{ key: "ATTRIBUTION_SECRET", target: ["production"] }, { key: "UNDECLARED", target: ["production"] }];
    const { code, out, err, calls } = await step({ "pyproject.toml": PYPROJECT }, [], env, existing);
    expect(code).toBe(0);
    expect(err).toEqual([`::add-mask::${"f".repeat(64)}`]);
    expect(out.join("\n")).not.toContain("f".repeat(64));
    expect(out).toEqual([
      "ATTRIBUTION_SECRET (production): kept.",
      "PERSONALITY_SECRET (production): set from a new random value.",
      "PUBLIC_BOT (production): set from the GitHub variable.",
    ]);
    expect(calls).toEqual([
      { method: "GET", url: "https://api.vercel.com/v10/projects/prj_1/env?teamId=team_1", body: undefined },
      {
        method: "POST",
        url: "https://api.vercel.com/v10/projects/prj_1/env?upsert=true&teamId=team_1",
        body: { key: "PERSONALITY_SECRET", value: "f".repeat(64), type: "sensitive", target: ["production"] },
      },
      {
        method: "POST",
        url: "https://api.vercel.com/v10/projects/prj_1/env?upsert=true&teamId=team_1",
        body: { key: "PUBLIC_BOT", value: "bot-1", type: "encrypted", target: ["production"] },
      },
    ]);
  });

  test("a missing required value fails the run before anything is written", async () => {
    const files = { "package.json": JSON.stringify({ "project-kit": { env: { A: { scopes: ["dev"], generate: true }, SMTP_URL: { scopes: ["dev"] } } } }) };
    const { code, err, calls } = await step(files, [], { APP_ENV: "dev" });
    expect(code).toBe(1);
    expect(err.at(-1)).toBe(
      "::error::SMTP_URL has no value for dev: add a GitHub secret SMTP_URL to the dev environment or the repository, or mark it optional = true.",
    );
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("a secret's value is masked line by line and written to the dev branch", async () => {
    const files = { "package.json": JSON.stringify({ "project-kit": { env: { KEY: { scopes: ["dev"] } } } }) };
    const { code, err, calls } = await step(files, [], { APP_ENV: "dev", KIT_SECRETS: JSON.stringify({ KEY: "line1\nline2" }) });
    expect(code).toBe(0);
    expect(err).toEqual(["::add-mask::line1", "::add-mask::line2"]);
    expect(calls[1]?.body).toEqual({ key: "KEY", value: "line1\nline2", type: "sensitive", target: ["preview"], gitBranch: "dev" });
  });

  test("a personal account's project gets no teamId; no Vercel secrets is an error", async () => {
    const files = { "package.json": JSON.stringify({ "project-kit": { env: { A: { scopes: ["preview"], generate: true } } } }) };
    const personal = await step(files, [], { APP_ENV: "preview", VERCEL_ORG_ID: "user_1" });
    expect(personal.calls[0]?.url).toBe("https://api.vercel.com/v10/projects/prj_1/env");
    const missing = await step(files, [], { APP_ENV: "preview", VERCEL_TOKEN: "" });
    expect(missing.code).toBe(1);
    expect(missing.err).toEqual(["::error::The preview environment has no Vercel secrets. Run kit apply for this project."]);
  });

  test("a Vercel error fails the run with its message", async () => {
    const cwd = await tempDir();
    await Bun.write(join(cwd, "pyproject.toml"), PYPROJECT);
    const err: string[] = [];
    const code = await syncRepoEnv([], {
      cwd,
      env: { APP_ENV: "production", VERCEL_TOKEN: "tok", VERCEL_PROJECT_ID: "prj_1" },
      fetch: async () => Response.json({ error: { message: "Not authorized" } }, { status: 403 }),
      print: () => {},
      printError: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err).toEqual(["::error::Vercel GET /v10/projects/prj_1/env failed (403): Not authorized"]);
  });
});
