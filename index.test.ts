import { describe, expect, it } from "bun:test";
import {
  SERVICE_VERSION,
  NO_ANSWER,
  extractImageUrls,
  collectImageUrlsFromInput,
  resolveMimeType,
  getImageHeaders,
  fetchImageAsDataUrlSafe,
  validateImageUrlSecurity,
  parseIPv6Words,
  isPrivateOrReservedIp,
  previewUrlSafely,
  readStreamWithLimit,
  handleClientRequest,
  buildUserMessageContent,
  buildOpenAIRequestFromInput,
  buildUpstreamQuestion,
  parseAnswerPayload,
  shouldRetryWithFallbackMode,
  isImageUnsupportedError,
  getAnswerFromUpstream,
} from "./index";

describe("Service Version and Metadata", () => {
  it("should provide valid service version", () => {
    expect(SERVICE_VERSION).toBeDefined();
    expect(SERVICE_VERSION.length).toBeGreaterThan(0);
  });
});

describe("Image URL Extraction and Normalization", () => {
  it("should extract standalone image url with trailing semicolon", () => {
    const raw =
      "Question: https://p.ananas.chaoxing.com/star3/origin/339ca7147a5d90f58548c77fdecfd071.png;\n\nType: completion";
    const urls = extractImageUrls(raw);
    expect(urls).toEqual([
      "https://p.ananas.chaoxing.com/star3/origin/339ca7147a5d90f58548c77fdecfd071.png",
    ]);
  });

  it("should handle multiple urls, query params, and trailing punctuation", () => {
    const text =
      'Look at (https://example.com/a.jpg?v=1.0), and <img src="https://example.com/b.PNG;"> then https://example.com/c.webp.';
    const urls = extractImageUrls(text);
    expect(urls).toEqual([
      "https://example.com/a.jpg?v=1.0",
      "https://example.com/b.PNG",
      "https://example.com/c.webp",
    ]);
  });

  it("should return empty array when no image urls present", () => {
    const text = "What is the capital of France?";
    expect(extractImageUrls(text)).toEqual([]);
  });

  it("should collect and deduplicate urls from question and options", () => {
    const input = {
      question: "Which image matches? https://example.com/q.png",
      options: [
        "https://example.com/opt1.png;",
        "https://example.com/q.png",
        "Plain text option",
      ],
      type: "single",
    };
    const collected = collectImageUrlsFromInput(input);
    expect(collected).toEqual([
      "https://example.com/q.png",
      "https://example.com/opt1.png",
    ]);
  });
});

