import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./exec";
import { describe as kindOf, findLeaks } from "./leaks";
import { tempDir } from "./store";

test("finds identifiers and repository variables without printing them", async () => {
  const dir = await tempDir();
  await run(["git", "init", "-q", dir]);
  await mkdir(join(dir, ".github", "workflows"), { recursive: true });
  await Bun.write(join(dir, "README.md"), "Deployed at app.example.com\n");
  await Bun.write(join(dir, ".github", "workflows", "x.yml"), "env:\n  A: ${{ vars.AWS_ROLE }}\n");
  await Bun.write(join(dir, "ok.ts"), "export const x = process.env.S3_BUCKET;\n");
  await run(["git", "-C", dir, "add", "-A"]);

  const leaks = await findLeaks(dir, ["app.example.com", "arn:aws:iam::123456789012:role/app"]);
  expect(leaks).toEqual([
    "README.md:1 contains identifier #1 (domain)",
    ".github/workflows/x.yml:2 reads a repository variable; use a secret",
  ]);
  expect(leaks.join("\n")).not.toContain("app.example.com");
});

test("names the kind of value", () => {
  expect(kindOf("arn:aws:iam::1:role/x")).toBe("AWS ARN");
  expect(kindOf("prj_123")).toBe("Vercel project id");
  expect(kindOf("dev.app.example.com")).toBe("domain");
});
