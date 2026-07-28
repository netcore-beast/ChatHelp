"use client";
/* eslint-disable react-hooks/set-state-in-effect, @next/next/no-img-element */

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  generatePrivateDrafts,
  loadPrivateModel,
  PRIVATE_MODELS,
  type PrivateDraft,
} from "@/lib/privateAi";
import { recognizeImageLocally } from "@/lib/localOcr";

type Message = { id: string; sender: "me" | "them"; text: string; date: string };
type Contact = {
  id: string;
  name: string;
  headline: string;
  company: string;
  location: string;
  relationship: string;
  notes: string;
  capturedContext: string;
  chat: Message[];
};
type Guidance = {
  role: string;
  goal: string;
  tone: string;
  boundaries: string;
  callToAction: string;
  background: string;
};
type Feedback = { contactId: string; label: string; vote: "up" | "down"; at: string };
type AiState = "idle" | "loading" | "ready" | "generating" | "error";
type CaptureState = "idle" | "requesting" | "captured" | "reading" | "review";

const uid = () => Date.now() + "-" + Math.random().toString(36).slice(2, 9);
const now = () => new Date().toISOString();

const starterContacts: Contact[] = [{
  id: "priya-demo",
  name: "Priya Shah",
  headline: "VP, Strategic Partnerships",
  company: "Northstar Labs",
  location: "Toronto, Canada",
  relationship: "Met at a growth forum",
  notes: "Interested in practical AI adoption and partner-led growth. Demo contact — replace this with information you have permission to use.",
  capturedContext: "",
  chat: [
    { id: "p1", sender: "me", text: "Great meeting you at the growth forum, Priya. I enjoyed your point about starting partnerships with a narrow customer problem.", date: "2026-06-10T14:10:00Z" },
    { id: "p2", sender: "them", text: "Likewise! Teams that define one measurable outcome usually move much faster. Happy to compare notes sometime.", date: "2026-06-10T16:42:00Z" },
    { id: "p3", sender: "them", text: "We are reviewing how we identify partner opportunities without adding more admin for the team.", date: "2026-06-12T15:31:00Z" },
  ],
}];

const defaultGuidance: Guidance = {
  role: "Founder building a privacy-first relationship assistant",
  goal: "Explore a small business partnership without sounding transactional",
  tone: "Warm, concise, curious",
  boundaries: "Do not exaggerate results. Avoid pressure, hype, fake familiarity, and invented facts.",
  callToAction: "Ask whether a 20-minute conversation next week would be useful",
  background: "We help professionals use conversation context to reach out thoughtfully while keeping private messages on their device.",
};

function lowerFirst(value: string) {
  const text = value.trim().replace(/[.!?]+$/, "");
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : "explore a useful next step";
}

function questionFromCallToAction(value: string) {
  const cleaned = value.trim().replace(/[.!?]+$/, "");
  if (!cleaned) return "Would a short conversation next week be useful?";
  if (/^ask whether /i.test(cleaned)) return cleaned.replace(/^ask whether /i, "Would ").replace(/ would /i, " ") + "?";
  if (/^ask for /i.test(cleaned)) return "Would you be open to " + cleaned.replace(/^ask for /i, "") + "?";
  if (/^(would|could|can|are|is|do|does|how|what|when|where|who|why)/i.test(cleaned)) return cleaned + "?";
  return "Would you be open to " + lowerFirst(cleaned) + "?";
}

function shortTopic(value: string) {
  const sentence = value.replace(/s+/g, " ").split(/[.!?]/)[0].trim();
  if (!sentence) return "the opportunity you mentioned";
  return sentence.length > 105 ? sentence.slice(0, 102) + "…" : sentence;
}