describe("SSRF Protection and IP Validation", () => {
  it("should detect IPv4 private, loopback, and reserved addresses", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("127.1.2.3")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.254")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("192.0.0.192")).toBe(true);
    expect(isPrivateOrReservedIp("192.0.2.1")).toBe(true);
    expect(isPrivateOrReservedIp("198.18.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("198.51.100.1")).toBe(true);
    expect(isPrivateOrReservedIp("203.0.113.1")).toBe(true);
    expect(isPrivateOrReservedIp("0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedIp("224.0.0.1")).toBe(true);
  });

  it("should detect IPv6 private, loopback, mapped, and reserved addresses", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("::")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("2002:7f00:1::")).toBe(true);
    expect(isPrivateOrReservedIp("2001:0000::1")).toBe(true);
    expect(isPrivateOrReservedIp("2001:db8::1")).toBe(true);
    expect(isPrivateOrReservedIp("64:ff9b::7f00:1")).toBe(true);
    expect(isPrivateOrReservedIp("100::1")).toBe(true);
  });

  it("should allow public IP addresses", () => {
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("1.1.1.1")).toBe(false);
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateOrReservedIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("::ffff:808:808")).toBe(false);
  });

  it("should handle bracketed IPv6 literals in validateImageUrlSecurity", async () => {
    const loopbackIpv6 = new URL("http://[::1]/pic.png");
    const checkLoopback = await validateImageUrlSecurity(loopbackIpv6);
    expect(checkLoopback.safe).toBe(false);
    expect((checkLoopback as any).reason).toBe("private_ip_resolved");

    const publicIpv6 = new URL("http://[2606:4700:4700::1111]/pic.png");
    const checkPublic = await validateImageUrlSecurity(publicIpv6);
    expect(checkPublic.safe).toBe(true);
  });

  it("should block IPv4-mapped and 6to4 literals in validateImageUrlSecurity", async () => {
    const mappedLoopback = new URL("http://[::ffff:127.0.0.1]:8443/leak.png");
    const resMapped = await validateImageUrlSecurity(mappedLoopback);
    expect(resMapped.safe).toBe(false);
    expect((resMapped as any).reason).toBe("private_ip_resolved");

    const mappedMetadata = new URL("http://[::ffff:a9fe:a9fe]/metadata");
    const resMetadata = await validateImageUrlSecurity(mappedMetadata);
    expect(resMetadata.safe).toBe(false);
    expect((resMetadata as any).reason).toBe("private_ip_resolved");

    const sixToFour = new URL("http://[2002:7f00:1::]/secret");
    const resSix = await validateImageUrlSecurity(sixToFour);
    expect(resSix.safe).toBe(false);
    expect((resSix as any).reason).toBe("private_ip_resolved");

    const mappedPublic = new URL("http://[::ffff:8.8.8.8]/public.png");
    const resPublic = await validateImageUrlSecurity(mappedPublic);
    expect(resPublic.safe).toBe(true);
  });

  it("should block disallowed protocols and ports in validateImageUrlSecurity", async () => {
    const ftpUrl = new URL("ftp://example.com/pic.png");
    const ftpCheck = await validateImageUrlSecurity(ftpUrl);
    expect(ftpCheck.safe).toBe(false);
    expect((ftpCheck as any).reason).toBe("disallowed_protocol");

    const sshPortUrl = new URL("http://8.8.8.8:22/pic.png");
    const portCheck = await validateImageUrlSecurity(sshPortUrl);
    expect(portCheck.safe).toBe(false);
    expect((portCheck as any).reason).toBe("disallowed_port");
  });

  it("should block localhost and private hostnames in validateImageUrlSecurity", async () => {
    const localhostUrl = new URL("http://localhost/test.png");
    const localhostCheck = await validateImageUrlSecurity(localhostUrl);
    expect(localhostCheck.safe).toBe(false);
    expect((localhostCheck as any).reason).toBe("private_host");

    const internalHost = new URL("http://app.internal/test.png");
    const internalCheck = await validateImageUrlSecurity(internalHost);
    expect(internalCheck.safe).toBe(false);
    expect((internalCheck as any).reason).toBe("private_host");
  });

  it("should reject SSRF attempts in fetchImageAsDataUrlSafe", async () => {
    const loopbackResult = await fetchImageAsDataUrlSafe(
      "http://127.0.0.1:8080/secret.png"
    );
    expect(loopbackResult.ok).toBe(false);
    if (!loopbackResult.ok) {
      expect(loopbackResult.reason).toBe("private_ip_resolved");
    }

    const metadataResult = await fetchImageAsDataUrlSafe(
      "http://169.254.169.254/latest/meta-data/"
    );
    expect(metadataResult.ok).toBe(false);
    if (!metadataResult.ok) {
      expect(metadataResult.reason).toBe("private_ip_resolved");
    }
  });

  it("should sanitize url logging in previewUrlSafely", () => {
    const sensitiveUrl =
      "https://example.com/image.png?token=secret123456&signature=abc";
    const preview = previewUrlSafely(sensitiveUrl);
    expect(preview.host).toBe("example.com");
    expect(preview.path).toBe("/image.png");
    expect(JSON.stringify(preview)).not.toContain("secret123456");
  });
});

