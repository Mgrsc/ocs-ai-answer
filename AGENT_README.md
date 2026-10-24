# Agent Operations

## Overview

- Single-entry Bun service in `index.ts`.
- Purpose: accept `POST /answer` with `{"question":"...","options"?: string[] | string,"type"?: string}` and return `{"question":"...","answer":"..."}` for OCS.
- Upstream target is an OpenAI-compatible Chat Completions endpoint defined by `OPENAI_BASE_URL`.

## Runtime Flow

1. Validate request JSON and extract `question`, optional `options`, and optional `type`.
2. Extract image URLs from `question` and `options`, fetch images with anti-leech headers (such as Chaoxing referer), convert them to Base64 Data URLs, and build the upstream user message (plain string when no images, or multimodal `image_url` parts when images exist). Then send the request in `json` mode with `response_format: { type: "json_object" }`.
3. If the provider rejects JSON mode, rejects multimodal images, or returns unusable content, retry once in `fallback` mode without `response_format` (and without images if rejected).
4. Extract content from compatible shapes:
   - `choices[0].message.content` string
   - `choices[0].message.content` part array
   - `choices[0].text`
5. Repair common output issues:
   - remove BOM
   - strip fenced code blocks
  - isolate the first complete JSON object
6. Validate the parsed payload and enforce:
   - `question` must be a string, otherwise reuse the incoming question
   - `answer` must be a non-empty string, otherwise use `NO_ANSWER` (`"不知道"`)
7. On recoverable upstream failures, return the fallback payload with HTTP 200.

## Public Interface

### `GET /` and `HEAD /` (and `GET /answer`, `HEAD /answer`)

- Health/status & OCS 5.x connection probing endpoints.
- Returns status 200 with JSON (version, status, endpoint list, active model) and CORS headers.

### `POST /answer`

- Request body:
  ```json
  {
    "question": "...",
    "options": ["..."],
    "type": "single",
    "images": ["data:image/...;base64,..."],
    "suggestion_title": "...",
    "suggestion_options": ["..."]
  }
  ```
- Success body:
  ```json
  { "question": "...", "answer": "..." }
  ```
- Client errors:
  - suspicious scanner path or blocked IP -> `403` with JSON `{ "error": "Access denied" }`
  - rapid request rate exceeding limit -> `429` with JSON `{ "error": "Too Many Requests" }` and `Retry-After` header
  - unauthorized request when `CLIENT_API_KEY` is configured -> `401` with JSON `{ "error": "未提供有效鉴权 Token" }`
  - invalid JSON body -> `400`
  - missing or empty `question` -> `400`
  - unknown endpoint path -> `404` with generic JSON `{ "error": "Not Found" }`
  - request body exceeds 16MB -> `413` with JSON `{ "error": "请求体过大" }` and CORS headers (runtime hard limit 32MB)
- Image upload limits (both direct Base64 and downloaded):
  - maximum 4 images per request
  - maximum 4MB per single image
  - maximum 8MB total image payload
  - images exceeding limits are skipped and detailed in logs

## Environment Variables

- `OPENAI_API_KEY`
  - required
  - startup fails if missing
  - all upstream requests are impossible if wrong
- `OPENAI_BASE_URL`
  - optional
  - default: `https://api.openai.com/v1/chat/completions`
  - wrong value causes transport failures or provider-specific 4xx/5xx responses
- `OPENAI_MODEL`
  - optional
  - default: `gpt-4o-mini`
  - wrong value usually causes upstream 4xx or empty provider responses
- `CLIENT_API_KEY`
  - optional
  - if set, `POST /answer` enforces `Authorization: Bearer <CLIENT_API_KEY>` or `X-API-Key: <CLIENT_API_KEY>`
  - unauthenticated requests receive `401`
- `SYSTEM_PROMPT`
  - optional
  - when unset, the service uses a built-in default prompt with OCS-oriented rules for single, multiple, and judgement questions
- `NO_ANSWER`
  - optional
  - default: `不知道`
  - custom fallback text returned in `answer` when the answer cannot be determined
- `DEBUG_REQUEST_DETAILS`
  - optional
  - default: `false`
  - when enabled, request validation logs include received top-level keys and summarized `question`, `options`, `type`, and request body previews
- `PORT`
  - optional
  - default: `3000`
- `ALLOWED_IMAGE_HOSTS`
  - optional
  - default: unset (allows any public host protected by default SSRF IP defenses)
  - optional comma-separated host patterns (e.g. `*.chaoxing.com,*.ananas.chaoxing.com`) to restrict outgoing image downloads
