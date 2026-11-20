# __APP_NAME__

Next.js with Google sign-in (Auth.js), Postgres (Drizzle) and S3 uploads. Each part is optional: with its variables unset, the page says so and the rest works.

## Local development

```sh
bun install
docker compose up -d
cp .env.example .env.local
```

Fill in `.env.local` for the compose services:

```sh
DATABASE_URL=postgres://app:app@localhost:5432/app
DATABASE_URL_UNPOOLED=postgres://app:app@localhost:5432/app
S3_BUCKET=app
S3_REGION=us-east-1
S3_ENDPOINT=http://localhost:8333
S3_ACCESS_KEY_ID=local
S3_SECRET_ACCESS_KEY=localsecret
```

For sign-in, add `AUTH_SECRET` (`bunx auth secret`) and a Google OAuth client whose redirect URIs include `http://localhost:3000/api/auth/callback/google`. To use the dev deployment's resources instead: `bunx vercel env pull .env.local --environment=preview --git-branch=dev`.

```sh
bun run db:migrate:deploy
bun run dev
```

`bun run check` runs Biome, the type checker and the unit tests. `bun run format` fixes formatting.

## Database migrations

Edit `db/schema.ts`, then:

```sh
bun run db:generate --name <what-changed>
bun run db:migrate:deploy
```

Commit the generated files in `db/migrations`. Migrations run before the new code is live, so keep each one compatible with the version still serving: add columns as nullable or with a default, and drop them a release after the code stops reading them.

## Deployment

Deploys with [project-kit](https://github.com/Heknon/project-kit); see the [app contract](https://github.com/Heknon/project-kit/blob/main/docs/contract.md) for the environments and variables. `kit sync` adds the workflows.
