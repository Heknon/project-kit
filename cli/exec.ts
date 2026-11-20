import { KitError } from "./settings";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** Show the command's output live (tofu plans, prompts) instead of capturing it. */
  inherit?: boolean;
  /** Return the result instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(command: string[], options: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.inherit ? "inherit" : options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
  });
  const [stdout, stderr] = options.inherit
    ? ["", ""]
    : await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  const code = await proc.exited;
  if (code !== 0 && !options.allowFailure) {
    const detail = stderr.trim().split("\n").slice(-5).join("\n");
    throw new KitError(`${command[0]} ${command[1] ?? ""} failed (exit ${code})${detail ? `:\n${detail}` : ""}`);
  }
  return { code, stdout, stderr };
}

export async function json<T>(command: string[], options: RunOptions = {}): Promise<T> {
  const { stdout } = await run(command, options);
  return JSON.parse(stdout) as T;
}

export async function which(binary: string): Promise<boolean> {
  return Bun.which(binary) !== null;
}
