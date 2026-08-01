// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkedInTestWizard } from "@/components/LinkedInTestWizard";
import type { Guidance } from "@/lib/workspaceTypes";

afterEach(() => cleanup());

const guidance: Guidance = {
  role: "Partnership lead",
  objective: "Explore a useful collaboration",
  voice: "Warm, concise, and specific",
  boundaries: "No pressure and no invented claims",
};

function renderWizard() {
  const onSaveProfile = vi.fn(() => "contact-test");
  const onCapture = vi.fn(async () => undefined);
  const onImportChat = vi.fn();
  const onGuidanceChange = vi.fn();
  const onGenerate = vi.fn(async () => undefined);

  render(<LinkedInTestWizard
    initialContact={null}
    guidance={guidance}
    drafts={["Thanks for the thoughtful question. Would a brief call next week be useful?"]}
    aiStatus=""
    onClose={vi.fn()}
    onSaveProfile={onSaveProfile}
    onCapture={onCapture}
    onImportChat={onImportChat}
    onGuidanceChange={onGuidanceChange}
    onGenerate={onGenerate}
  />);

  return { onSaveProfile, onCapture, onImportChat, onGuidanceChange, onGenerate };
}

describe("LinkedIn real-profile test wizard", () => {
  it("requires consent and clearly separates contact profile, chat capture, and cloud drafts", async () => {
    const handlers = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain("Confirm the privacy checklist");

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.change(screen.getByLabelText("Selected contact’s name or private nickname"), { target: { value: "Alex from Northwind" } });
    fireEvent.change(screen.getByLabelText("LinkedIn profile URL"), { target: { value: "https://www.linkedin.com/in/alex-example" } });
    expect(screen.getByRole("link", { name: /Open this profile/ }).getAttribute("href")).toBe("https://www.linkedin.com/in/alex-example");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(handlers.onSaveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "Alex from Northwind" }));

    fireEvent.click(screen.getByRole("button", { name: /Capture Alex from Northwind's LinkedIn profile screen/ }));
    await waitFor(() => expect(handlers.onCapture).toHaveBeenCalledWith("contact-test", "profile"));
    fireEvent.change(screen.getByLabelText("Relevant notes about Alex from Northwind"), { target: { value: "Interested in responsible AI partnerships." } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: /Capture conversation screen with Alex from Northwind/ }));
    await waitFor(() => expect(handlers.onCapture).toHaveBeenCalledWith("contact-test", "chat"));
    fireEvent.change(screen.getByLabelText("Optional manual chat lines"), { target: { value: "Me: Great to reconnect.\nAlex: What partnership did you have in mind?" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(handlers.onImportChat).toHaveBeenCalledWith("contact-test", expect.stringContaining("What partnership"));

    fireEvent.change(screen.getByLabelText("What should the next message accomplish?"), { target: { value: "Answer the question and suggest a brief call." } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(screen.getByRole("button", { name: "Generate 3 private drafts" }));
    await waitFor(() => expect(handlers.onGenerate).toHaveBeenCalledWith("contact-test", "Answer the question and suggest a brief call."));
    expect(screen.getByText(/Thanks for the thoughtful question/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open LinkedIn to review/ }).getAttribute("href")).toBe("https://www.linkedin.com/messaging/");
  });

  it("rejects non-member and non-HTTPS profile URLs", () => {
    renderWizard();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Selected contact’s name or private nickname"), { target: { value: "Alex" } });
    fireEvent.change(screen.getByLabelText("LinkedIn profile URL"), { target: { value: "https://example.com/in/alex" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain("https://www.linkedin.com/in/");
  });
});
