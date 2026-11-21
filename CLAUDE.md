# project-kit

Setup and deployment for apps on GitHub + Vercel + Neon + AWS: reusable workflows, OpenTofu
modules, and the `kit` CLI. Read `README.md` for what it does and `docs/contract.md` for what
an app receives and provides.

## Standard and isolated projects

Every project is one of two tiers, and the difference is only which credentials it shares:

- **standard** (default, the "for fun" apps): signs in with the shared Google client, may use
  shared secrets, deploys with the shared Vercel token, and can be created and managed from
  the control repository (`Heknon/kit-control`), so from Claude on a phone too.
- **isolated** (apps that hold real data, like emoto-management): its own Google clients, its
  own Vercel token, no shared secrets, state under `isolated/` in the state bucket. Managed
  only from the owner's machine. The control repository's AWS role can't read `isolated/`,
  and remote mode (`KIT_REMOTE=1`) refuses isolated projects.

When you create or change a project for someone:

- Use the control repository (or `kit new` locally) only for standard projects.
- Never create, apply, sync or destroy an isolated project from the control repository, and
  never move a project from isolated to standard without being asked in so many words.
- If you can't tell which tier a request is for, ask. Anything with customers, payments or
  personal data is isolated.

## Commands

```sh
bun install
bun run check                      # tsc + unit tests
bun scripts/validate-roots.ts      # generated root modules pass `tofu validate`
tofu -chdir=modules/platform test  # module tests with mock providers (also modules/s3)
tofu fmt -recursive modules stacks
```

## Layout

- `.github/workflows/preview.yml`, `deploy.yml`: the reusable workflows app repositories call.
  `kit-ci.yml` is the kit's own CI.
- `modules/`: `platform` (Vercel, GitHub), `neon`, `s3`, `aws-deploy`, `dns-cloudflare`.
- `stacks/account`: once per AWS account: OIDC providers, the app permissions boundary, the
  control role.
- `cli/`: the `kit` command. `root.ts` generates each project's root module; `settings.ts` is
  the settings schema; `mode.ts` is remote mode.
- `starters/`: app code `kit new` puts in a blank repository.

## Rules

- The kit is the same for every project. When an app needs something different, change the
  app, or make the kit more generic; never add a per-project special case.
- Nothing that identifies an account goes into this repository or into an app repository:
  no domains, ids, ARNs, bucket names, deployment URLs or secrets. Workflows read
  `secrets.*`, never `vars.*` by name; only the step that writes repository-declared
  variables reads `toJSON(vars)`, and only when one is `sensitive = false`.
- `cli/repo-env.ts` runs inside the workflows as an embedded copy: it imports nothing, and
  after changing it run `bun scripts/embed-repo-env.ts`.
- Data is never deleted by the kit: `kit destroy` keeps the production database, buckets and
  repository.
- Roles the kit creates for standard projects carry the `project-kit-app-boundary`
  permissions boundary; keep it that way.
- Errors say what happened and what to do next, in one line. No filler words, no comments
  restating code, no TODO stubs.
- Branches: `feature/…`, `bugfix/…`, `refactor/…`, `docs/…`. Every change goes through a pull
  request into `main`.
