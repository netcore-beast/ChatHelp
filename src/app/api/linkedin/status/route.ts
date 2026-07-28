import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { openProfile } from "@/lib/linkedinSession";

export async function GET() {
  const configured = Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET && process.env.SESSION_SECRET);
  if (!configured) return NextResponse.json({ configured: false, connected: false });
  const cookieStore = await cookies();
  const profile = openProfile(cookieStore.get("chathelp_linkedin")?.value, process.env.SESSION_SECRET!);
  return NextResponse.json({ configured: true, connected: Boolean(profile), profile: profile ? { name: profile.name, email: profile.email, picture: profile.picture } : undefined });
}