# Optional cloud LLM roadmap

ChatHelp is local-first today. Conversation text, profiles, guidance, outcomes, and drafts remain inside the encrypted client vault. Cloud inference must remain **optional**, separately consented to, and visibly disabled by default.

## Recommendation

Start with an Azure Machine Learning managed online endpoint running a pinned open-weight communication model through a maintained vLLM-compatible container. Azure is the first choice because the initial clients are Windows and Android and Microsoft Entra ID, private endpoints, managed networking, and customer-managed keys fit that operating model. Google Vertex AI custom containers and AWS SageMaker real-time or asynchronous endpoints are valid alternatives; the privacy requirements below do not change.

This will not remain a free service at meaningful GPU concurrency. Preserve local inference as the free/private tier. Introduce cloud inference only after measured demand justifies a GPU budget, with autoscaling and a hard cost ceiling.

## Phased path

### Phase 0 — current release

- Pinned WebLLM model runs on the user's device.
- Encrypted IndexedDB vault; passphrase-derived key stays in memory.
- No ChatHelp account, prompt API, analytics, or cloud database.
- User selects and reviews context and manually sends every message.

### Phase 1 — consented pilot

- Add a disabled-by-default “Private cloud inference” setting.
- Show exactly which fields will leave the device before every first request.
- Send the minimum selected context through an authenticated gateway.
- Never send platform credentials, cookies, full inboxes, or unrelated contacts.
- Keep local mode available and make switching back immediate.

### Phase 2 — controlled scale

- Multi-region inference pools only where data-residency commitments permit.
- Queue-aware routing, per-tenant rate limits, GPU autoscaling, and overload rejection.
- Separate model/prompt versions from application releases and support fast rollback.
- Add independent penetration testing, privacy impact assessment, incident response, and deletion verification.

## Reference architecture

`client → WAF/API gateway → OIDC authentication + rate limit → content minimizer/policy gate → private inference router → vLLM GPU endpoint → ephemeral response`

Operational audit events go to a separate store and contain tenant pseudonym, model version, latency, token counts, result code, and policy decision — never prompt or response content.

## Security requirements before launch

- TLS 1.3 where available and TLS 1.2 minimum; no cleartext fallback.
- OIDC/Entra authentication, short-lived access tokens, and workload identity between services.
- Private endpoint/VNet access to inference; deny public endpoint traffic.
- Customer-managed encryption keys with rotation and least-privilege access.
- No prompt/response logging in gateways, APM, crash reports, tracing, or model servers.
- Request bodies held only in volatile memory and removed immediately after response or timeout.
- Per-tenant authorization, quotas, replay protection, and abuse controls.
- Data loss prevention before inference, with explicit user-visible redaction options.
- Region pinning, documented subprocessors, deletion SLAs, and tested incident response.
- Signed images, SBOMs, dependency scanning, model hash verification, and staged rollout.
- Red-team tests for prompt injection, cross-tenant leakage, data extraction, and denial of service.

“No content logging” must be verified in deployed infrastructure, not only stated in policy. No system can promise absolute security; the product should publish controls, limitations, audit results, and incident handling plainly.

## Capacity and cost gates

- Benchmark the chosen model with realistic context lengths and 2–3 draft generations.
- Define p95 latency and concurrent-user targets before choosing GPU size.
- Start with a small warm pool; use queues and backpressure rather than unlimited scaling.
- Consider asynchronous/scale-to-zero endpoints for non-interactive research jobs, not live chat drafting.
- Alert on cost per successful generation and enforce daily/monthly spend limits.

## Provider references

- [Azure ML managed online endpoints](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-deploy-online-endpoints?view=azureml-api-2)
- [Azure endpoint authentication](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-authenticate-online-endpoint?view=azureml-api-2)
- [Azure endpoint network isolation](https://learn.microsoft.com/en-gb/azure/machine-learning/how-to-secure-online-endpoint?view=azureml-api-2)
- [Azure customer-managed keys](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-setup-customer-managed-keys?view=azureml-api-2)
- [Vertex AI vLLM deployment](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/open-models/deploy-custom-vllm)
- [Vertex AI security controls](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/security-controls)
- [SageMaker real-time endpoints](https://docs.aws.amazon.com/sagemaker/latest/dg/realtime-endpoints-deploy-models.html)
- [SageMaker inference security](https://docs.aws.amazon.com/sagemaker/latest/dg/inference-recommendations-security.html)
