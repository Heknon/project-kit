import type { NextRequest } from "next/server";
import { authEnabled, handlers } from "@/auth";

const notFound = () => new Response(null, { status: 404 });

export function GET(request: NextRequest) {
  return authEnabled ? handlers.GET(request) : notFound();
}

export function POST(request: NextRequest) {
  return authEnabled ? handlers.POST(request) : notFound();
}
