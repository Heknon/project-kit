/**
 * Variables an app repository declares for itself (docs/contract.md, "Variables the repository
 * declares"): the Deploy and Preview workflows put them on Vercel before they build. The
 * workflows run a copy of this file, so it imports nothing; cli/workflows.test.ts checks the
 * copies match, and `bun scripts/embed-repo-env.ts` refreshes them.
 */

/** Names the kit sets itself (docs/contract.md); a project's own values may not reuse them. */
export const CONTRACT_NAMES = new Set([
  "APP_ENV",
  "APP_URL",
  "CRON_SECRET",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "S3_BUCKET",
  "S3_REGION",
  "S3_PREFIX",
  "S3_ROLE_ARN",
  "AUTH_SECRET",
  "AUTH_URL",
  "AUTH_REDIRECT_PROXY_URL",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
]);

/** GitHub secrets the kit's workflows read: a declaration must not hand them to the app. */
const WORKFLOW_NAMES = new Set(["DEV_DOMAIN", "AWS_DEPLOY_ROLE_ARN", "AWS_REGION"]);
const WORKFLOW_PREFIXES = ["VERCEL_", "NEON_", "GITHUB_", "ACTIONS_", "RUNNER_"];

export const REPO_SCOPES = ["production", "dev", "preview"] as const;
export type RepoScope = (typeof REPO_SCOPES)[number];

export interface RepoVariable {
  name: string;
  scopes: RepoScope[];
  /** A random value, created once per scope when the variable is missing. */
  generate: boolean;
  /** false: the value may come from a GitHub Actions variable and is stored readable. */
  sensitive: boolean;
  /** A value from GitHub that may be missing; the variable is then left out. */
  optional: boolean;
}

export interface Declaration {
  /** Where it was declared, for messages. */
  source: string;
  variables: RepoVariable[];
}

/** A problem with the declaration or with Vercel, said in one line per problem. */
export class RepoEnvError extends Error {}

const KEYS = new Set(["scopes", "generate", "sensitive", "optional"]);
const PYPROJECT = "[tool.project-kit.env] of pyproject.toml";
const PACKAGE_JSON = '"project-kit".env of package.json';

/**
 * The declaration in an app's files: `[tool.project-kit.env]` of pyproject.toml, or
 * `"project-kit": { "env": … }` of package.json. Null when neither declares one.
 */
export function readDeclaration(files: { pyproject?: string | null; packageJson?: string | null }): Declaration | null {
  const found: { source: string; table: unknown }[] = [];
  if (files.pyproject) {
    let parsed: unknown;
    try {
      parsed = Bun.TOML.parse(files.pyproject);
    } catch (error) {
      throw new RepoEnvError(`pyproject.toml isn't valid TOML: ${(error as Error).message}`);
    }
    const table = field(field(field(parsed, "tool"), "project-kit"), "env");
    if (table !== undefined) found.push({ source: PYPROJECT, table });
  }
  if (files.packageJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(files.packageJson);
    } catch (error) {
      throw new RepoEnvError(`package.json isn't valid JSON: ${(error as Error).message}`);
    }
    const table = field(field(parsed, "project-kit"), "env");
    if (table !== undefined) found.push({ source: PACKAGE_JSON, table });
  }
  if (found.length > 1) throw new RepoEnvError(`Declare the variables in one place: ${PYPROJECT} or ${PACKAGE_JSON}, not both.`);
  const [one] = found;
  return one ? { source: one.source, variables: parseVariables(one.source, one.table) } : null;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseVariables(source: string, table: unknown): RepoVariable[] {
  if (!isTable(table)) throw new RepoEnvError(`${source} is a table of variable names.`);
  const problems: string[] = [];
  const variables: RepoVariable[] = [];
  for (const [name, entry] of Object.entries(table)) {
    const problem = (message: string) => problems.push(`${source}: ${name}: ${message}`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      problem("names are upper case letters, digits and underscores");
      continue;
    }
    if (CONTRACT_NAMES.has(name)) {
      problem("this name is set by the kit (docs/contract.md)");
      continue;
    }
    if (WORKFLOW_NAMES.has(name) || WORKFLOW_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      problem("this name is reserved for the kit's workflows; pick another");
      continue;
    }
    if (!isTable(entry)) {
      problem('give a table, for example { scopes = ["production"], generate = true }');
      continue;
    }
    const unknown = Object.keys(entry).filter((key) => !KEYS.has(key));
    if (unknown.length > 0) {
      problem(`unknown ${unknown.join(", ")}; the fields are ${[...KEYS].join(", ")}`);
      continue;
    }
    const { scopes, generate = false, sensitive = true, optional = false } = entry;
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => REPO_SCOPES.includes(s as RepoScope))) {
      problem(`scopes is a list of ${REPO_SCOPES.join(", ")}`);
      continue;
    }
    if (new Set(scopes).size !== scopes.length) {
      problem("scopes lists a scope twice");
      continue;
    }
    if (typeof generate !== "boolean" || typeof sensitive !== "boolean" || typeof optional !== "boolean") {
      problem("generate, sensitive and optional are true or false");
      continue;
    }
    if (generate && !sensitive) {
      problem("a generated value is always sensitive; drop sensitive = false");
      continue;
    }
    if (generate && optional) {
      problem("optional is for values from GitHub; a generated value is never missing");
      continue;
    }
    variables.push({ name, scopes: scopes as RepoScope[], generate, sensitive, optional });
  }
  if (problems.length > 0) throw new RepoEnvError(problems.join("\n"));
  return variables;
}

