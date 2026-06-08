import { NextRequest, NextResponse } from "next/server";
import { deleteTokens } from "@/lib/google-auth";

export async function POST(request: NextRequest) {
  await deleteTokens();
  return NextResponse.redirect(new URL("/connect", request.url));
}
