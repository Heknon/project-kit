# project-kit

One setup for every app: GitHub Actions that deploy to Vercel cheaply, a database branch per
pull request on Neon, S3 through Vercel's OIDC (no access keys), Google sign-in that works on
preview deployments, and every value kept in GitHub environment secrets and Vercel
environment variables. Nothing that identifies your accounts is committed anywhere, so app
repositories can be public.

The kit is the same for every project. Apps fit it, not the other way round:
[docs/contract.md](docs/contract.md) says what an app receives and what it provides.

```
feature/* ──PR──▶ preview     database branch preview/pr-<n> → migrate → Vercel preview → check
   │                          (closing the pull request deletes the branch)
   ▼ merge
  dev  ──────────▶ dev         check → migrate → Vercel; the dev domain follows the dev branch
   │
   ▼ merge
 main  ──────────▶ production  test:full → migrate → Vercel --prod   (on push, or by hand)
```

## What it is

| Part | |
|---|---|
| `.github/workflows/preview.yml`, `deploy.yml` | Reusable workflows. An app repository calls them from two short files that `kit sync` writes, pinned to a kit commit; Dependabot proposes kit updates. |
| `modules/` | OpenTofu modules: `platform` (Vercel project, domains, env vars, GitHub environments, secrets, branch rules), `neon`, `s3`, `aws-deploy`, `dns-cloudflare`. |
| `stacks/account` | Once per AWS account: the GitHub and Vercel OIDC providers. |
| `cli/` | The `kit` command: settings, Google OAuth clients, supplied secrets, plan, apply, sync, leak check. |

## Where things live

| What | Where |
|---|---|
| Values apps and workflows use | GitHub environment secrets and Vercel environment variables, written by `kit apply` |
| Secrets you supply (Google client secrets, API keys) | Written once to Vercel by `kit google` / `kit secret set`; the kit keeps no copy |
| Secrets the kit generates (`AUTH_SECRET`, `CRON_SECRET`, …) and database passwords | OpenTofu state |
| Project settings and state | A private, versioned S3 bucket in your AWS account (`projects/<name>/`) |
| Your Vercel, Neon and Cloudflare tokens | The OS keychain; GitHub access comes from `gh auth` |

## Costs

- **GitHub Actions:** free on public repositories. Each workflow is one job (GitHub bills every
  job rounded up to a minute), docs-only changes run nothing, superseded preview runs are
  cancelled, and full tests run only before production or with the `full-tests` label.
- **Vercel:** builds run in Actions and deploy with `--prebuilt`, so Vercel never builds.
- **Neon:** preview branches are deleted when the pull request closes; the restore window
  defaults to six hours, which fits the free plan.
- **AWS:** two buckets and IAM roles per project, the state bucket, no KMS keys and no
  Secrets Manager. Preview objects expire after 14 days.

## Setup

Needs [Bun](https://bun.sh), [OpenTofu](https://opentofu.org/docs/intro/install/) 1.10+,
the AWS CLI signed in to your account, and the GitHub CLI (`gh auth login`).

```sh
git clone https://github.com/Heknon/project-kit && cd project-kit
bun install && bun link          # puts `kit` on your PATH
kit init                         # once: state bucket, tokens, AWS OIDC providers
```

`kit init` also asks for your defaults (Vercel team, Neon organization, the features a new
app gets) and for the shared Google OAuth client, which standard apps sign in with. Its
secret goes to the OS keychain.

## An app

```sh
kit new myapp
```

That one command saves the settings (from your defaults), creates the repository if it
doesn't exist, and applies (Vercel project and domains, Neon with a dev branch, S3 buckets
and roles, GitHub environments and secrets, generated secrets, the shared Google client).
A blank repository then gets the starter (`starters/next`: Next.js, Auth.js, Drizzle,
Tailwind, Bun) and the caller workflows as its first commit on the production branch and on
`dev`, so both deploy at once. A repository with code gets a pull request with the workflows
instead (`--starter none` skips the starter). The only step left to you is the one Google
won't let a program do: adding the app's redirect URIs to the shared client. `kit apply`
checks them with Google, and when any are missing it opens the client's page with them on
your clipboard.