describe("Image Headers and MIME", () => {
  it("should inject Chaoxing referer for chaoxing domain", () => {
    const headers = getImageHeaders(
      "https://p.ananas.chaoxing.com/star3/origin/test.png"
    );
    expect(headers["Referer"]).toBe("https://mooc1.chaoxing.com/");
    expect(headers["User-Agent"]).toBeDefined();
  });

  it("should not inject Chaoxing referer for generic domain", () => {
    const headers = getImageHeaders("https://images.example.com/sample.jpg");
    expect(headers["Referer"]).toBeUndefined();
    expect(headers["User-Agent"]).toBeDefined();
  });

  it("should resolve correct mime types from content-type header", () => {
    expect(resolveMimeType("image/png")).toBe("image/png");
    expect(resolveMimeType("image/jpeg")).toBe("image/jpeg");
    expect(resolveMimeType("image/png; charset=utf-8")).toBe("image/png");
    expect(resolveMimeType("IMAGE/WEBP")).toBe("image/webp");
  });
});

describe("Stream Size Limits and Buffer Accumulation", () => {
  it("should read stream within maxBytes", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    const result = await readStreamWithLimit(stream, 10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.buffer).toEqual(Buffer.from([1, 2, 3, 4]));
    }
  });

  it("should abort stream exceeding maxBytes", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
        controller.close();
      },
    });
    const result = await readStreamWithLimit(stream, 4);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.startsWith("stream_size_exceeded_")).toBe(true);
    }
  });
});

describe("Redirect Hops and Manual Redirection", () => {
  it("should reject redirect loop or exceeding max redirect hops", async () => {
    const originalFetch = globalThis.fetch;
    let hops = 0;
    (globalThis as any).fetch = async () => {
      hops += 1;
      return new Response(null, {
        status: 302,
        headers: { Location: `http://8.8.8.8/redirect-${hops}.png` },
      });
    };
    try {
      const result = await fetchImageAsDataUrlSafe("http://8.8.8.8/start.png");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("too_many_redirects");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Client Request Body Limits (M-A)", () => {
  it("should reject client requests with body exceeding 1MB with 413 JSON and CORS", async () => {
    const largeBody = JSON.stringify({
      question: "x".repeat(1024 * 1024 + 100),
    });
    const req = new Request("http://localhost:3000/answer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(largeBody.length),
      },
      body: largeBody,
    });

    const res = await handleClientRequest(req);
    expect(res.status).toBe(413);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const json = await res.json();
    expect(json.error).toBe("请求体过大");
  });
});

describe("Question Stability (M6) and Fallback Text", () => {
  it("should have default fallback text as 不知道", () => {
    expect(NO_ANSWER).toBe("不知道");
  });

  it("should strictly preserve the original user question regardless of model response", () => {
    const originalQuestion = "Original User Question 123";
    const modelOutput = JSON.stringify({
      question: "Rewritten or truncated question by LLM",
      answer: "B",
    });

    const parsed = parseAnswerPayload(modelOutput, originalQuestion);
    expect(parsed.payload.question).toBe(originalQuestion);
    expect(parsed.payload.answer).toBe("B");
  });

  it("should normalize empty or missing answer to current NO_ANSWER text", () => {
    const originalQuestion = "Some Question";
    const emptyOutput = JSON.stringify({
      question: originalQuestion,
      answer: "   ",
    });

    const parsed = parseAnswerPayload(emptyOutput, originalQuestion);
    expect(parsed.payload.answer).toBe(NO_ANSWER);
  });
});

describe("Retry Logic and 413 Handling (M2, M3, M-C)", () => {
  it("should trigger fallback on 413 payload too large", () => {
    expect(shouldRetryWithFallbackMode(413, "Payload Too Large")).toBe(true);
    expect(isImageUnsupportedError(413, "Request Entity Too Large")).toBe(true);
  });

  it("should not retry on 401 or 403 authentication failures", () => {
    expect(shouldRetryWithFallbackMode(401, "invalid_request_error: Invalid API key")).toBe(false);
    expect(shouldRetryWithFallbackMode(403, "invalid_request_error: Permission denied")).toBe(false);
    expect(isImageUnsupportedError(401, "invalid_request_error")).toBe(false);
    expect(isImageUnsupportedError(403, "invalid_request_error")).toBe(false);
  });

  it("should detect image rejection even in long error bodies", () => {
    const padding = "x".repeat(300);
    const longError = `${padding} Error: image_url is not supported by model.`;
    expect(isImageUnsupportedError(400, longError)).toBe(true);
    expect(shouldRetryWithFallbackMode(400, longError)).toBe(true);
  });
});

describe("OpenAI Request Body Construction", () => {
  it("should produce string content when no images are present", () => {
    const input = {
      question: "1 + 1 = ?",
      type: "completion",
    };
    const body = buildOpenAIRequestFromInput(input, [], "json") as any;
    expect(body.model).toBeDefined();
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
    expect(typeof body.messages[1].content).toBe("string");
    expect(body.messages[1].content).toContain("Question: 1 + 1 = ?");
  });

  it("should produce multimodal content array when images are present", () => {
    const input = {
      question:
        "Question: https://p.ananas.chaoxing.com/star3/origin/339ca7147a5d90f58548c77fdecfd071.png;",
      type: "completion",
    };
    const fakeDataUrl = "data:image/png;base64,iVBORw0KGgoAAA==";
    const body = buildOpenAIRequestFromInput(input, [fakeDataUrl], "json") as any;

    expect(Array.isArray(body.messages[1].content)).toBe(true);
    const content = body.messages[1].content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "text",
      text: buildUpstreamQuestion(input),
    });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: fakeDataUrl },
    });
  });

  it("should omit response_format in fallback mode", () => {
    const input = {
      question: "test question",
    };
    const body = buildOpenAIRequestFromInput(input, [], "fallback") as any;
    expect(body.response_format).toBeUndefined();
  });
});

