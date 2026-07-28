import sharp from "sharp";
import { mkdir } from "node:fs/promises";

await mkdir("public", { recursive: true });
const make = async (size, file, inset = 0) => {
  const pad = inset ? Math.round(size * inset) : 0;
  const inner = size - pad * 2;
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="${Math.round(size * .2)}" fill="#145c3e"/><rect x="${pad}" y="${pad}" width="${inner}" height="${inner}" rx="${Math.round(size * .16)}" fill="#145c3e"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#f6f4ed" font-family="Arial, sans-serif" font-size="${Math.round(size * .29)}" font-weight="800">CH</text><circle cx="${Math.round(size * .76)}" cy="${Math.round(size * .25)}" r="${Math.round(size * .055)}" fill="#8fd5ad"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
};
await make(192, "public/icon-192.png");
await make(512, "public/icon-512.png");
await make(512, "public/icon-maskable-512.png", .1);
