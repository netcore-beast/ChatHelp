"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildSanitizedPreview, type SanitizedPreviewInput } from "@/lib/learningSanitizer";

export type ImprovementSubmission =
  | { kind: "evaluation"; action: "useful" | "not_useful" | "accepted" | "edited" | "rejected" }
  | {
      kind: "generative";
      sanitizedTarget: string;
      rightsAttested: true;
      privacyAttested: true;
    };

interface SaveImprovementDialogProps {
  knownIdentifiers: SanitizedPreviewInput["known"];
  onClose: () => void;
  onRate: (action: Extract<ImprovementSubmission, { kind: "evaluation" }>["action"]) => void | Promise<void>;
  onSaveIndependent: (input: Extract<ImprovementSubmission, { kind: "generative" }>) => void | Promise<void>;
}

const REJECTION_LABELS: Record<string, string> = {
  email_address: "Remove the email address before saving.",
  url: "Remove the URL before saving.",
  social_handle: "Remove the social handle before saving.",
  phone_number: "Remove the phone number before saving.",
  postal_address: "Remove the postal address before saving.",
  long_identifier: "Remove the long identifier before saving.",
  control_character: "Remove unsupported control characters before saving.",
  invalid_text: "Enter between 1 and 2,000 characters.",
};

export function SaveImprovementDialog({ knownIdentifiers, onClose, onRate, onSaveIndependent }: SaveImprovementDialogProps) {
  const [path, setPath] = useState<"choose" | "rate" | "independent">("choose");
  const [independentText, setIndependentText] = useState("");
  const [rightsAttested, setRightsAttested] = useState(false);
  const [privacyAttestedPreview, setPrivacyAttestedPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState("");
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const choosePathRef = useRef<HTMLButtonElement>(null);
  const rateActionRef = useRef<HTMLButtonElement>(null);
  const independentEditorRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const initialPathRef = useRef(true);
  const knownContactName = knownIdentifiers.contactName ?? "";
  const knownCompany = knownIdentifiers.company ?? "";
  const knownProfileUrl = knownIdentifiers.profileUrl ?? "";
  const knownProfileHandle = knownIdentifiers.profileHandle ?? "";
  const preview = useMemo(() => buildSanitizedPreview({
    text: independentText,
    known: { contactName: knownContactName, company: knownCompany, profileUrl: knownProfileUrl, profileHandle: knownProfileHandle },
  }), [independentText, knownCompany, knownContactName, knownProfileHandle, knownProfileUrl]);
  const previewSignature = preview.ok ? `approved\u0000${preview.preview}` : `rejected\u0000${preview.reason}`;
  const privacyAttested = preview.ok && privacyAttestedPreview === previewSignature;

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (initialPathRef.current) {
      initialPathRef.current = false;
      return;
    }
    if (path === "rate") rateActionRef.current?.focus();
    else if (path === "independent") independentEditorRef.current?.focus();
    else choosePathRef.current?.focus();
  }, [path]);

  useEffect(() => {
    if (submitting) closeButtonRef.current?.focus();
  }, [submitting]);

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== "Tab") {
      event.stopPropagation();
      return;
    }
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled])') ?? [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1) ?? first;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    event.stopPropagation();
  }

  async function submitRating(action: "useful" | "not_useful") {
    setSubmitting(true);
    setSubmissionError("");
    try {
      await onRate(action);
      onClose();
    } catch {
      setSubmissionError("The improvement could not be saved. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitIndependent() {
    if (!preview.ok || !rightsAttested || !privacyAttested) return;
    setSubmitting(true);
    setSubmissionError("");
    try {
      await onSaveIndependent({ kind: "generative", sanitizedTarget: preview.preview, rightsAttested: true, privacyAttested: true });
      onClose();
    } catch {
      setSubmissionError("The improvement could not be saved. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="improvement-dialog-backdrop">
      <section ref={dialogRef} className="improvement-dialog" role="dialog" aria-modal="true" aria-labelledby="improvement-dialog-title" onKeyDown={handleDialogKeyDown}>
        <button ref={closeButtonRef} type="button" className="dialog-close" aria-label="Close improvement dialog" onClick={onClose}>{"\u00d7"}</button>
        <p className="eyebrow">APPROVED PERSONAL LEARNING</p>
        <h2 id="improvement-dialog-title">Help improve future drafts</h2>
        {path === "choose" && <>
          <p className="section-explainer">Choose what you want DialogMint to learn. Provider draft text is never saved as a training response.</p>
          <div className="improvement-paths">
            <button ref={choosePathRef} type="button" onClick={() => setPath("rate")}>Rate this draft</button>
            <button type="button" className="primary" onClick={() => setPath("independent")}>Add my own version</button>
          </div>
        </>}
        {path === "rate" && <>
          <p className="section-explainer">Your rating stores only a bounded evaluation signal, never the draft text.</p>
          <div className="improvement-rating-actions">
            <button ref={rateActionRef} type="button" disabled={submitting} onClick={() => void submitRating("useful")}>Useful</button>
            <button type="button" disabled={submitting} onClick={() => void submitRating("not_useful")}>Not useful</button>
          </div>
          <button type="button" className="secondary" disabled={submitting} onClick={() => setPath("choose")}>Back</button>
        </>}
        {path === "independent" && <>
          <label className="improvement-editor-label">Your independently written response
            <textarea
              ref={independentEditorRef}
              aria-label="Your independently written response"
              maxLength={2_000}
              value={independentText}
              onChange={(event) => {
                setIndependentText(event.target.value);
                setPrivacyAttestedPreview(null);
              }}
              placeholder="Write a response from scratch"
            />
          </label>
          {preview.ok ? <div className="sanitized-preview">
            <strong>Exact sanitized preview</strong>
            <output aria-label="Sanitized preview">{preview.preview}</output>
          </div> : independentText && <p className="improvement-validation" role="alert">{REJECTION_LABELS[preview.reason]}</p>}
          <p className="section-explainer">Automatic detection cannot catch every possible name or confidential phrase. Review the exact preview before approving it.</p>
          <label className="consent-check"><input type="checkbox" checked={rightsAttested} onChange={(event) => setRightsAttested(event.target.checked)} /><span>I wrote this response independently or have the rights to use it.</span></label>
          <label className="consent-check"><input type="checkbox" checked={privacyAttested} onChange={(event) => setPrivacyAttestedPreview(event.target.checked ? previewSignature : null)} /><span>I reviewed the sanitized preview and it contains no personal or confidential information.</span></label>
          <div className="improvement-dialog-actions">
            <button type="button" className="secondary" disabled={submitting} onClick={() => setPath("choose")}>Back</button>
            <button type="button" className="primary" disabled={submitting || !preview.ok || !rightsAttested || !privacyAttested} onClick={() => void submitIndependent()}>Save approved example</button>
          </div>
        </>}
        {submissionError && <p className="improvement-validation" role="alert">{submissionError}</p>}
      </section>
    </div>
  );
}
