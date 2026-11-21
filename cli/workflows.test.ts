import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDir } from "./store";
import { KIT_DIR } from "./tofu";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
}
interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

const WORKFLOWS = ["preview.yml", "deploy.yml"];

async function workflow(file: string): Promise<Workflow> {
  return Bun.YAML.parse(await Bun.file(join(KIT_DIR, ".github", "workflows", file)).text()) as Workflow;
}

/** The kit.sh heredoc of every Kit helpers step, by job. */
async function helpers(): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const file of WORKFLOWS) {
    for (const [job, { steps }] of Object.entries((await workflow(file)).jobs)) {
      const run = steps.find((step) => step.name === "Kit helpers")?.run;
      const script = run?.match(/<<'SH'\n([\s\S]*?)\nSH\n/)?.[1];
      if (script) found[`${file}:${job}`] = script;
    }
  }
  return found;
}

test("every job that installs the app has the same kit helpers", async () => {
  const scripts = await helpers();
  expect(Object.keys(scripts).sort()).toEqual(["deploy.yml:deploy", "deploy.yml:full-tests", "preview.yml:full-tests", "preview.yml:preview"]);
  expect(new Set(Object.values(scripts)).size).toBe(1);
});

test("Python setup is pinned and only runs for Python apps", async () => {
  for (const file of WORKFLOWS) {
    for (const { steps } of Object.values((await workflow(file)).jobs)) {
      for (const step of steps) {
        if (step.uses?.startsWith("astral-sh/setup-uv@")) expect(step.uses).toMatch(/@v\d+\.\d+\.\d+$/);
      }
    }
  }
  const text = await Bun.file(join(KIT_DIR, ".github", "workflows", "deploy.yml")).text();
  expect(text).not.toMatch(/vars\./);
  expect(text).toContain("uv sync --frozen");
});

