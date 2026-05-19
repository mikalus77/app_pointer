import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      nowMs: Date.now(),
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      },
    }
  );
}
