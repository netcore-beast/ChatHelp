import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { sealProfile } from "@/lib/linkedinSession";

export async function GET(request: NextRequest) {
  const origin = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("chathelp_linkedin_state")?.value;
  if (!clientId || !clientSecret || !sessionSecret || !code || !state || state !== expectedState) return NextResponse.redirect(new URL("/?linkedin=failed", request.url));
  try {
    const redirectUri = `${origin}/api/linkedin/callback`;
    const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }), cache: "no-store" });
    if (!tokenResponse.ok) throw new Error("Token exchange failed");
    const token = await tokenResponse.json() as { access_token: string };
    const profileResponse = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` }, cache: "no-store" });
    if (!profileResponse.ok) throw new Error("Profile request failed");
    const profile = await profileResponse.json() as { sub: string; name?: string; email?: string; picture?: string };
    const response = NextResponse.redirect(new URL("/?linkedin=connected", request.url));
    response.cookies.set("chathelp_linkedin", sealProfile({ ...profile, exp: Date.now() + 8 * 60 * 60 * 1000 }, sessionSecret), { httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: "/", maxAge: 8 * 60 * 60 });
    response.cookies.delete("chathelp_linkedin_state");
    return response;
  } catch { return NextResponse.redirect(new URL("/?linkedin=failed", request.url)); }
}