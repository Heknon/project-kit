import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, env: env.APP_ENV ?? null }, { headers: { "Cache-Control": "no-store" } });
}
