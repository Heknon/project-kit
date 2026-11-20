// Generates the root module for every fixture and runs `tofu validate` on it (no backend,
// no credentials), so a change to the generator or a module can't produce invalid HCL.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../cli/exec";
import { FIXTURES } from "../cli/fixtures";
import { rootModule } from "../cli/root";
import { KIT_DIR } from "../cli/tofu";

const tofu = process.env.TOFU ?? "tofu";
let failed = false;

for (const [name, settings] of Object.entries(FIXTURES)) {
  const dir = join(KIT_DIR, ".work", `fixture-${name}`);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "main.tf"), rootModule(settings, { bucket: "state", region: "eu-central-1" }));
  await run([tofu, `-chdir=${dir}`, "init", "-backend=false", "-input=false"]);
  const result = await run([tofu, `-chdir=${dir}`, "validate", "-no-color"], { allowFailure: true });
  console.log(`${name}: ${result.code === 0 ? "valid" : `invalid\n${result.stdout}${result.stderr}`}`);
  if (result.code !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
