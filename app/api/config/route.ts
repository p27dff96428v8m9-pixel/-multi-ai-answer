import { NextResponse } from "next/server";
import { usageLimits } from "@/lib/usage-limits";

export const runtime = "nodejs";
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json({
    builtIn: {
      gemini: Boolean(process.env.GEMINI_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      qwen: Boolean(process.env.OPENROUTER_API_KEY),
    },
    limits: usageLimits,
  });
}
