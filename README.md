# OCS AI Answer Service

An OpenAI-compatible answer proxy for [OCS](https://docs.ocsjs.com) question-bank integration.

## For AI Agents
See [AGENT_README.md](./AGENT_README.md) for operational context.

## Core Features

- Bun-native HTTP service with line-oriented structured logs.
- Fully adapted to OCS 5.x: native `HEAD /answer` health checks (eliminates connection failure warnings); satisfies 5.x image optimization contracts (eliminates yellow banner warnings); supports direct Base64 upload alongside fallback URL extraction.
- JSON-first upstream requests with automatic fallback when `response_format` is unsupported.
- Stable output contract: `{"question":"...","answer":"..."}`.
- Optional `options` and `type` request fields can be forwarded from OCS to improve single-choice, multiple-choice, and judgement accuracy.
- Automatic multimodal image processing: handles direct Base64 uploads and downloads question/option images with SSRF guards and anti-leech headers for vision models.
- Response repair for common malformed outputs such as fenced JSON and trailing prose.
- Graceful degradation to `"不知道"` instead of surfacing opaque upstream formatting failures to OCS.
- Built-in anti-scanner and defense engine: automatically detects suspicious paths (e.g. `/.env`, `/.git`, script extensions) and jails offending IPs; in-memory sliding-window rate limiting (default 60 req/min); generic 404 responses that conceal internal endpoint routes.
- Dockerfile and Docker Compose deployment support.

## Quickstart

### Prerequisites

1. Install Bun 1.1 or later.
2. Copy `.env.example` to `.env`.
3. Set at least:
   - `OPENAI_API_KEY`
   - `OPENAI_BASE_URL` if you use a proxy or gateway
   - `OPENAI_MODEL`
   - `CLIENT_API_KEY` (optional), if you want to prevent unauthorized usage in public deployments

### Run locally

```bash
bun install
bun run index.ts
```

The service listens on `http://localhost:3000`.

### Minimal request

```bash
curl -X POST http://localhost:3000/answer \
  -H 'Content-Type: application/json' \
  -d '{"question":"下列关于家庭表述中，不正确的是（）。","options":["A. 甲","B. 乙","C. 丙","D. 丁"],"type":"single"}'
```

Expected shape:

```json
{
  "question": "下列关于家庭表述中，不正确的是（）。",
  "answer": "不知道"
}
```

### Docker Compose

```bash
docker compose up -d
```

## OCS Configuration Example

Replace the host in `homepage` and `url` with your deployment address:

### Option 1: Recommended Configuration (Compatible with OCS 5.x Image Optimization and Legacy Fallback)

This configuration eliminates the OCS 5.x yellow warning banner and enables direct Base64 uploads while remaining compatible with older OCS versions:

```json
[
  {
    "name": "OCS-AI-ANSWER",
    "homepage": "http://your-host:3000/",
    "url": "http://your-host:3000/answer",
    "method": "post",
    "type": "GM_xmlhttpRequest",
    "contentType": "json",
    "data": {
      "question": { "handler": "return (env) => env.suggestion_title || env.title" },
      "options": { "handler": "return (env) => env.suggestion_options || env.options" },
      "type": "${type}",
      "images": { "handler": "return (env) => env.images || []" }
    },
    "headers": { "Content-Type": "application/json" },
    "handler": "return (res) => { if (res && res.question && res.answer) { return [res.question, res.answer]; } if (res && res.error) { return ['AI answer service error: ' + res.error, undefined]; } return undefined; }"
  }
]
```

### Option 2: Clean Placeholder Configuration (OCS 5.x+ Only)

If you are using OCS 5.x+ and prefer concise template strings without JavaScript handler functions:

```json
[
  {
    "name": "OCS-AI-ANSWER",
    "homepage": "http://your-host:3000/",
    "url": "http://your-host:3000/answer",
    "method": "post",
    "type": "GM_xmlhttpRequest",
    "contentType": "json",
    "data": {
      "question": "${suggestion_title}",
      "options": "${suggestion_options}",
      "type": "${type}",
      "images": "${images}"
    },
    "headers": { "Content-Type": "application/json" },
    "handler": "return (res) => { if (res && res.question && res.answer) { return [res.question, res.answer]; } if (res && res.error) { return ['AI answer service error: ' + res.error, undefined]; } return undefined; }"
  }
]
```

## Configuration Notes

- **OCS 5.x Health Check**: OCS 5.x sends `HEAD /answer?t=<timestamp>` to probe server connectivity. The service returns HTTP 200, making the card display "Connected".
- **Yellow Banner Elimination**: Once the configuration includes `${suggestion_title}` or `${images}`, the OCS 5.x warning banner stating that the question bank does not support image optimization will disappear.
- **Client Authentication (Optional)**: If `CLIENT_API_KEY` is set on the server, answer requests require authorization. Add `"Authorization": "Bearer <YOUR_CLIENT_API_KEY>"` to the `headers` field of your OCS question bank configuration. If `CLIENT_API_KEY` is unset, the service allows public access. Health-check probes (`HEAD`/`GET`) are always unauthenticated.
- If `SYSTEM_PROMPT` is not provided, the service uses a built-in default prompt that enforces OCS-friendly single-choice, multiple-choice, and judgement answer formatting.
- The service does not send `max_tokens`, `temperature`, or similar sampling controls.
- Set `DEBUG_REQUEST_DETAILS=true` to log incoming request keys plus summarized `question`, `options`, and `type` values when checking what OCS actually sent.
- `POST /answer` accepts optional `options`, `type`, `images`, and `suggestion_title` fields and injects them into the upstream prompt.
- **Security and Anti-Abuse Controls (Optional)**:
  - `RATE_LIMIT_PER_MINUTE` (default: `60`, range: `0-10000`): Throttles rapid POST requests per IP (set to `0` to disable rate limiting). Health probes (`GET`/`HEAD`) are exempt to avoid false positives.
  - `IP_BLOCK_DURATION_MS` (default: `3600000` = 1 hour, range: `1000-2592000000`): Duration in milliseconds to automatically jail offending IPs hitting honeypot scanner paths (e.g., `/.env`, `/.git`, webshell paths). Jailed IPs are stored in a dedicated memory registry isolated from rate-limit eviction.
  - `TRUST_PROXY` (default: `false`): Enable when running behind a single trusted reverse proxy (e.g. Nginx). When enabled, respects `X-Forwarded-For` (rightmost hop) and `X-Real-IP`, strictly normalizing IPv4-mapped and canonical IPv6 addresses. **Deployment Note**: Direct public access to port 3000 must be forbidden (e.g. bind `"127.0.0.1:3000:3000"` in `compose.yaml` or restrict via firewall), ensuring only the trusted proxy can connect. Recommended Nginx proxy headers:
    ```nginx
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    ```
- Recoverable upstream failures degrade to a valid answer payload with `"不知道"`.

## Help

Open an issue in the repository if you need a new compatibility path for a specific upstream provider.
