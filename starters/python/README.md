# __APP_NAME__

Python functions on Vercel, managed with [uv](https://docs.astral.sh/uv/). Every file in `api/`
is a function at its path: `api/health.py` answers `GET /api/health`. `storage.py` gives an S3
client for the `s3` feature; with its variables unset, the rest works.

## Local development

```sh
uv sync
cp .env.example .env.local
uv run pytest
```

`uv run ruff format --check && uv run ruff check && uv run pytest` is the `check` the kit's
workflows run on every pull request and dev deploy (`[tool.project-kit.scripts]` in
`pyproject.toml`). `uv add <package>` adds a dependency and updates `uv.lock`; commit both.

To try the functions locally: `bunx vercel dev`. To use the dev deployment's variables:
`bunx vercel env pull .env.local --environment=preview --git-branch=dev`, then unset
`S3_ROLE_ARN` there (the role only trusts deployed functions) and sign in to AWS instead.

## Deploys

Pull requests get a preview deployment; `dev` deploys dev and the production branch deploys
production, through the project-kit workflows in `.github/workflows`. `public/` holds the
static files; without it Vercel would serve the project root.