/** Where a scope's values live on Vercel. */
export function vercelTarget(scope: RepoScope): { target: "production" | "preview"; gitBranch?: string } {
  if (scope === "production") return { target: "production" };
  if (scope === "dev") return { target: "preview", gitBranch: "dev" };
  return { target: "preview" };
}

export interface ExistingEnv {
  key: string;
  target?: string[];
  gitBranch?: string | null;
}

export interface EnvWrite {
  key: string;
  value: string;
  type: "sensitive" | "encrypted";
  target: "production" | "preview";
  gitBranch?: string;
  /** Where the value came from, for the log. */
  from: string;
}

export interface Plan {
  writes: EnvWrite[];
  /** Lines for the log; never values. */
  notes: string[];
  errors: string[];
}

/** The names `rotate` lists: comma or space separated. */
export function parseRotate(input: string | undefined): string[] {
  return [...new Set((input ?? "").split(/[\s,]+/).filter(Boolean))];
}

/**
 * What one scope's run writes: generated values only when missing (or named in `rotate`), and
 * values from GitHub every time, so GitHub stays the source of truth.
 */
export function planScope(options: {
  declaration: Declaration;
  scope: RepoScope;
  existing: ExistingEnv[];
  secrets: Record<string, unknown>;
  vars: Record<string, unknown>;
  rotate: string[];
  random: () => string;
}): Plan {
  const { declaration, scope, existing, secrets, vars, rotate, random } = options;
  const plan: Plan = { writes: [], notes: [], errors: [] };
  const where = vercelTarget(scope);
  const present = (key: string) =>
    existing.some(
      (env) => env.key === key && env.target?.includes(where.target) && (where.gitBranch ? env.gitBranch === where.gitBranch : !env.gitBranch),
    );

  for (const name of rotate) {
    const variable = declaration.variables.find((v) => v.name === name);
    if (!variable?.generate) plan.errors.push(`rotate names ${name}, which ${declaration.source} doesn't declare with generate = true.`);
    else if (!variable.scopes.includes(scope)) plan.notes.push(`${name} isn't in the ${scope} scope; not rotated here.`);
  }

  for (const variable of declaration.variables.filter((v) => v.scopes.includes(scope))) {
    const { name } = variable;
    const base = { key: name, target: where.target, gitBranch: where.gitBranch };
    if (variable.generate) {
      if (rotate.includes(name)) plan.writes.push({ ...base, value: random(), type: "sensitive", from: "a new random value (rotate)" });
      else if (present(name)) plan.notes.push(`${name} (${scope}): kept.`);
      else plan.writes.push({ ...base, value: random(), type: "sensitive", from: "a new random value" });
      continue;
    }
    const secret = text(secrets[name]);
    const variableValue = variable.sensitive ? null : text(vars[name]);
    if (secret !== null) {
      plan.writes.push({ ...base, value: secret, type: variable.sensitive ? "sensitive" : "encrypted", from: "the GitHub secret" });
    } else if (variableValue !== null) {
      plan.writes.push({ ...base, value: variableValue, type: "encrypted", from: "the GitHub variable" });
    } else if (variable.optional) {
      plan.notes.push(`${name} (${scope}): no value in GitHub; left out.`);
    } else {
      const kinds = variable.sensitive ? "secret" : "secret or variable";
      plan.errors.push(`${name} has no value for ${scope}: add a GitHub ${kinds} ${name} to the ${scope} environment or the repository, or mark it optional = true.`);
    }
  }
  return plan;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 32 random bytes, hex. */
export function randomHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SyncOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;
  print: (line: string) => void;
  /** Errors and masks: stderr, so they still reach the runner when stdout goes to $GITHUB_OUTPUT. */
  printError: (line: string) => void;
  random?: () => string;
}

