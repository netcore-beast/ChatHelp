import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const response = NextResponse.json({ connected: false });
  response.cookies.set("chathelp_linkedin", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0, secure: new URL(request.url).protocol === "https:" });
  return response;
}