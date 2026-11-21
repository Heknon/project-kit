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
`@vercel/oidc-aws-credentials-provider` (Python: [S3 from Python](#s3-from-python)). Locally,
fall back to the default AWS credential chain, or to `S3_ENDPOINT` + `S3_ACCESS_KEY_ID` +
`S3_SECRET_ACCESS_KEY` for MinIO. Objects under `preview/` expire after 14 days.

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

### Language and package manager

The workflows tell the two kinds of app apart by their files:

| App | Files | Install |
|---|---|---|
| Bun | `package.json` with `"packageManager": "bun@<version>"`, and a committed `bun.lock` | `bun install --frozen-lockfile` |
| Python | `pyproject.toml` and a committed `uv.lock`, no `package.json` ([Python apps](#python-apps)) | `uv sync --frozen` |

A `package.json` makes the app a Bun app even when it also has a `pyproject.toml`. A
`pyproject.toml` without `uv.lock` fails the run.

### Scripts

All optional; a missing script is skipped with a notice. A Bun app declares them in
`package.json` `scripts`; a Python app in `[tool.project-kit.scripts]` of `pyproject.toml`.

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
deploys, Vercel's Git integration does not. The project stays connected to the repository,
because Vercel only accepts branch-scoped variables on a connected project.

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
    permissions:
      contents: read
      pull-requests: write
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
    permissions:
      contents: read
      id-token: write
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

## Python apps

A Python app is Vercel Python functions (every `.py` file in `api/` is a function at its
path, exposing `handler`, a `BaseHTTPRequestHandler` subclass, or `app`, an ASGI/WSGI
application), or a Python framework Vercel detects (FastAPI, Flask, Django). `kit new
--starter python` starts one (`starters/python`).

### What it provides

- `pyproject.toml` with `[project] requires-python` (for example `">=3.14"`), and a committed
  `uv.lock` (`uv lock`). Vercel runs Python 3.12, 3.13 and 3.14.
- Optionally `.python-version` (`uv python pin 3.14`). The workflows use its version, else the
  lowest version `requires-python` allows; Vercel reads the same files. Below 3.12 fails the run.
- Optionally `[tool.uv] required-version` to pin uv; otherwise the workflows use the latest.
- Scripts, as shell commands:

  ```toml
  [tool.project-kit.scripts]
  check = "scripts/check.sh"              # or "ruff check && pytest"
  "test:full" = "pytest -m slow"
  "db:migrate:deploy" = "alembic upgrade head"
  ```

  The names, and when each runs, are the ones in [Scripts](#scripts). Each runs from the
  repository root as `uv run --frozen -- bash -c "<command>"`, so the project's dependencies,
  dev group included, are on `PATH` and `python` is the project's interpreter.
- `vercel.json` with `"git": { "deploymentEnabled": false }`, as every app.
- A `public/` directory for static files, even if it holds only `robots.txt`: without one,
  Vercel serves the repository root as static files (`pyproject.toml`, source, tests).
- `.vercelignore` for what a function must not bundle (tests, data); Vercel bundles every file
  a Python function can reach and does no tree-shaking.

### What the workflows do with it

The same steps as a Bun app, with Python set up instead: Python from `actions/setup-python`,
uv from `astral-sh/setup-uv`, `uv sync --frozen` into an environment outside the checkout.
Bun is set up too, only to run the Vercel and Neon CLIs. `vercel build` then builds the
functions on the runner the way Vercel would (its Python builder installs the dependencies
from `pyproject.toml` and `uv.lock`), and `vercel deploy --prebuilt` uploads the result.

The Vercel project needs no framework, build or install command: the kit sets none, and
Vercel detects the Python functions or framework.

### S3 from Python

There are no access keys. The function exchanges its Vercel OIDC token for the role in
`S3_ROLE_ARN`. In a deployed function the token is the `x-vercel-oidc-token` request header
(it rotates; read it on every request); in builds and in a `.env.local` from
`vercel env pull` it is `VERCEL_OIDC_TOKEN`.

```python
import os
import boto3

def s3_client(headers):  # the request's headers, e.g. BaseHTTPRequestHandler.headers
    region = os.environ["S3_REGION"]
    token = headers.get("x-vercel-oidc-token") or os.environ.get("VERCEL_OIDC_TOKEN")
    credentials = boto3.client("sts", region_name=region).assume_role_with_web_identity(
        RoleArn=os.environ["S3_ROLE_ARN"],
        RoleSessionName=os.environ.get("VERCEL_DEPLOYMENT_ID", "app"),
        WebIdentityToken=token,
    )["Credentials"]
    return boto3.client(
        "s3",
        region_name=region,
        aws_access_key_id=credentials["AccessKeyId"],
        aws_secret_access_key=credentials["SecretAccessKey"],
        aws_session_token=credentials["SessionToken"],
    )
```

- Use `S3_REGION` for both the STS and the S3 client: the bucket lives there, and a regional
  STS endpoint avoids the global one.
- Prefix every key with `S3_PREFIX` (`os.environ.get("S3_PREFIX", "")`): empty in production,
  `dev/` in dev, `preview/pr-<n>/` in previews. Previews and dev share the dev bucket, and the
  role lets them write anywhere in it, so the prefix is what keeps them apart.
- The credentials last up to an hour (`credentials["Expiration"]`); a warm function may reuse
  the client until then.
- The role trusts only deployed functions (Production, and Preview for dev and previews), so a
  token from `vercel env pull` (the Development environment) is refused. Locally, leave
  `S3_ROLE_ARN` unset and use the default AWS credential chain (`boto3.client("s3")`), or
  `S3_ENDPOINT` with `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` for MinIO.

`starters/python/storage.py` does all of this.

## What public repositories never contain

The workflows read only `secrets.*`, never `vars.*` (variables are printed in logs). On a
public repository they also don't comment preview URLs or set environment URLs, and they
mask the Vercel team slug, so logs show nothing that identifies the project's accounts.