async function readFile(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
}

/**
 * The workflow step. `--check` prints `declared=true` (and `vars=true` when a value may come
 * from a GitHub variable) for $GITHUB_OUTPUT; otherwise it writes the scope APP_ENV names.
 * Returns the exit code.
 */
export async function syncRepoEnv(args: string[], options: SyncOptions): Promise<number> {
  const { env, print, printError } = options;
  const fail = (message: string) => {
    for (const line of message.split("\n")) printError(`::error::${line}`);
    return 1;
  };

  let declaration: Declaration | null;
  try {
    declaration = readDeclaration({
      pyproject: await readFile(`${options.cwd}/pyproject.toml`),
      packageJson: await readFile(`${options.cwd}/package.json`),
    });
  } catch (error) {
    if (error instanceof RepoEnvError) return fail(error.message);
    throw error;
  }

  if (args.includes("--check")) {
    if (declaration && declaration.variables.length > 0) {
      print("declared=true");
      if (declaration.variables.some((v) => !v.sensitive)) print("vars=true");
    }
    return 0;
  }
  if (!declaration || declaration.variables.length === 0) return 0;

  const scope = env.APP_ENV as RepoScope;
  if (!REPO_SCOPES.includes(scope)) return fail(`APP_ENV is ${scope ?? "unset"}; expected one of ${REPO_SCOPES.join(", ")}.`);
  const { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: projectId, VERCEL_ORG_ID: orgId } = env;
  if (!token || !projectId) return fail(`The ${scope} environment has no Vercel secrets. Run kit apply for this project.`);

  const query = orgId?.startsWith("team_") ? `teamId=${encodeURIComponent(orgId)}` : "";
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = `https://api.vercel.com${path}${query ? `${path.includes("?") ? "&" : "?"}${query}` : ""}`;
    const response = await options.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new RepoEnvError(`Vercel ${method} ${path.split("?")[0]} failed (${response.status}): ${detail.error?.message ?? response.statusText}`);
    }
    return response.json();
  };

  const project = `/v10/projects/${encodeURIComponent(projectId)}/env`;
  try {
    const { envs } = (await api("GET", project)) as { envs: ExistingEnv[] };
    const plan = planScope({
      declaration,
      scope,
      existing: envs,
      secrets: JSON.parse(env.KIT_SECRETS || "{}") as Record<string, unknown>,
      vars: JSON.parse(env.KIT_VARS || "{}") as Record<string, unknown>,
      rotate: parseRotate(env.KIT_ROTATE),
      random: options.random ?? randomHex,
    });
    for (const write of plan.writes) {
      if (write.from === "the GitHub variable") continue;
      for (const line of write.value.split(/\r?\n/)) if (line) printError(`::add-mask::${line}`);
    }
    if (plan.errors.length > 0) return fail(plan.errors.join("\n"));
    for (const note of plan.notes) print(note);
    for (const { key, value, type, target, gitBranch, from } of plan.writes) {
      await api("POST", `${project}?upsert=true`, { key, value, type, target: [target], gitBranch });
      print(`${key} (${scope}): set from ${from}.`);
    }
    return 0;
  } catch (error) {
    if (error instanceof RepoEnvError) return fail(error.message);
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = await syncRepoEnv(Bun.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  });
}
