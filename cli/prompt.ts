import { KitError } from "./settings";

export function ask(question: string, fallback?: string): string {
  const answer = prompt(fallback ? `${question} [${fallback}]` : question)?.trim();
  if (answer) return answer;
  if (fallback !== undefined) return fallback;
  throw new KitError(`${question} is required.`);
}

export function confirm(question: string, fallback = false): boolean {
  const answer = prompt(`${question} ${fallback ? "[Y/n]" : "[y/N]"}`)?.trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

/** Reads a line without echoing it, for tokens and secrets. */
export async function askHidden(question: string): Promise<string> {
  process.stdout.write(`${question}: `);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    for await (const line of console) return line.trim();
    throw new KitError(`${question} is required.`);
  }
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  try {
    for await (const chunk of stdin) {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") throw new KitError("Cancelled.");
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    }
    return finish();
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }

  function finish(): string {
    process.stdout.write("\n");
    if (!value.trim()) throw new KitError(`${question} is required.`);
    return value.trim();
  }
}

/** Reads a whole value from stdin when it is piped (`kit secret set app KEY < key.pem`). */
export async function readPiped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const text = await Bun.stdin.text();
  return text.length > 0 ? text.replace(/\r?\n$/, "") : undefined;
}
