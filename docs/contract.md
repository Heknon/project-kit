# The app contract

What a project receives from the kit, and what it provides in return. An app that follows
this contract deploys with the kit's workflows and needs no other setup.

Nothing project-specific is ever committed to the app repository: no domains, ids, ARNs,
bucket names or URLs. Values reach the app as Vercel environment variables and reach the
workflows as GitHub environment secrets, both written by `kit apply`.

## Environments

| Environment | Git | Vercel scope | GitHub environment | `APP_ENV` |
|---|---|---|---|---|
| Production | the production branch (`main` or `master`) | Production | `production` | `production` |
| Dev | `dev` | Preview, branch `dev` (a stable dev domain follows it) | `dev` | `dev` |
| Preview | every pull request | Preview | `preview` | `preview` |
| Local | your machine | `vercel env pull` of the dev scope, or `.env` | — | unset |

Previews and dev share non-production resources (database parent branch, dev bucket,
non-production OAuth client and auth secret). Production shares nothing with them.

## Environment variables the app receives

The names are fixed: the kit is the same for every project, and apps read these names.
An app that reads other names (for example a Marketplace integration's `STORAGE_*` or
`POSTGRES_URL`) is changed to read these.

### Always

| Variable | Value |
|---|---|
| `APP_ENV` | `production`, `dev` or `preview` |
| `APP_URL` | the deployment's public origin (`https://…`, no trailing slash): the production domain in production, the dev domain in dev. Unset in previews: use `https://${VERCEL_BRANCH_URL ?? VERCEL_URL}` there |
| `CRON_SECRET` | production only; Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>` |

### Database (`neon` or `postgres`)

| Variable | Value |
|---|---|
| `DATABASE_URL` | the connection the app uses (pooled when the database has a pooler) |
| `DATABASE_URL_UNPOOLED` | a direct connection, for migrations and session-level features |

Production gets the main database, dev gets the dev branch, and each preview gets its own
database branch (`preview/pr-<n>`, copied from dev) set at deploy time. Closing the pull
request deletes it.

### Storage (`s3`)

| Variable | Value |
|---|---|
| `S3_BUCKET` | production bucket in Production; the dev bucket in dev and previews |
| `S3_REGION` | the bucket's region |
| `S3_PREFIX` | unset in production (read it as `""`), `dev/` in dev, `preview/pr-<n>/` in previews; prefix every key with it |
| `S3_ROLE_ARN` | the IAM role the function assumes with its Vercel OIDC token |

No access keys exist. On Vercel, get credentials with
`awsCredentialsProvider({ roleArn: process.env.S3_ROLE_ARN })` from
`@vercel/oidc-aws-credentials-provider`. Locally, fall back to the default AWS credential
chain, or to `S3_ENDPOINT` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` for MinIO.
Objects under `preview/` expire after 14 days.

Browser uploads use presigned URLs; the bucket's CORS allows the production domain, the dev
domain, `*.vercel.app` previews of the project's team and `http://localhost:*`.

### Google sign-in (`google`)

Auth.js (`next-auth` v5 for Next.js, `@auth/core` for anything else), mounted at `/api/auth`.

| Variable | Production | Dev | Previews |
|---|---|---|---|
| `AUTH_SECRET` | production secret | non-production secret | the **same** non-production secret |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | production OAuth client | non-production client | non-production client |
| `AUTH_URL` | production origin | dev origin | **unset** |
| `AUTH_REDIRECT_PROXY_URL` | unset | `https://<dev domain>/api/auth` | `https://<dev domain>/api/auth` |

Google refuses wildcard redirect URIs, so previews sign in through the dev deployment: they
send the Google callback to `AUTH_REDIRECT_PROXY_URL`, the dev deployment (whose proxy URL is
itself) completes it and returns the user to the preview. This only works because dev and
previews share `AUTH_SECRET`. The app must:

- pass `redirectProxyUrl: process.env.AUTH_REDIRECT_PROXY_URL` and `trustHost: true`;
- not set `AUTH_URL` itself on previews;
- accept only verified Google emails.

