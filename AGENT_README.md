# Agent Operations

## Overview

- Single-entry Bun service in `index.ts`.
- Purpose: accept `POST /answer` with `{"question":"..."}` and return `{"question":"...","answer":"..."}` for OCS.
- Upstream target is an OpenAI-compatible Chat Completions endpoint defined by `OPENAI_BASE_URL`.

## Runtime Flow

1. Validate request JSON and extract `question`.
2. Send the upstream request in `json` mode with `response_format: { type: "json_object" }`.
3. If the provider rejects JSON mode or returns unusable content, retry once in `fallback` mode without `response_format`.
4. Extract content from compatible shapes:
   - `choices[0].message.content` string
   - `choices[0].message.content` part array
   - `choices[0].text`
5. Repair common output issues:
   - remove BOM
   - strip fenced code blocks
   - normalize smart quotes
   - isolate the first complete JSON object
6. Validate the parsed payload and enforce:
   - `question` must be a string, otherwise reuse the incoming question
   - `answer` must be a non-empty string, otherwise use `"无法找到答案"`
7. On recoverable upstream failures, return the fallback payload with HTTP 200.

## Public Interface

### `GET /`

- Health/status endpoint.
- Returns JSON with version, status, endpoint list, and active model.

### `POST /answer`

- Request body:
  ```json
  { "question": "..." }
  ```
- Success body:
  ```json
  { "question": "...", "answer": "..." }
  ```
- Client errors:
  - invalid JSON body -> `400`
  - missing or empty `question` -> `400`

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
- `SYSTEM_PROMPT`
  - optional
  - should stay compact and only define the output contract
- `PORT`
  - optional
  - default: `3000`

## Startup And Deployment

- Local startup:
  - copy `.env.example` to `.env`
  - provide at least `OPENAI_API_KEY`, `OPENAI_MODEL`, and optionally `OPENAI_BASE_URL`
  - run `bun install`
  - run `bun run index.ts`
- Container startup:
  - keep `.env` next to `compose.yaml`
  - run `docker compose up -d`
- The service has no external state and no database dependency.

## Logging

- Logs are JSON lines written with `console.log`.
- Every request gets a `requestId`.
- Key events:
  - `request_received`
  - `answer_request_validated`
  - `upstream_request_started`
  - `upstream_response_received`
  - `upstream_content_extracted`
  - `upstream_attempt_failed`
  - `answer_response_ready`
- Repair visibility:
  - `repairFlags` may include `bomRemoved`, `codeFenceStripped`, `smartQuotesNormalized`, `outerJsonExtracted`

## Failure Model

- Upstream formatting failure: degrade to `{ question, answer: "无法找到答案" }`
- Upstream transport failure: degrade to `{ question, answer: "无法找到答案" }`
- Invalid client request: return `400`

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
  - this is normalized to `"无法找到答案"` by design

## Test Strategy

- Primary validation is request/response behavior over HTTP.
- Cover these cases when adding or changing parsing logic:
  - valid JSON object
  - fenced JSON object
  - JSON followed by explanatory text
  - provider rejects `response_format`
  - provider returns content parts instead of a single string
  - provider returns missing or empty `answer`

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

- No code was executed during this task.
- If validation is needed later, prefer manual HTTP cases that cover:
  - valid JSON upstream output
  - fenced JSON
  - JSON plus trailing prose
  - unsupported `response_format`
  - missing `answer`