An existing repository works the same way (`kit new name --repo owner/repo`): the kit adopts
the Vercel project, its domains, GitHub environments and the `dev` branch instead of
recreating them, refuses to start while a Marketplace integration still owns variables the
kit sets, and deletes plain variables the kit replaces after asking. The Vercel project stays
connected to the repository (Vercel's GitHub app needs access to it): branch-scoped variables
need the connection, and `git.deploymentEnabled: false` in the app's `vercel.json` keeps
Vercel from deploying pushes itself.

### Security tiers

| | `standard` (default) | `isolated` (`--security isolated`) |
|---|---|---|
| Google sign-in | the shared client | its own production and non-production clients (`kit google`, guided) |
| Supplied secrets | may use shared ones (`kit shared set NAME`, `--shared NAME`) | its own only |
| Vercel deploy token (GitHub secret) | the one from `kit init` | its own (`kit login vercel --app NAME`; `kit new` asks) |

A Vercel token can be limited to a team, not to a project: an isolated app's own token can
be revoked on its own, but another app's token in the same team can still reach it. Put an
app that must be out of reach in its own Vercel team.

Everything else is per app in both tiers: database, buckets, IAM roles, `AUTH_SECRET`
(production separate from dev and previews), generated secrets. Production deploys on merge
to the production branch in both, unless `--deploy dispatch`.

### From anywhere: the control repository (standard projects only)

```sh
kit control you/kit-control      # once, from your machine; the repository must be private
```

That gives a private repository (`kit-control`) an AWS role and an `apps` environment holding
what your keychain holds. Its workflows (New app, Apply, Destroy) run the same commands, so
Claude on your phone, or any session that can start a GitHub workflow, can create and manage
**standard** projects. The role can only reach standard projects' state (`projects/` in the
state bucket), `kit-*` buckets, and roles under `/project-kit/` that carry the app permissions
boundary. Isolated projects are refused there and stay on your machine: their state sits
under `isolated/`, which the role can't read.

### Taking an app down

`kit destroy myapp` removes the Vercel project, GitHub environments and secrets, IAM roles,
the preview database key, DNS records, and every database branch except production's.
Production data stays: the Neon project with its main branch, both buckets (private and
encrypted, as before) and the repository.

Afterwards:

| Task | Command |
|---|---|
| See or change settings | `kit settings myapp` / `kit settings myapp --edit` (or `--set domains.production=…`), then `kit apply myapp` |
| History of the settings | `kit settings myapp --history`, `kit settings myapp --show <version>` |
| What would change | `kit plan myapp` |
| Drift and leaked identifiers | `kit check myapp` |
| Rotate a supplied secret | `kit secret set myapp NAME` |
| Move an app to a newer kit | merge Dependabot's pull request, or `kit sync myapp` |

## Settings

`kit settings <name>` prints them. The fields, with defaults:

| Field | |
|---|---|
| `security` | `standard` or `isolated` (see above) |
| `repository`, `productionBranch` (`main`), `productionDeploy` (`push` or `dispatch`) | `dispatch`: production deploys only when Deploy is run by hand |
| `protectBranches` | a ruleset that stops deleting or force-pushing the production and `dev` branches; `kit new` turns it on for public repositories only, because GitHub's free plan refuses rulesets on private ones |
| `domains.production`, `domains.dev` | default `<name>.vercel.app` and `<name>-dev.vercel.app`; `dns.provider: "cloudflare"` with a `zoneId` adds the records |
| `database.kind` | `none`, `neon` (kit-managed, a branch per pull request) or `postgres` (you supply `DATABASE_URL` and `DATABASE_URL_UNPOOLED`; previews share the non-production database) |
| `storage.kind` | `none` or `s3`; `existingBuckets` adopts buckets you have |
| `google` | Google sign-in; `kit google` fills in the client ids |
| `cron` | `CRON_SECRET` in production |
| `generated`, `supplied`, `env` | the project's own variables: random secrets, secrets you set, plain values per scope |
| `awsDeploy` | a GitHub OIDC role for `kit:deploy-aws` (CDK and the like) |

## Developing the kit

```sh
bun run check                    # typecheck and unit tests
bun scripts/validate-roots.ts    # generated root modules are valid OpenTofu
tofu -chdir=modules/platform test
```
