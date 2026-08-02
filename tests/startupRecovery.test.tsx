// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/secureVault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/secureVault")>();
  return {
    ...actual,
    getVaultMode: vi.fn(async () => { throw new Error("Secure storage is blocked by another ChatHelp tab."); }),
  };
});

import ChatHelpApp from "@/components/ChatHelpApp";

afterEach(() => cleanup());

describe("secure storage startup recovery", () => {
  it("replaces the loading screen with a safe recovery message", async () => {
    render(<ChatHelpApp />);
    const heading = await screen.findByRole("heading", { name: "ChatHelp could not open the encrypted workspace." });
    expect(heading).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("blocked by another ChatHelp tab");
    expect(screen.getByRole("button", { name: "Retry secure storage" })).toBeTruthy();
    expect(screen.queryByText("Checking this browser for an encrypted workspace…")).toBeNull();
  });
});
