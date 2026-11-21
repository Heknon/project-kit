import { expect, test } from "bun:test";
import { appFiles } from "./templates";

const ref = "0123456789abcdef0123456789abcdef01234567";

test("production on push or by hand", () => {
  const push = appFiles({ productionBranch: "main", productionDeploy: "push" }, ref, "v1.0.0");
  const dispatch = appFiles({ productionBranch: "master", productionDeploy: "dispatch" }, ref, "v1.0.0");
  expect(push[".github/workflows/deploy.yml"]).toContain("branches: [dev, main]");
  expect(dispatch[".github/workflows/deploy.yml"]).toContain("branches: [dev]");
  expect(dispatch[".github/workflows/deploy.yml"]).toContain("production-branch: master");
});

test("pinned to a commit, values-free", () => {
  for (const content of Object.values(appFiles({ productionBranch: "main", productionDeploy: "push" }, ref, "v1.0.0"))) {
    expect(content).not.toMatch(/vars\./);
  }
  expect(appFiles({ productionBranch: "main", productionDeploy: "push" }, ref, "v1.0.0")[".github/workflows/preview.yml"]).toContain(
    `preview.yml@${ref} # v1.0.0`,
  );
});

test("callers grant what the kit's workflows ask for", () => {
  const files = appFiles({ productionBranch: "main", productionDeploy: "push" }, ref, "v1.0.0");
  expect(files[".github/workflows/preview.yml"]).toContain("pull-requests: write");
  expect(files[".github/workflows/deploy.yml"]).toContain("id-token: write");
});

test("Deploy can be run by hand with names to rotate", () => {
  const deploy = appFiles({ productionBranch: "main", productionDeploy: "push" }, ref, "v1.0.0")[".github/workflows/deploy.yml"];
  expect(deploy).toContain("  workflow_dispatch:\n    inputs:\n      rotate:");
  expect(deploy).toContain("      rotate: ${{ inputs.rotate }}\n");
});
