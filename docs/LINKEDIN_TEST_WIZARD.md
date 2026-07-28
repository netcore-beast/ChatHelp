# Guided LinkedIn profile test

ChatHelp includes a six-step wizard for testing one LinkedIn conversation without connecting credentials or automating LinkedIn.

## Before using real information

- Use a profile and conversation you have a legitimate reason to process.
- Add only information needed for the current message.
- Do not add sensitive, unrelated, or third-party information.
- Read [PRIVACY.md](../PRIVACY.md) and [SECURITY.md](../SECURITY.md).

## Test flow

1. Unlock the encrypted ChatHelp vault and select **Guided LinkedIn test**.
2. Confirm the privacy checklist.
3. Add the person's name or a private nickname. A direct LinkedIn member profile URL is accepted only to open LinkedIn and is not stored.
4. Keep the chosen profile visible. Either type a short relevant summary or select that visible tab/window for local OCR.
5. Open LinkedIn Messaging and paste only the conversation lines needed for context. Prefix your lines with “Me:” or “I:”.
6. Set your role, relationship goal, voice, boundaries, and the next-message agenda.
7. Generate up to three drafts with the local WebLLM model, review them, copy one, then return to LinkedIn and send it manually.

## What this proves

The wizard exercises explicit selection, encrypted storage, chat parsing, personalized guidance, local context retrieval, local model generation, draft review, and manual handoff.

It does not prove that every model answer is correct. The user must review facts, tone, consent, and appropriateness before sending.

## Data boundary

ChatHelp does not sign in to LinkedIn, store LinkedIn credentials, scrape an account, monitor background tabs, or send messages. The temporary profile URL is held only in the open wizard. Selected text and OCR output are stored in the encrypted local vault; generated drafts stay in the browser. The first model use downloads pinned model files, so the model host receives ordinary network metadata but not the prompt.
