import crypto from "crypto";

export type LinkedInProfile = { sub: string; name?: string; email?: string; picture?: string; exp: number };

export function sealProfile(profile: LinkedInProfile, secret: string) {
  const payload = Buffer.from(JSON.stringify(profile)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function openProfile(value: string | undefined, secret: string) {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  const profile = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LinkedInProfile;
  return profile.exp > Date.now() ? profile : null;
}