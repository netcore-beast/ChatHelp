import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type FetchListener = (event: {
  request: Request;
  respondWith: (response: Promise<Response>) => void;
}) => void;

function serviceWorkerHarness() {
  const listeners = new Map<string, FetchListener>();
  const fetchNetwork = vi.fn(async () => new Response("network response"));
  const cacheMatch = vi.fn(async () => undefined);
  const cachePut = vi.fn(async () => undefined);
  const cacheOpen = vi.fn(async () => ({
    addAll: vi.fn(async () => undefined),
    put: cachePut,
  }));

  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    URL,
    fetch: fetchNetwork,
    caches: {
      match: cacheMatch,
      open: cacheOpen,
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    },
    self: {
      location: { origin: "https://testing.example" },
      addEventListener: (type: string, listener: FetchListener) => {
        listeners.set(type, listener);
      },
      skipWaiting: vi.fn(async () => undefined),
      clients: { claim: vi.fn(async () => undefined) },
    },
  });

  function dispatchFetch(path: string, mode: RequestMode = "cors", method = "GET", origin = "https://testing.example") {
    let responsePromise: Promise<Response> | undefined;
    const respondWith = vi.fn((response: Promise<Response>) => { responsePromise = response; });
    listeners.get("fetch")?.({
      request: { method, mode, url: `${origin}${path}` } as Request,
      respondWith,
    });
    return { respondWith, response: () => responsePromise };
  }

  return { cacheMatch, cacheOpen, cachePut, dispatchFetch, fetchNetwork };
}

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

  it.each([
    ["/api", "navigate"],
    ["/api/learning/status?fresh=1", "navigate"],
    ["/api/usage?month=2026-08", "cors"],
    ["/health?probe=ready", "navigate"],
  ] as const)("never intercepts, matches, or writes restricted GET %s in %s mode", (path, mode) => {
    const harness = serviceWorkerHarness();

    const dispatched = harness.dispatchFetch(path, mode);

    expect(dispatched.respondWith).not.toHaveBeenCalled();
    expect(harness.fetchNetwork).not.toHaveBeenCalled();
    expect(harness.cacheOpen).not.toHaveBeenCalled();
    expect(harness.cacheMatch).not.toHaveBeenCalled();
    expect(harness.cachePut).not.toHaveBeenCalled();
  });

  it.each([
    ["/_next/static-evil/chunk.js", "cors", "GET", "https://testing.example"],
    ["/images/avatar.png", "cors", "GET", "https://testing.example"],
    ["/_next/static/chunk.js", "cors", "POST", "https://testing.example"],
    ["/_next/static/chunk.js", "cors", "GET", "https://other.example"],
  ] as const)("ignores non-approved request %s", (path, mode, method, origin) => {
    const harness = serviceWorkerHarness();

    const dispatched = harness.dispatchFetch(path, mode, method, origin);

    expect(dispatched.respondWith).not.toHaveBeenCalled();
    expect(harness.fetchNetwork).not.toHaveBeenCalled();
    expect(harness.cacheOpen).not.toHaveBeenCalled();
    expect(harness.cacheMatch).not.toHaveBeenCalled();
  });

  it.each([
    ["/_next/static/chunk.js", "cors"],
    ["/tesseract/worker.js", "cors"],
    ["/tesseract-core/core.wasm.js", "cors"],
    ["/tessdata/eng.traineddata.gz", "cors"],
    ["/icon-192.png", "cors"],
    ["/icon-512.png", "cors"],
    ["/icon-maskable-512.png", "cors"],
    ["/settings", "navigate"],
  ] as const)("handles approved same-origin GET %s", async (path, mode) => {
    const harness = serviceWorkerHarness();

    const dispatched = harness.dispatchFetch(path, mode);

    expect(dispatched.respondWith).toHaveBeenCalledOnce();
    await dispatched.response();
    expect(harness.fetchNetwork).toHaveBeenCalledOnce();
    expect(harness.cachePut).toHaveBeenCalledOnce();
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
        keys: vi.fn(async () => [
          "chathelp-shell-v1",
          "chathelp-static-v1",
          "chathelp-shell-v2",
          "chathelp-static-v2",
          "chathelp-shell-v3",
          "chathelp-static-v3",
        ]),
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
    expect(deleteCache).toHaveBeenCalledWith("chathelp-shell-v2");
    expect(deleteCache).toHaveBeenCalledWith("chathelp-static-v2");
    expect(deleteCache).not.toHaveBeenCalledWith("chathelp-shell-v3");
    expect(deleteCache).not.toHaveBeenCalledWith("chathelp-static-v3");
  });
});
