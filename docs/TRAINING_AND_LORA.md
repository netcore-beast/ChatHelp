# DialogMint training and LoRA boundary

DialogMint personal learning is retrieval-based. Enabling it does not fine-tune Claude, Workers AI, or a browser model. The application selects at most three explicitly approved examples from the encrypted local workspace and supplies them as lower-priority, untrusted context for a future draft.

## What trains inside DialogMint

Only the narrow relationship-stage classifier trains in the application. It uses versioned, bounded features and explicit human-confirmed labels across the eight relationship stages. It does not store raw conversation text in its training records, generate replies, call a network service, or change a contact's stage automatically. A suggestion requires a separate user action before it becomes the stored stage and another human-confirmed record.

## What is excluded

Claude outputs, hidden analysis, reviewer rewrites, provider-assisted drafts, contact identifiers, names, companies, URLs, raw messages, imported documents, unrelated notes, outcomes, credentials, recovery material, and unapproved records are excluded from generative training export.

Provider-generated or provider-assisted text may remain in encrypted draft history for ordinary workflow continuity. It is not a target for training a competing open-ended generator. A response can enter the independently authored export only after the user attests that they authored it or hold the necessary rights and explicitly marks it eligible.

## Export files

Settings provides three separate, user-initiated downloads:

- a manifest with counts, stage grouping, exclusions, and `uploadAllowed: false`;
- classifier JSONL containing bounded features and human-confirmed stage labels;
- independently user-authored generative JSONL containing only approved role/stage/goal and response examples.

Downloads are constructed in the browser. Downloading does not upload data or start training.

## Local/open-weight training

Training an open-weight conversation model remains an external, user-controlled experiment. Before doing so, the dataset must be independently reviewed for ownership, licensing, privacy, balance, quality, and evaluation coverage. DialogMint does not provide an automatic training runner in this release.

## Cloudflare LoRA readiness

The offline validator checks a conservative compatibility envelope:

- a reviewed, supported, non-quantized base with `model_type` of `mistral`, `gemma`, or `llama`;
- adapter rank from 1 through 32;
- exact files `adapter_config.json` and `adapter_model.safetensors` totaling less than 300 MiB;
- causal-language-model task metadata;
- explicit provenance and license information;
- separate approvals for the dataset, base model, license, cost, and Project Mission account.

The current Llama 3.1 8B Fast and GPT-OSS 120B fallback IDs are not assumed to be supported LoRA bases. They must not be selected unless a later review adds the exact base to a current supported-base allowlist.

Compatibility never authorizes upload: `uploadAllowed` is always `false` in this release. Any Cloudflare adapter upload or fine-tune requires a new explicit user approval covering the exact dataset count, base, license, expected cost, target account, and deployment boundary. Production and the `netcore.beast@gmail.com` account are outside this testing plan.
