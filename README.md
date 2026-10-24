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
- Dockerfile and Docker Compose deployment support.

## Quickstart

### Prerequisites

1. Install Bun 1.1 or later.
2. Copy `.env.example` to `.env`.
3. Set at least:
   - `OPENAI_API_KEY`
   - `OPENAI_BASE_URL` if you use a proxy or gateway
   - `OPENAI_MODEL`

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
- If `SYSTEM_PROMPT` is not provided, the service uses a built-in default prompt that enforces OCS-friendly single-choice, multiple-choice, and judgement answer formatting.
- The service does not send `max_tokens`, `temperature`, or similar sampling controls.
- Set `DEBUG_REQUEST_DETAILS=true` to log incoming request keys plus summarized `question`, `options`, and `type` values when checking what OCS actually sent.
- `POST /answer` accepts optional `options`, `type`, `images`, and `suggestion_title` fields and injects them into the upstream prompt.
- Recoverable upstream failures degrade to a valid answer payload with `"不知道"`.

## Help

Open an issue in the repository if you need a new compatibility path for a specific upstream provider.
