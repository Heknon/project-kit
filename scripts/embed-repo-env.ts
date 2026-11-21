// Copies cli/repo-env.ts into the Repository variables step of preview.yml and deploy.yml:
// a called workflow runs in the app's checkout and has no copy of the kit.
import { join } from "node:path";
import { KIT_DIR } from "../cli/tofu";

export const EMBED = /( *)cat > "\$RUNNER_TEMP\/repo-env\.ts" <<'TS'\n(?:[\s\S]*?\n)? *TS\n/;

export function embed(workflow: string, source: string): string {
  return workflow.replace(EMBED, (_match, indent: string) => {
    const body = source
      .trimEnd()
      .split("\n")
      .map((line) => (line ? `${indent}${line}` : ""))
      .join("\n");
    return `${indent}cat > "$RUNNER_TEMP/repo-env.ts" <<'TS'\n${body}\n${indent}TS\n`;
  });
}

if (import.meta.main) {
  const source = await Bun.file(join(KIT_DIR, "cli", "repo-env.ts")).text();
  if (source.includes("${{") || /^TS$/m.test(source)) throw new Error("cli/repo-env.ts can't contain ${{ or a line TS: the workflows embed it.");
  for (const file of ["preview.yml", "deploy.yml"]) {
    const path = join(KIT_DIR, ".github", "workflows", file);
    const text = await Bun.file(path).text();
    if (!EMBED.test(text)) throw new Error(`${file} has no Repository variables step to fill.`);
    await Bun.write(path, embed(text, source));
    console.log(`${file}: embedded cli/repo-env.ts`);
  }
}