describe("End-to-End Fallback on 413 Integration Test (M-D)", () => {
  it("should retry without images when first attempt returns 413 payload too large", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    const sentBodies: any[] = [];

    (globalThis as any).fetch = async (url: any, opts: any) => {
      const urlStr = String(url);
      if (urlStr.includes("sample-image.png")) {
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }

      callCount += 1;
      const bodyJson = JSON.parse(opts.body);
      sentBodies.push(bodyJson);

      if (callCount === 1) {
        return new Response("Payload Too Large: image size exceeds provider limit", {
          status: 413,
        });
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ question: "Sample", answer: "Success Answer" }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const input = {
        question: "Question: http://8.8.8.8/sample-image.png;\nWhat is this?",
        type: "single",
      };
      const result = await getAnswerFromUpstream(input, "test-req-413");
      expect(result.payload.answer).toBe("Success Answer");
      expect(result.mode).toBe("fallback");
      expect(callCount).toBe(2);

      const firstUserContent = sentBodies[0].messages[1].content;
      expect(Array.isArray(firstUserContent)).toBe(true);
      const hasImageInFirst = firstUserContent.some((item: any) => item.type === "image_url");
      expect(hasImageInFirst).toBe(true);

      const secondUserContent = sentBodies[1].messages[1].content;
      expect(typeof secondUserContent).toBe("string");
      expect(secondUserContent).not.toContain("data:image/");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Real Chaoxing Image Fetching", () => {
  const testFn = process.env.RUN_NETWORK_TESTS === "1" ? it : it.skip;
  testFn(
    "should download and convert chaoxing image to base64 data url safely",
    async () => {
      const testUrl =
        "https://p.ananas.chaoxing.com/star3/origin/339ca7147a5d90f58548c77fdecfd071.png";
      const result = await fetchImageAsDataUrlSafe(testUrl);
      if (result.ok) {
        expect(result.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
        expect(result.byteLength).toBeGreaterThan(100);
      } else {
        expect(["timeout", "dns_lookup_failed", "fetch_error"]).toContain(
          result.reason.split(":")[0]
        );
      }
    },
    20000
  );
});
