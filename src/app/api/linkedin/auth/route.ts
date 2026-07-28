import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  if (!clientId) return NextResponse.redirect(new URL("/?linkedin=setup-required", request.url));
  const origin = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
  const state = randomUUID();
  const redirectUri = `${origin}/api/linkedin/callback`;
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, scope: "openid profile email" }).toString();
  const response = NextResponse.redirect(url);
  response.cookies.set("chathelp_linkedin_state", state, { httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: "/", maxAge: 600 });
  return response;
}