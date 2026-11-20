#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { apply, check, destroy, plan } from "./commands/apply";
import { control } from "./commands/control";
import { google } from "./commands/google";
import { init, login } from "./commands/init";
import { newProject } from "./commands/new";
import { setSecret } from "./commands/secret";
import { setSharedGoogleClient, setSharedSecret } from "./commands/shared";
import { projects, settings, showVersion } from "./commands/settings";
import { sync } from "./commands/sync";
import { KitError } from "./settings";
import { KIT_VERSION } from "./version";

const USAGE = `kit ${KIT_VERSION}: deployment setup for GitHub + Vercel + Neon + AWS (docs/contract.md)

  kit init                          once per machine: state bucket, tokens, AWS OIDC providers
  kit login <vercel|neon|cloudflare> [--app <name>]   --app: a deploy token for one app
  kit new <name>                    settings, repository, apply and workflows in one go
        [--repo owner/name] [--with neon|postgres,s3,google,cron,aws-deploy] [--security isolated]
        [--domain d] [--dev-domain d] [--production-branch b] [--deploy push|dispatch]
        [--generate A,B] [--supply NAME[:scope+scope],...] [--shared NAME,...]
        [--env scope:NAME=value ...] [--starter next|none] [--public] [--yes]
  kit shared google                 save the Google client standard apps share
  kit shared set <NAME>             save a secret standard apps share
  kit control <owner/repo> [--shared NAME,...]   set up the private control repository (standard projects only)
  kit list
  kit settings <name> [--edit | --history | --show <version id>]
  kit plan <name>
  kit apply <name>
  kit google <name>                 create the OAuth clients (after the first apply)
  kit secret set <name> <NAME> [--scope production|nonproduction|preview|dev]
  kit sync <name> [--ref <kit commit>] [--base <branch>]
  kit check <name>                  drift and leaked identifiers
  kit destroy <name>                take an app down; its database, buckets and repository stay`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      app: { type: "string" },
      starter: { type: "string" },
      security: { type: "string" },
      shared: { type: "string" },
      yes: { type: "boolean", short: "y" },
      with: { type: "string" },
      domain: { type: "string" },
      "dev-domain": { type: "string" },
      "production-branch": { type: "string" },
      deploy: { type: "string" },
      generate: { type: "string" },
      supply: { type: "string" },
      env: { type: "string", multiple: true },
      public: { type: "boolean" },
      edit: { type: "boolean" },
      history: { type: "boolean" },
      show: { type: "string" },
      scope: { type: "string" },
      ref: { type: "string" },
      base: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.yes) process.env.KIT_YES = "1";

  switch (values.help ? "help" : command) {
    case "init":
      return init();
    case "login":
      return login(rest[0], values.app);
    case "new":
      return newProject(rest[0], {
        repo: values.repo,
        with: values.with,
        security: values.security,
        shared: values.shared,
        yes: values.yes,
        starter: values.starter,
        domain: values.domain,
        devDomain: values["dev-domain"],
        productionBranch: values["production-branch"],
        deploy: values.deploy,
        generate: values.generate,
        supply: values.supply,
        env: values.env,
        public: values.public,
      });
    case "list":
      return projects();
    case "settings":
      if (values.show && rest[0]) return showVersion(rest[0], values.show);
      return settings(rest[0], { edit: values.edit, history: values.history });
    case "plan":
      return plan(rest[0]);
    case "apply":
      return apply(rest[0]);
    case "google":
      return google(rest[0]);
    case "secret":
      if (rest[0] !== "set") throw new KitError("Usage: kit secret set <name> <NAME> [--scope ...]");
      return setSecret(rest[1], rest[2], values.scope);
    case "sync":
      return sync(rest[0], { ref: values.ref, base: values.base });
    case "check":
      return check(rest[0]);
    case "control":
      return control(rest[0], { shared: values.shared });
    case "destroy":
      return destroy(rest[0]);
    case "shared":
      if (rest[0] === "google") return setSharedGoogleClient();
      if (rest[0] === "set") return setSharedSecret(rest[1]);
      throw new KitError("Usage: kit shared google | kit shared set <NAME>");
    case "help":
    case undefined:
      console.log(USAGE);
      return;
    default:
      throw new KitError(`Unknown command ${command}.\n\n${USAGE}`);
  }
}

main(Bun.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof KitError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