const bash = Bun.which("bash");
const python = !!bash && Bun.spawnSync([bash, "-c", "python3 -c 'import tomllib'"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const slash = (path: string) => path.replaceAll("\\", "/");

/** Runs `commands` in an app directory holding `files`, with kit.sh sourced. */
async function inApp(files: Record<string, string>, commands: string): Promise<{ code: number; out: string; err: string; temp: string }> {
  const [script] = Object.values(await helpers());
  const app = await tempDir();
  const temp = slash(await tempDir());
  for (const [path, content] of Object.entries(files)) await Bun.write(join(app, path), content);
  await Bun.write(join(temp, "kit.sh"), `${script}\n`);
  const result = Bun.spawnSync([bash as string, "-c", `set -e; source "$RUNNER_TEMP/kit.sh"; ${commands}`], {
    cwd: app,
    env: { ...process.env, RUNNER_TEMP: temp },
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString(), temp };
}

const PYPROJECT = `[project]
name = "app"
version = "0.1.0"
requires-python = ">=3.14"

[tool.project-kit.scripts]
check = "echo checked \\"$APP_ENV\\""
"db:migrate:deploy" = "python -m migrate"
`;

describe.skipIf(!bash)("kit helpers", () => {
  test("a Bun app keeps its package.json scripts", async () => {
    const files = { "package.json": JSON.stringify({ scripts: { check: "echo bun-checked" } }) };
    const { code, out } = await inApp(files, "kit_detect; export KIT_LANG=bun; run_script check; run_script test:full");
    expect(code).toBe(0);
    expect(out).toContain("KIT_LANG=bun\n");
    expect(out).toContain("bun-checked");
    expect(out).toContain("::notice::No test:full script in package.json; skipped.");
  });

  test("package.json without pyproject.toml is a Bun app only", async () => {
    const { out } = await inApp({ "package.json": "{}" }, "kit_detect");
    expect(out).toBe("KIT_LANG=bun\n");
  });

  test("a branch with neither deploys nothing", async () => {
    const { code, out } = await inApp({ "README.md": "" }, "kit_detect");
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("pyproject.toml without uv.lock is refused", async () => {
    const { code, err } = await inApp({ "pyproject.toml": PYPROJECT }, "kit_detect");
    expect(code).not.toBe(0);
    expect(err).toContain("Run uv lock and commit uv.lock.");
  });

  describe.skipIf(!python)("Python apps", () => {
    test("detected from pyproject.toml and uv.lock, with the lowest allowed Python", async () => {
      const { code, out, temp } = await inApp({ "pyproject.toml": PYPROJECT, "uv.lock": "" }, "kit_detect");
      expect(code).toBe(0);
      expect(out).toBe(`KIT_LANG=python\nKIT_PYTHON=3.14\nUV_PYTHON=3.14\nUV_PROJECT_ENVIRONMENT=${temp}/venv\n`);
    });

    test(".python-version pins the version", async () => {
      const { out } = await inApp({ "pyproject.toml": PYPROJECT, "uv.lock": "", ".python-version": "3.13.2\n" }, "kit_detect");
      expect(out).toContain("KIT_PYTHON=3.13\n");
    });

    test("a version Vercel can't run is refused", async () => {
      const old = PYPROJECT.replace(">=3.14", ">=3.10,<4");
      const { code, err } = await inApp({ "pyproject.toml": old, "uv.lock": "" }, "kit_detect");
      expect(code).not.toBe(0);
      expect(err).toContain("requires-python asks for Python 3.10; Vercel runs 3.12 and later.");
    });

    test("no version at all is refused", async () => {
      const none = PYPROJECT.replace('requires-python = ">=3.14"\n', "");
      const { code, err } = await inApp({ "pyproject.toml": none, "uv.lock": "" }, "kit_detect");
      expect(code).not.toBe(0);
      expect(err).toContain('Set requires-python = ">=3.12" in pyproject.toml, or add .python-version.');
    });

    test("a Bun app with pyproject.toml and uv.lock gets Python too", async () => {
      const { code, out, temp } = await inApp(
        { "package.json": "{}", "pyproject.toml": PYPROJECT, "uv.lock": "" },
        "kit_detect",
      );
      expect(code).toBe(0);
      expect(out).toBe(`KIT_LANG=bun\nKIT_PYTHON=3.14\nUV_PYTHON=3.14\nUV_PROJECT_ENVIRONMENT=${temp}/venv\n`);
    });

    test("in a Bun app with Python, [tool.project-kit.scripts] comes first, then package.json", async () => {
      const files = {
        "package.json": JSON.stringify({ scripts: { check: "echo bun-checked", lint: "echo bun-linted" } }),
        "pyproject.toml": PYPROJECT,
        "uv.lock": "",
      };
      const commands = `export KIT_LANG=bun KIT_PYTHON=3.14 APP_ENV=dev
        uv() { echo "uv $1 $2 $3"; shift 3; "$@"; }
        run_script check
        run_script lint
        run_script test:full`;
      const { code, out } = await inApp(files, commands);
      expect(code).toBe(0);
      expect(out).toContain("uv run --frozen --\nchecked dev\n");
      expect(out).not.toContain("bun-checked");
      expect(out).toContain("bun-linted");
      expect(out).toContain("::notice::No test:full script in package.json or [tool.project-kit.scripts] of pyproject.toml; skipped.");
    });

    test("scripts come from [tool.project-kit.scripts] and run through uv", async () => {
      // uv stands in for `uv run --frozen -- bash -c <command>`.
      const commands = `export KIT_LANG=python KIT_PYTHON=3.14 APP_ENV=dev
        uv() { echo "uv $1 $2 $3"; shift 3; "$@"; }
        has_script db:migrate:deploy && echo has-migrate
        run_script check
        run_script kit:pre-deploy`;
      const { code, out, err } = await inApp({ "pyproject.toml": PYPROJECT, "uv.lock": "" }, commands);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toContain("has-migrate\n");
      expect(out).toContain("uv run --frozen --\nchecked dev\n");
      expect(out).toContain("::notice::No kit:pre-deploy script in [tool.project-kit.scripts] of pyproject.toml; skipped.");
    });
  });
});
