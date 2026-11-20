import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { copyStarter } from "./bootstrap";
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