An app with its own sign-in instead of Auth.js keeps the same outside behaviour: the Google
callback is `/api/auth/callback/google` on the app's origin, and with
`AUTH_REDIRECT_PROXY_URL` set it sends Google to `<AUTH_REDIRECT_PROXY_URL>/callback/google`
instead, carrying the deployment's own origin in a `state` signed with `AUTH_SECRET`. The
deployment whose `AUTH_URL` origin matches the proxy URL verifies the state and redirects to
that origin's callback with the query unchanged; the code is exchanged there with the proxy's
redirect URI. Only origins on `*.vercel.app` of the project's team, the dev domain and
localhost are accepted as return origins.

The Google OAuth client can be shared by several projects. Its redirect URIs are then the
production and dev callbacks of each project, plus the localhost ones.

### Generated and supplied secrets

The project settings list extra names:

- **generated** (for example `COOKIE_SECRET`, `AUTH_SIGNING_KEY`): random values, separate for
  production and non-production;
- **supplied** (for example `SMTP_URL`, `GOOGLE_MAPS_SERVER_KEY`): set once with
  `kit secret set <project> <NAME>`; the kit writes them to Vercel and keeps no copy;
- **plain** values per environment (for example `VITE_RUNTIME=server`).

## What the app provides

### Package manager

Bun, declared in `package.json` (`"packageManager": "bun@<version>"`) with a committed
`bun.lock`. The workflows install with `bun install --frozen-lockfile`.

### Scripts

All optional; a missing script is skipped with a notice.

| Script | When it runs | Environment |
|---|---|---|
| `check` | every preview and every dev deploy, after the deploy step on previews | no database, no secrets |
| `db:migrate:deploy` | before every deploy | `DATABASE_URL` and `DATABASE_URL_UNPOOLED` of the target |
| `test:full` | once before each production deploy, and on a pull request labelled `full-tests` | no secrets |
| `kit:pre-deploy` | after migrations, before the app deploy | database URLs, `APP_ENV` |
| `kit:deploy-aws` | dev and production, with the GitHub OIDC deploy role assumed | `APP_ENV`, `AWS_REGION` |
| `kit:post-deploy` | after the app deploy | `APP_ENV`, `DEPLOY_URL` |

Migrations must be backward compatible with the version still serving: they run before the
new code is live.

### Build

The Vercel project's build: `vercel.json` (`buildCommand`, Build Output API, or framework
detection). The workflows run `vercel build` and deploy the result with `--prebuilt`, so
nothing builds twice. Add `"git": { "deploymentEnabled": false }` to `vercel.json`: the kit
deploys, Vercel's Git integration does not.

### Workflows

Two caller files, identical in every project apart from the input:

```yaml
# .github/workflows/preview.yml
name: Preview
on:
  pull_request:
    types: [opened, synchronize, reopened, closed, labeled]
    paths-ignore: ["**/*.md", "docs/**"]
jobs:
  preview:
    uses: Heknon/project-kit/.github/workflows/preview.yml@<sha>
    secrets: inherit
```

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [dev]          # add the production branch for "deploy production on push"
    paths-ignore: ["**/*.md", "docs/**"]
  workflow_dispatch:
jobs:
  deploy:
    uses: Heknon/project-kit/.github/workflows/deploy.yml@<sha>
    with:
      production-branch: main
    secrets: inherit
```

Full tests (`test:full`) run inside them: before each production deploy, and on pull
requests labelled `full-tests`.

Inputs (all optional):

| Input | Default | |
|---|---|---|
| `production-branch` | `main` | the branch that deploys to production |

### Local development

`.env.example` lists every variable with a comment, no values. To work against the dev
resources: `bunx vercel env pull .env.local --environment=preview --git-branch=dev`.

## What public repositories never contain

The workflows read only `secrets.*`, never `vars.*` (variables are printed in logs). On a
public repository they also don't comment preview URLs or set environment URLs, and they
mask the Vercel team slug, so logs show nothing that identifies the project's accounts.
