import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

describe("PWA service worker updates", () => {
  it("uses the network response for versioned application chunks when an older cached response exists", async () => {
    const listeners = new Map<string, (event: { request: Request; respondWith: (response: Promise<Response>) => void }) => void>();
    const cachedResponse = new Response("old three-draft bundle");
    const networkResponse = new Response("new one-draft Claude bundle");
    const fetchNetwork = vi.fn(async () => networkResponse);
    const cachePut = vi.fn(async () => undefined);
    let responsePromise: Promise<Response> | undefined;

    runInNewContext(readFileSync("public/sw.js", "utf8"), {
      URL,
      fetch: fetchNetwork,
      caches: {
        match: vi.fn(async () => cachedResponse),
        open: vi.fn(async () => ({ put: cachePut })),
        keys: vi.fn(async () => []),
        delete: vi.fn(async () => true),
      },
      self: {
        location: { origin: "https://testing.example" },
        addEventListener: (type: string, listener: (event: { request: Request; respondWith: (response: Promise<Response>) => void }) => void) => {
          listeners.set(type, listener);
        },
        skipWaiting: vi.fn(async () => undefined),
        clients: { claim: vi.fn(async () => undefined) },
      },
    });

    listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "cors",
        url: "https://testing.example/_next/static/chunks/app.js",
      } as Request,
      respondWith: (response) => { responsePromise = response; },
    });

    expect(await (await responsePromise)?.text()).toBe("new one-draft Claude bundle");
    expect(fetchNetwork).toHaveBeenCalledOnce();
  });

  it("removes the previous application caches when the updated worker activates", async () => {
    const listeners = new Map<string, (event: { waitUntil: (work: Promise<unknown>) => void }) => void>();
    const deleteCache = vi.fn(async () => true);
    let activation: Promise<unknown> | undefined;

    runInNewContext(readFileSync("public/sw.js", "utf8"), {
      URL,
      fetch: vi.fn(),
      caches: {
        match: vi.fn(),
        open: vi.fn(async () => ({ addAll: vi.fn(async () => undefined) })),
        keys: vi.fn(async () => ["chathelp-shell-v1", "chathelp-static-v1"]),
        delete: deleteCache,
      },
      self: {
        location: { origin: "https://testing.example" },
        addEventListener: (type: string, listener: (event: { waitUntil: (work: Promise<unknown>) => void }) => void) => {
          listeners.set(type, listener);
        },
        skipWaiting: vi.fn(async () => undefined),
        clients: { claim: vi.fn(async () => undefined) },
      },
    });

    listeners.get("activate")?.({ waitUntil: (work) => { activation = work; } });
    await activation;

    expect(deleteCache).toHaveBeenCalledWith("chathelp-shell-v1");
    expect(deleteCache).toHaveBeenCalledWith("chathelp-static-v1");
  });
});