function templateDrafts(contact: Contact, guidance: Guidance, agenda: string): PrivateDraft[] {
  const first = contact.name.split(" ")[0] || "there";
  const latest = [...contact.chat].reverse().find((message) => message.sender === "them")?.text;
  const topic = shortTopic(latest || contact.capturedContext || contact.notes);
  const purpose = lowerFirst(agenda || guidance.goal);
  const cta = questionFromCallToAction(guidance.callToAction);
  const background = guidance.background.trim();
  const organization = contact.company ? "your work at " + contact.company : "the work you are doing";
  return [
    {
      id: uid(),
      label: "Warm & contextual",
      text: "Hi " + first + " — your point about “" + topic + "” stayed with me. " + background + " My goal is to " + purpose + ". " + cta,
      rationale: "Starts from the contact’s latest context before introducing your agenda.",
    },
    {
      id: uid(),
      label: "Direct & concise",
      text: "Hi " + first + " — I see a possible fit between " + organization + " and my goal to " + purpose + ". " + cta,
      rationale: "Makes the relevance and next step easy to evaluate.",
    },
    {
      id: uid(),
      label: "Curious & low-pressure",
      text: "Hi " + first + " — how are you thinking about “" + topic + "” now? I am exploring how to " + purpose + ", and your perspective would be genuinely useful. No pressure — " + cta,
      rationale: "Invites perspective without assuming interest or creating urgency.",
    },
  ];
}

