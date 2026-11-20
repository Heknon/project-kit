import type { Settings } from "./settings";

export const KIT_REPOSITORY = "Heknon/project-kit";

/** The files `kit sync` keeps in an app repository; they carry behaviour, never values. */
export function appFiles(settings: Pick<Settings, "productionBranch" | "productionDeploy">, ref: string, version: string): Record<string, string> {
  const pushBranches = settings.productionDeploy === "push" ? `[dev, ${settings.productionBranch}]` : "[dev]";
  const productionNote =
    settings.productionDeploy === "push"
      ? `# Pushes to dev deploy dev; pushes to ${settings.productionBranch} deploy production.`
      : `# Pushes to dev deploy dev. Production deploys when Deploy is run by hand on ${settings.productionBranch}.`;

  return {
    ".github/workflows/preview.yml": `# Managed by project-kit (kit sync). docs: https://github.com/${KIT_REPOSITORY}/blob/main/docs/contract.md
name: Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed, labeled]
    paths-ignore: ["**/*.md", "docs/**"]

jobs:
  preview:
    # A called workflow can't have more than its caller, and a repository's default is read-only.
    permissions:
      contents: read
      pull-requests: write
    uses: ${KIT_REPOSITORY}/.github/workflows/preview.yml@${ref} # ${version}
    secrets: inherit
`,
    ".github/workflows/deploy.yml": `# Managed by project-kit (kit sync). docs: https://github.com/${KIT_REPOSITORY}/blob/main/docs/contract.md
${productionNote}
name: Deploy

on:
  push:
    branches: ${pushBranches}
    paths-ignore: ["**/*.md", "docs/**"]
  workflow_dispatch:

jobs:
  deploy:
    permissions:
      contents: read
      id-token: write
    uses: ${KIT_REPOSITORY}/.github/workflows/deploy.yml@${ref} # ${version}
    with:
      production-branch: ${settings.productionBranch}
    secrets: inherit
`,
    ".github/dependabot.yml": `# Managed by project-kit (kit sync): new kit releases arrive as pull requests.
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    groups:
      project-kit:
        patterns: ["${KIT_REPOSITORY}/*"]
`,
  };
}