- `RATE_LIMIT_PER_MINUTE`
  - optional
  - default: `60`
  - maximum requests allowed per IP per minute (range: `0` to `10000`, set to `0` to disable rate limiting)
- `IP_BLOCK_DURATION_MS`
  - optional
  - default: `3600000` (1 hour)
  - duration in milliseconds to jail IPs triggering scanner traps (range: `1000` to `2592000000` = 30 days)
- `TRUST_PROXY`
  - optional
  - default: `false`
  - when true, respects `X-Forwarded-For` (rightmost hop) and `X-Real-IP` from a single trusted reverse proxy like Nginx (IPv4-mapped and canonical IPv6 addresses are strictly normalized); note: when enabling `TRUST_PROXY`, direct public access to port 3000 must be forbidden (e.g. bind `"127.0.0.1:3000:3000"` in `compose.yaml` or restrict via firewall); when false, only trusts direct socket IP addresses from Bun

## Startup And Deployment

- Local startup:
  - copy `.env.example` to `.env`
  - provide at least `OPENAI_API_KEY`, `OPENAI_MODEL`, and optionally `OPENAI_BASE_URL`
  - run `bun install`
  - run `bun run index.ts`
- Container startup:
  - keep `.env` next to `compose.yaml`
  - run `docker compose up -d`
- The service has no external state and no database dependency (IP jail and rate-limiting registries reside in process memory and reset upon restart).

## Logging

- Logs are JSON lines written with `console.log`.
- Every request gets a `requestId`.
- Key events:
  - `request_received`
  - `scanner_path_blocked`
  - `blocked_ip_rejected`
  - `rate_limit_exceeded`
  - `client_auth_failed`
  - `request_body_too_large`
  - `answer_request_validated`
  - `direct_images_processed`
  - `image_count_exceeded`
  - `image_processing_started`
  - `image_processing_completed`
  - `image_download_failed`
  - `upstream_request_started`
  - `upstream_response_received`
  - `upstream_content_extracted`
  - `upstream_attempt_failed`
  - `answer_response_ready`
- Repair visibility:
  - `repairFlags` may include `bomRemoved`, `codeFenceStripped`, `outerJsonExtracted`
- Request debug visibility:
  - `answer_request_validated` always logs `receivedKeys`
  - when `DEBUG_REQUEST_DETAILS=true`, it also logs `requestBodyPreview`
  - `optionsSummary` and `typeSummary` help confirm whether OCS sent `options` or `type`

## Failure Model

- Upstream formatting failure: degrade to `{ question, answer: NO_ANSWER }`
- Upstream transport failure: degrade to `{ question, answer: NO_ANSWER }`
- Invalid client request: return `400`
- Image download security: private and loopback IPs are blocked prior to outbound connection. Note that DNS rebinding (TOCTOU between pre-check lookup and fetch) is a recognized platform limitation in high-level fetch runtimes without socket pinning.

## Troubleshooting

- Repeated `upstream_http_error` in `json` mode:
  - check whether the provider rejects `response_format`
  - confirm the fallback attempt is being logged
- Repeated `transport_error`:
  - verify `OPENAI_BASE_URL`, DNS reachability, TLS, and proxy settings
- Repeated degraded responses with valid upstream 200:
  - inspect `rawPreview`, `finishReason`, and `repairFlags`
  - common causes are truncated completions, fenced JSON, or extra prose
- Empty or missing answer values:
  - this is normalized to `NO_ANSWER` (`"不知道"`) by design

## Test Strategy

- Automated tests run via `bun test` and type checks via `bun run typecheck`.
- Test suite in `index.test.ts` covers:
  - valid and malformed JSON repair
  - SSRF private IP, loopback, link-local, cloud metadata, and IPv6 mapped addresses blocking
  - manual redirect hops and security checks
  - stream size limits and client request body limits (413)
  - retry without images on 413 or multimodal rejection
  - question text fidelity preserving original request text
  - OpenAI multimodal message construction

## File Responsibility

- `index.ts`
  - HTTP routing
  - request validation
  - upstream request building
  - upstream response extraction and repair
  - logging
- `.env.example`
  - runtime configuration reference
- `README.md`
  - English user-facing quickstart
- `README.zh-CN.md`
  - Simplified Chinese user-facing quickstart
- `dev-file/design/`
  - implementation design records

## Validation Notes

- Validated via `bun test` (65 tests: 64 offline unit/integration passing in ~215ms + 1 network test gated by `RUN_NETWORK_TESTS=1`) and `bun run typecheck` (`tsc --noEmit`, 0 errors).