function messagesFromFile(text: string, fileName: string, contactName: string): Message[] {
  const firstName = contactName.toLowerCase().split(" ")[0];
  if (fileName.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(text) as unknown;
    const values = Array.isArray(parsed) ? parsed : (parsed as { messages?: unknown[] }).messages;
    if (!Array.isArray(values)) throw new Error("JSON must be an array or contain a messages array.");
    return values.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const value = item as Record<string, unknown>;
      const body = String(value.text || value.content || value.message || "").trim();
      if (!body) return [];
      const sender = String(value.sender || value.from || "").toLowerCase().includes(firstName) ? "them" as const : "me" as const;
      return [{ id: uid(), sender, text: body, date: String(value.date || value.createdAt || now()) }];
    });
  }

  if (fileName.toLowerCase().endsWith(".csv")) {
    const rows = text.split(/\r?\n/).filter(Boolean).map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")));
    const headers = (rows.shift() || []).map((header) => header.toLowerCase());
    const textIndex = headers.findIndex((header) => /content|message|text/.test(header));
    const senderIndex = headers.findIndex((header) => /from|sender/.test(header));
    const dateIndex = headers.findIndex((header) => /date|time/.test(header));
    if (textIndex < 0) throw new Error("The CSV needs a Content, Message, or Text column.");
    return rows.flatMap((row) => {
      const body = row[textIndex]?.trim();
      if (!body) return [];
      const sender = String(row[senderIndex] || "").toLowerCase().includes(firstName) ? "them" as const : "me" as const;
      return [{ id: uid(), sender, text: body, date: row[dateIndex] || now() }];
    });
  }

  return text.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const fromThem = trimmed.toLowerCase().startsWith(firstName + ":") || trimmed.toLowerCase().startsWith("them:");
    const body = trimmed.replace(/^[^:]{1,40}:s*/, "");
    return [{ id: uid(), sender: fromThem ? "them" as const : "me" as const, text: body, date: new Date(Date.now() - (100 - index) * 60000).toISOString() }];
  });
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ChatHelpApp() {
  const [contacts, setContacts] = useState<Contact[]>(starterContacts);
  const [activeId, setActiveId] = useState(starterContacts[0].id);
  const [guidance, setGuidance] = useState<Guidance>(defaultGuidance);
  const [agenda, setAgenda] = useState("See whether a small pilot could help Northstar identify warm partnership opportunities from existing conversations");
  const [drafts, setDrafts] = useState<PrivateDraft[]>(() => templateDrafts(starterContacts[0], defaultGuidance, ""));
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showCapture, setShowCapture] = useState(false);
  const [captureState, setCaptureState] = useState<CaptureState>("idle");
  const [capturePreview, setCapturePreview] = useState("");
  const [capturedText, setCapturedText] = useState("");
  const [captureProgress, setCaptureProgress] = useState(0);
  const [captureStatus, setCaptureStatus] = useState("");
  const [modelId, setModelId] = useState(PRIVATE_MODELS[0].id);
  const [aiState, setAiState] = useState<AiState>("idle");
  const [aiProgress, setAiProgress] = useState(0);
  const [aiStatus, setAiStatus] = useState("Not loaded");

  const active = contacts.find((contact) => contact.id === activeId) || contacts[0];
  const selectedModel = PRIVATE_MODELS.find((model) => model.id === modelId) || PRIVATE_MODELS[0];
  const recentMessages = active?.chat.slice(-10) || [];
  const contactFeedback = feedback.filter((item) => item.contactId === activeId);
  const positiveCount = contactFeedback.filter((item) => item.vote === "up").length;

  useEffect(() => {
    try {
      const saved = localStorage.getItem("chathelp-private-v2");
      if (saved) {
        const data = JSON.parse(saved) as { contacts?: Contact[]; guidance?: Guidance; feedback?: Feedback[]; modelId?: string };
        if (data.contacts?.length) {
          const restored = data.contacts.map((contact) => ({ ...contact, capturedContext: contact.capturedContext || "" }));
          setContacts(restored);
          setActiveId(restored[0].id);
          setDrafts(templateDrafts(restored[0], data.guidance || defaultGuidance, ""));
        }
        if (data.guidance) setGuidance(data.guidance);
        if (data.feedback) setFeedback(data.feedback);
        if (data.modelId && PRIVATE_MODELS.some((model) => model.id === data.modelId)) setModelId(data.modelId);
      }
    } catch {
      setNotice("The saved workspace could not be read, so a fresh workspace was opened.");
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem("chathelp-private-v2", JSON.stringify({ contacts, guidance, feedback, modelId }));
  }, [contacts, guidance, feedback, modelId, ready]);

  const contextStrength = useMemo(() => {
    if (!active) return 0;
    return Math.min(100, 15 + Math.min(active.chat.length * 6, 36) + (active.headline ? 10 : 0) + (active.notes ? 10 : 0) + (active.capturedContext ? 14 : 0) + (guidance.goal ? 8 : 0) + (agenda ? 7 : 0));
  }, [active, guidance.goal, agenda]);

  function updateContact(patch: Partial<Contact>) {
    setContacts((items) => items.map((item) => item.id === activeId ? { ...item, ...patch } : item));
  }

  async function importChat(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !active) return;
    try {
      const imported = messagesFromFile(await file.text(), file.name, active.name);
      updateContact({ chat: [...active.chat, ...imported].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) });
      setNotice(imported.length + " messages were imported on this device.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The chat file could not be read.");
    }
    event.target.value = "";
  }

  async function importProfile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !active) return;
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith(".json")) {
        const value = JSON.parse(text) as Record<string, unknown>;
        updateContact({
          name: String(value.name || active.name),
          headline: String(value.headline || value.title || active.headline),
          company: String(value.company || active.company),
          location: String(value.location || active.location),
          notes: String(value.notes || value.summary || active.notes),
        });
      } else {
      updateContact({ notes: [active.notes, text].filter(Boolean).join("\n\n") });
      }
      setNotice("Profile context was added locally.");
    } catch {
      setNotice("The profile file could not be read.");
    }
    event.target.value = "";
  }

  function addContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const contact: Contact = {
      id: uid(),
      name: String(form.get("name") || "New contact"),
      headline: String(form.get("headline") || ""),
      company: String(form.get("company") || ""),
      location: "",
      relationship: String(form.get("relationship") || ""),
      notes: String(form.get("notes") || ""),
      capturedContext: "",
      chat: [],
    };
    setContacts((items) => [...items, contact]);
    setActiveId(contact.id);
    setDrafts(templateDrafts(contact, guidance, agenda));
    setShowAdd(false);
  }

  async function preparePrivateAi() {
    setAiState("loading");
    setAiProgress(0);
    setAiStatus("Starting private model download…");
    try {
      await loadPrivateModel(modelId, (progress) => {
        setAiProgress(progress.progress);
        setAiStatus(progress.text);
      });
      setAiState("ready");
      setAiProgress(1);
      setAiStatus("Ready on this device");
      setNotice(selectedModel.name + " is ready. Conversation context stays in this browser.");
    } catch (error) {
      setAiState("error");
      const message = error instanceof Error ? error.message : "The private model could not be loaded.";
      setAiStatus(message);
      setNotice(message);
    }
  }

  function feedbackSummary() {
    const liked = contactFeedback.filter((item) => item.vote === "up").map((item) => item.label);
    const disliked = contactFeedback.filter((item) => item.vote === "down").map((item) => item.label);
    return "Previously liked approaches: " + (liked.join(", ") || "none yet") + ". Previously disliked approaches: " + (disliked.join(", ") || "none yet") + ".";
  }

  async function generate() {
    if (!active) return;
    if (aiState !== "ready") {
      setDrafts(templateDrafts(active, guidance, agenda));
      setNotice("Created transparent local templates. Load the private AI for model-generated options.");
      return;
    }
    setAiState("generating");
    setAiStatus("Thinking privately on this device…");
    try {
      const result = await generatePrivateDrafts({
        contact: {
          name: active.name,
          headline: active.headline,
          company: active.company,
          location: active.location,
          relationship: active.relationship,
          notes: active.notes,
          capturedContext: active.capturedContext,
        },
        recentMessages: active.chat.slice(-14).map(({ sender, text, date }) => ({ sender, text, date })),
        guidance,
        agenda,
        feedbackSummary: feedbackSummary(),
      });
      setDrafts(result);
      setNotice("Three messages were generated locally. Review every detail before using one.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Private generation failed.");
    } finally {
      setAiState("ready");
      setAiStatus("Ready on this device");
    }
  }

  async function takeOneShotCapture() {
    setShowCapture(true);
    setCaptureState("requesting");
    setCapturePreview("");
    setCapturedText("");
    setCaptureStatus("Waiting for your browser selection…");
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("The selected screen could not be read."));
      });
      await video.play();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const scale = Math.min(1, 1800 / Math.max(video.videoWidth, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("A capture canvas could not be created.");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      setCapturePreview(canvas.toDataURL("image/jpeg", 0.88));
      setCaptureState("captured");
      setCaptureStatus("One frame captured. The screen stream is stopped.");
    } catch (error) {
      setCaptureState("idle");
      setCaptureStatus(error instanceof Error ? error.message : "Screen capture was cancelled.");
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  async function readCapture() {
    if (!capturePreview) return;
    setCaptureState("reading");
    setCaptureProgress(0);
    try {
      const text = await recognizeImageLocally(capturePreview, (progress) => {
        setCaptureProgress(progress.progress);
        setCaptureStatus(progress.status);
      });
      setCapturedText(text);
      setCaptureState("review");
      setCaptureStatus("Review and remove anything you do not want to keep.");
    } catch (error) {
      setCaptureState("captured");
      setCaptureStatus(error instanceof Error ? error.message : "Local text recognition failed.");
    }
  }

  function saveReviewedCapture() {
    if (!active || !capturedText.trim()) return;
    updateContact({ capturedContext: [active.capturedContext, capturedText.trim()].filter(Boolean).join("\n\n") });
    setShowCapture(false);
    setCapturePreview("");
    setCapturedText("");
    setNotice("Reviewed capture text was added to this contact on this device.");
  }

  function vote(draft: PrivateDraft, vote: "up" | "down") {
    setFeedback((items) => [...items, { contactId: activeId, label: draft.label, vote, at: now() }]);
    setNotice(vote === "up" ? "Saved as a preferred local pattern." : "Saved as a pattern to avoid next time.");
  }

  async function copyDraft(text: string) {
    await navigator.clipboard.writeText(text);
    setNotice("Copied. Paste it manually after reviewing it in LinkedIn.");
  }

  function eraseWorkspace() {
    localStorage.removeItem("chathelp-private-v2");
    localStorage.removeItem("chathelp-private-v1");
    setContacts([]);
    setFeedback([]);
    setDrafts([]);
    setShowPrivacy(false);
    setNotice("ChatHelp workspace data was erased from this browser.");
  }

  if (!ready) return <main className="loading"><span>CH</span><p>Opening your private workspace…</p></main>;

  return <main className="app-shell" id="top">
    <header className="topbar">
      <a className="brand" href="#top"><span className="brand-mark">CH</span><span>ChatHelp<small>Private conversation copilot</small></span></a>
      <div className="top-actions">
        <span className="privacy-pill"><i /> No AI API · device-only inference</span>
        <button className="button secondary" onClick={() => setShowPrivacy(true)}>Privacy</button>
        <a className="button linkedin" href="https://www.linkedin.com/messaging/" target="_blank" rel="noreferrer">Open LinkedIn ↗</a>
      </div>
    </header>

    {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss">×</button></div>}

    <section className="workspace">
      <aside className="people-panel">
        <div className="panel-heading"><div><span className="eyebrow">People</span><h2>One person at a time</h2></div><button className="icon-button" onClick={() => setShowAdd(true)} aria-label="Add person">+</button></div>
        <label className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people" /></label>
        <div className="contact-list">
          {contacts.filter((contact) => (contact.name + " " + contact.company + " " + contact.headline).toLowerCase().includes(search.toLowerCase())).map((contact) => <button key={contact.id} className={"contact-card " + (contact.id === activeId ? "active" : "")} onClick={() => { setActiveId(contact.id); setDrafts(templateDrafts(contact, guidance, agenda)); }}>
            <span className="avatar">{contact.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</span>
            <span><strong>{contact.name}</strong><small>{contact.headline || contact.company || "Add context"}</small></span>
            <i>{contact.chat.length}</i>
          </button>)}
          {!contacts.length && <div className="empty-state"><strong>Your workspace is empty</strong><p>Add a person to begin.</p><button className="button primary" onClick={() => setShowAdd(true)}>Add person</button></div>}
        </div>
        <div className="local-card"><span>01</span><div><strong>Stored in this browser</strong><p>Contacts, guidance, feedback, and reviewed capture text stay in local storage.</p></div></div>
      </aside>

      {active ? <>
        <section className="context-panel">
          <div className="person-header">
            <div className="avatar large">{active.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</div>
            <div><span className="eyebrow">Selected person</span><h1>{active.name}</h1><p>{[active.headline, active.company, active.location].filter(Boolean).join(" · ") || "Add profile context below"}</p></div>
            <div className="strength"><span>Context</span><strong>{contextStrength}%</strong></div>
          </div>

          <div className="profile-grid">
            <label><span>Headline</span><input value={active.headline} onChange={(event) => updateContact({ headline: event.target.value })} /></label>
            <label><span>Company</span><input value={active.company} onChange={(event) => updateContact({ company: event.target.value })} /></label>
            <label><span>Relationship</span><input value={active.relationship} onChange={(event) => updateContact({ relationship: event.target.value })} /></label>
            <label><span>Location</span><input value={active.location} onChange={(event) => updateContact({ location: event.target.value })} /></label>
            <label className="full"><span>Profile notes</span><textarea rows={3} value={active.notes} onChange={(event) => updateContact({ notes: event.target.value })} /></label>
          </div>

          <div className="capture-card">
            <div><span className="eyebrow">Bring your own context</span><h3>Capture once, review, then keep locally</h3><p>No background recording. No LinkedIn scraping. The browser asks you to choose a tab or window every time.</p></div>
            <div className="capture-actions"><button className="button primary" onClick={takeOneShotCapture}>One-shot capture</button><label className="button secondary file-button">Import profile<input type="file" accept=".json,.txt,.md" onChange={importProfile} /></label></div>
          </div>

          {active.capturedContext && <details className="reviewed-context"><summary>Reviewed capture context</summary><textarea rows={5} value={active.capturedContext} onChange={(event) => updateContact({ capturedContext: event.target.value })} /></details>}

          <div className="conversation-heading"><div><span className="eyebrow">Conversation</span><h2>Recent messages</h2></div><label className="button secondary file-button">Import chat<input type="file" accept=".json,.csv,.txt" onChange={importChat} /></label></div>
          <div className="chat-window">
            {recentMessages.map((message) => <div className={"message-row " + message.sender} key={message.id}><div className="message"><p>{message.text}</p><small>{message.sender === "me" ? "You" : active.name.split(" ")[0]} · {formatDate(message.date)}</small></div></div>)}
            {!recentMessages.length && <div className="empty-chat"><strong>No messages yet</strong><p>Import a user-controlled export, JSON, CSV, or text file.</p></div>}
          </div>
        </section>

        <aside className="coach-panel">
          <div className="coach-heading"><span className="eyebrow">Private AI studio</span><h2>Write with context, not guesswork.</h2><p>Model inference happens locally through WebGPU. Model weights download from the model host; your private context is not included in that request.</p></div>

          <div className="model-card">
            <div className="model-title"><span className={"status-dot " + aiState} /><div><strong>{aiState === "ready" || aiState === "generating" ? "Private AI ready" : "Choose your private model"}</strong><small>{aiStatus}</small></div></div>
            <select value={modelId} onChange={(event) => { setModelId(event.target.value); setAiState("idle"); setAiStatus("Not loaded"); }} disabled={aiState === "loading" || aiState === "generating"}>
              {PRIVATE_MODELS.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
            </select>
            <p>{selectedModel.description} First download: {selectedModel.approximateDownload}; later use is cached by the browser.</p>
            {(aiState === "loading" || aiState === "generating") && <div className="progress"><span style={{ width: Math.round(aiProgress * 100) + "%" }} /></div>}
            {aiState !== "ready" && aiState !== "generating" && <button className="button model-button" onClick={preparePrivateAi} disabled={aiState === "loading"}>{aiState === "loading" ? "Downloading…" : "Download & load private AI"}</button>}
          </div>

          <label className="field"><span>What do you want to achieve?</span><textarea rows={3} value={agenda} onChange={(event) => setAgenda(event.target.value)} /></label>
          <div className="guidance-block"><div><span className="eyebrow">Your communication guide</span><strong>{guidance.tone}</strong></div>
            <label className="field"><span>Your role</span><input value={guidance.role} onChange={(event) => setGuidance({ ...guidance, role: event.target.value })} /></label>
            <label className="field"><span>Goal</span><textarea rows={2} value={guidance.goal} onChange={(event) => setGuidance({ ...guidance, goal: event.target.value })} /></label>
            <label className="field"><span>Tone</span><input value={guidance.tone} onChange={(event) => setGuidance({ ...guidance, tone: event.target.value })} /></label>
            <label className="field"><span>Background to use</span><textarea rows={3} value={guidance.background} onChange={(event) => setGuidance({ ...guidance, background: event.target.value })} /></label>
            <label className="field"><span>Boundaries</span><textarea rows={3} value={guidance.boundaries} onChange={(event) => setGuidance({ ...guidance, boundaries: event.target.value })} /></label>
            <label className="field"><span>Preferred next step</span><input value={guidance.callToAction} onChange={(event) => setGuidance({ ...guidance, callToAction: event.target.value })} /></label>
          </div>

          <button className="button generate" onClick={generate} disabled={aiState === "loading" || aiState === "generating"}>{aiState === "generating" ? "Generating privately…" : aiState === "ready" ? "Generate 3 private AI drafts" : "Generate 3 local templates"}</button>
          {aiState !== "ready" && <p className="template-note">Templates are deterministic and clearly labelled; load the model for true AI generation.</p>}

          <div className="draft-list">
            {drafts.map((draft, index) => <article className="draft-card" key={draft.id}>
              <div className="draft-top"><span><i>{String(index + 1).padStart(2, "0")}</i>{draft.label}</span><button onClick={() => copyDraft(draft.text)}>Copy</button></div>
              <p>{draft.text}</p><small>{draft.rationale}</small>
              <div className="draft-feedback"><span>Help local personalization</span><button onClick={() => vote(draft, "up")} aria-label="Useful">Useful</button><button onClick={() => vote(draft, "down")} aria-label="Not useful">Not useful</button></div>
            </article>)}
          </div>
          <div className="learning-card"><span>✦</span><div><strong>Local preference memory</strong><p>{contactFeedback.length ? positiveCount + " of " + contactFeedback.length + " ratings were useful. This summary is included in future local prompts; the base model is not secretly retrained." : "Rate drafts to tell future local prompts which approaches to favor."}</p></div></div>
        </aside>
      </> : <section className="no-contact"><span className="brand-mark">CH</span><h1>Add a person to start</h1><p>ChatHelp works with only the contact you select.</p></section>}
    </section>

    <footer><span>ChatHelp is not affiliated with LinkedIn. You control what context is captured and must review every draft.</span><span>No API calls to LinkedIn · No auto-send · No hidden recording</span></footer>

    {showAdd && <div className="modal-backdrop"><form className="modal" onSubmit={addContact}><button type="button" className="modal-close" onClick={() => setShowAdd(false)}>×</button><span className="eyebrow">New workspace</span><h2>Add one person</h2><p>Only add information you have permission to use.</p><label className="field"><span>Name</span><input name="name" required autoFocus /></label><label className="field"><span>Headline</span><input name="headline" /></label><label className="field"><span>Company</span><input name="company" /></label><label className="field"><span>How you know them</span><input name="relationship" /></label><label className="field"><span>Initial notes</span><textarea name="notes" rows={4} /></label><button className="button primary full-button" type="submit">Create private workspace</button></form></div>}

    {showPrivacy && <div className="modal-backdrop"><section className="modal privacy-modal"><button className="modal-close" onClick={() => setShowPrivacy(false)}>×</button><span className="eyebrow">Privacy center</span><h2>What leaves this browser?</h2><div className="privacy-points"><article><b>01</b><div><strong>Your conversation context does not</strong><p>Chats, notes, guidance, captures, prompts, drafts, and feedback are kept in browser storage and passed only to the on-device model.</p></div></article><article><b>02</b><div><strong>Model files are downloaded</strong><p>The selected open model is downloaded from WebLLM’s configured model host and cached. The download request does not contain your conversation data.</p></div></article><article><b>03</b><div><strong>Screen permission is never persistent</strong><p>The browser requires a user gesture and selection for each capture. ChatHelp takes one frame and stops every track immediately.</p></div></article><article><b>04</b><div><strong>Sending is always manual</strong><p>ChatHelp never reads the LinkedIn DOM, injects controls, pastes, or sends messages on your behalf.</p></div></article></div><button className="danger-link" onClick={eraseWorkspace}>Erase this browser workspace</button></section></div>}

    {showCapture && <div className="modal-backdrop"><section className="modal capture-modal"><button className="modal-close" onClick={() => setShowCapture(false)}>×</button><span className="eyebrow">Explicit one-shot capture</span><h2>Review before keeping anything</h2><p>Choose only a tab or window you are authorized to capture. Website terms and other people’s privacy still apply.</p>{capturePreview ? <img src={capturePreview} alt="One-shot screen capture preview" /> : <div className="capture-placeholder"><span>▣</span><strong>{captureState === "requesting" ? "Choose a tab or window in the browser prompt" : "No image captured"}</strong></div>}<div className="capture-status"><span>{captureStatus}</span>{captureState === "reading" && <strong>{Math.round(captureProgress * 100)}%</strong>}</div>{captureState === "captured" && <button className="button primary full-button" onClick={readCapture}>Extract text locally</button>}{captureState === "review" && <><label className="field"><span>Review and redact extracted text</span><textarea rows={10} value={capturedText} onChange={(event) => setCapturedText(event.target.value)} /></label><button className="button primary full-button" onClick={saveReviewedCapture} disabled={!capturedText.trim()}>Add reviewed text to {active.name}</button></>}</section></div>}
  </main>;
}
