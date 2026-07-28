# ChatHelp

ChatHelp is a privacy-first web workspace for preparing thoughtful LinkedIn outreach from the context a user intentionally provides. It works with one selected person at a time and keeps imported chat history, profile notes, personal guidance, generated drafts, and feedback in browser local storage.

## MVP capabilities

- LinkedIn OpenID Connect for the signed-in user's identity only
- One-person-at-a-time relationship workspaces
- Local chat import from CSV, JSON, or text
- Local profile context import from JSON, Markdown, or text
- A reusable personal communication guide: role, goal, tone, background, boundaries, and preferred call to action
- Three response approaches generated from the selected person's recent messages, profile context, the user's guidance, and the current agenda
- Draft copying and positive/negative feedback
- Device-local response memory and a privacy center with one-click erasure
- Responsive web layout ready for desktop, tablet, and mobile browsers

## Why chat/profile import is required

LinkedIn's self-service developer access permits OpenID Connect sign-in and the authenticated member's basic profile. Reading another member's profile, connections, or private messages requires restricted LinkedIn partner permissions. ChatHelp does not scrape LinkedIn or bypass those controls.

The compliant MVP flow is:

1. Link LinkedIn for the user's own identity (optional).
2. Select one person.
3. Import that person's messages from a user-controlled LinkedIn data export, CSV, JSON, or text file.
4. Add profile context manually or through a local file.
5. Add personal guidance and the outreach agenda.
6. Generate, copy, and rate private drafts.

## Privacy model

- Relationship data is not sent to a ChatHelp database.
- The current MVP uses browser local storage only.
- LinkedIn access tokens are used only during the OAuth callback and are not stored.
- The short-lived LinkedIn identity cookie is HTTP-only and HMAC-signed.
- Secrets are supplied through environment variables and must never be committed.
- The Privacy Center can erase all local ChatHelp data.

Browser storage is device- and browser-profile-specific. Clearing browser data removes the workspace. A future encrypted sync feature should be opt-in and use user-held encryption keys.

## Codespaces development

The repository includes a dev-container definition. In GitHub Codespaces, dependencies install with `npm ci`.

```bash
npm run dev
```

Open port `3000` from the Codespaces Ports panel.

Validation:

```bash
npm run lint
npm run build
```

## LinkedIn identity configuration

Create an app in the LinkedIn Developer Portal and enable **Sign In with LinkedIn using OpenID Connect**. Copy `.env.example` to `.env.local` inside the Codespace and set:

```dotenv
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
NEXT_PUBLIC_APP_URL=https://your-public-origin.example
SESSION_SECRET=
```

Register this exact callback URL in the LinkedIn app:

```text
https://your-public-origin.example/api/linkedin/callback
```

The basic private drafting workspace works without LinkedIn OAuth configuration.

## Import formats

Chat CSV files should include a message column named `Content`, `Message`, or `Text`. Optional sender and date columns may be named `From`/`Sender` and `Date`/`Time`.

Chat JSON can be an array or an object with a `messages` array:

```json
{
  "messages": [
    { "sender": "Priya", "text": "Happy to compare notes.", "date": "2026-06-12" },
    { "sender": "Me", "text": "Would next Tuesday work?", "date": "2026-06-13" }
  ]
}
```

Profile JSON can include `name`, `headline`, `company`, `location`, `profileUrl`, `notes`, or `summary`.

## Roadmap

1. Harden the web MVP with automated interaction tests and encrypted backup/export.
2. Add an optional in-browser language model for WebGPU-capable devices, keeping conversation inference local.
3. Add explicit per-contact retention settings and detailed response outcome tracking.
4. Introduce an installable Progressive Web App.
5. Reuse the web domain and data model in an Android client after the web workflows mature.

## Important

ChatHelp is not affiliated with LinkedIn. Users are responsible for having the right to use imported conversation and profile information and for reviewing every draft before sending it.