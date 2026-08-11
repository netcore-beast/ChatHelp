// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle, THEME_STORAGE_KEY } from "../src/components/ThemeToggle";

describe("DialogMint appearance theme", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("uses dark mode by default without touching workspace storage", () => {
    localStorage.setItem("dialogmint-unrelated", "preserve-me");

    render(<ThemeToggle />);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: /switch to light mode/i }).getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("dialogmint-unrelated")).toBe("preserve-me");
  });

  it("switches to light mode and persists only the appearance preference", () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole("button", { name: /switch to light mode/i }));

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("button", { name: /switch to dark mode/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("restores a previously selected light theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    render(<ThemeToggle />);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByRole("button", { name: /switch to dark mode/i })).toBeTruthy();
  });

  it("ships a dark charcoal card palette with an explicit light alternative", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

    expect(css).toContain("--canvas: #080b10");
    expect(css).toContain("--surface: #10151d");
    expect(css).toContain("--surface-raised: #161c26");
    expect(css).toContain(':root[data-theme="light"]');
    expect(css).toContain("color-scheme: dark");
    expect(css).toContain("button:not(.reminder-badge):not(.theme-toggle)");
  });
});
