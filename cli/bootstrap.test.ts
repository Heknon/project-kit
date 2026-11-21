import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { copyStarter, starterExists } from "./bootstrap";
import { tempDir } from "./store";

test("copies the starter with the app's name, without build output", async () => {
  const from = await tempDir();
  const to = await tempDir();
  await mkdir(join(from, "node_modules", "x"), { recursive: true });
  await mkdir(join(from, "app"), { recursive: true });
  await Bun.write(join(from, "package.json"), '{ "name": "__APP_NAME__" }\n');
  await Bun.write(join(from, "app", "page.tsx"), "<title>__APP_NAME__</title>\n");
  await Bun.write(join(from, "node_modules", "x", "index.js"), "");

  await copyStarter(from, to, "fun-app");

  expect(await Bun.file(join(to, "package.json")).text()).toBe('{ "name": "fun-app" }\n');
  expect(await Bun.file(join(to, "app", "page.tsx")).text()).toBe("<title>fun-app</title>\n");
  expect(await Bun.file(join(to, "node_modules", "x", "index.js")).exists()).toBe(false);
});

test("Bun and Python starters exist; other names don't", async () => {
  expect(await starterExists("next")).toBe(true);
  expect(await starterExists("python")).toBe(true);
  expect(await starterExists("none")).toBe(false);
  expect(await starterExists("../cli")).toBe(false);
});

test("a Python starter is copied without its environment and caches", async () => {
  const from = await tempDir();
  const to = await tempDir();
  for (const dir of [".venv/lib", "api/__pycache__", ".pytest_cache", ".ruff_cache"]) await mkdir(join(from, dir), { recursive: true });
  await Bun.write(join(from, "pyproject.toml"), 'description = "__APP_NAME__"\n');
  await Bun.write(join(from, "api", "health.py"), "");
  await Bun.write(join(from, "api", "__pycache__", "health.cpython-314.pyc"), "");
  await Bun.write(join(from, ".venv", "lib", "x.py"), "");

  await copyStarter(from, to, "fun-bot");

  expect(await Bun.file(join(to, "pyproject.toml")).text()).toBe('description = "fun-bot"\n');
  expect(await Bun.file(join(to, "api", "health.py")).exists()).toBe(true);
  for (const path of [".venv/lib/x.py", "api/__pycache__/health.cpython-314.pyc"]) expect(await Bun.file(join(to, path)).exists()).toBe(false);
});
