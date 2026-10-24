import { describe, expect, it } from "bun:test";
import {
  SERVICE_VERSION,
  NO_ANSWER,
  extractImageUrls,
  collectImageUrlsFromInput,
  normalizeDirectImages,
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
  extractAuthToken,
  verifyClientToken,
  __testing,
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

  it("should correctly split adjacent urls in parentheses without swallowing each other", () => {
    const raw =
      "https://p.ananas.chaoxing.com/star3/origin/43f381df.png(https://p.ananas.chaoxing.com/star3/origin/b3f236da.png为正整数);";
    const urls = extractImageUrls(raw);
    expect(urls).toEqual([
      "https://p.ananas.chaoxing.com/star3/origin/43f381df.png",
      "https://p.ananas.chaoxing.com/star3/origin/b3f236da.png",
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
  it("should reject client requests with body exceeding 16MB with 413 JSON and CORS", async () => {
    const largeBody = JSON.stringify({
      question: "x".repeat(16 * 1024 * 1024 + 100),
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

describe("OCS 5.x Health Check and Probing", () => {
  it("should respond 200 with CORS headers to HEAD /answer with query params", async () => {
    const req = new Request("http://localhost:3000/answer?t=1710000000000", {
      method: "HEAD",
    });
    const res = await handleClientRequest(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("should respond 200 with service JSON to GET /answer with query params", async () => {
    const req = new Request("http://localhost:3000/answer?t=1710000000000", {
      method: "GET",
    });
    const res = await handleClientRequest(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const json = await res.json();
    expect(json.status).toBe("running");
    expect(json.version).toBe(SERVICE_VERSION);
  });
});

describe("OCS 5.x Image Optimization and v2 Contract", () => {
  it("should normalize valid direct images and filter invalid ones", () => {
    const sampleImages = [
      "data:image/png;base64,iVBORw0KGgoAAA==",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      "http://example.com/not-base64.png",
      12345,
    ];
    const normalized = normalizeDirectImages(sampleImages);
    expect(normalized.valid).toHaveLength(2);
    expect(normalized.invalidCount).toBe(2);
    expect(normalized.valid[0]).toBe("data:image/png;base64,iVBORw0KGgoAAA==");
  });

  it("should use suggestionTitle and suggestionOptions for upstream question when present", () => {
    const input = {
      question: "Original Question Text",
      options: ["Original Option A", "Original Option B"],
      suggestionTitle: "Question with [图片1] placeholder",
      suggestionOptions: ["Option with [图片2]", "Option B"],
      type: "single",
    };
    const prompt = buildUpstreamQuestion(input);
    expect(prompt).toContain("Question: Question with [图片1] placeholder");
    expect(prompt).toContain("Option with [图片2]");
    expect(prompt).not.toContain("Original Question Text");
  });

  it("should handle direct images in /answer and preserve original question in response", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamBody: any = null;

    (globalThis as any).fetch = async (_url: any, opts: any) => {
      upstreamBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ question: "model echoed", answer: "Direct Answer" }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const clientBody = JSON.stringify({
        question: "Client Original Question",
        suggestion_title: "Suggestion Question with [图片1]",
        images: ["data:image/png;base64,iVBORw0KGgoAAA=="],
        type: "single",
      });

      const req = new Request("http://localhost:3000/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: clientBody,
      });

      const res = await handleClientRequest(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.question).toBe("Client Original Question");
      expect(json.answer).toBe("Direct Answer");

      expect(upstreamBody).toBeDefined();
      const userMessage = upstreamBody.messages[1].content;
      expect(Array.isArray(userMessage)).toBe(true);
      expect(userMessage[0].text).toContain("Suggestion Question with [图片1]");
      expect(userMessage[1]).toEqual({
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgoAAA==" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should drop images exceeding 4MB single size or exceeding 4 images count in normalizeDirectImages", () => {
    const largeBase64 = "data:image/png;base64," + "A".repeat(5 * 1024 * 1024 * (4 / 3) + 100);
    const validSmall = "data:image/png;base64,iVBORw0KGgoAAA==";
    const emptyBase64 = "data:image/png;base64,";
    const result = normalizeDirectImages([
      largeBase64,
      emptyBase64,
      validSmall,
      validSmall,
      validSmall,
      validSmall,
      validSmall,
    ]);
    expect(result.valid).toHaveLength(4);
    expect(result.singleSizeExceededCount).toBe(1);
    expect(result.invalidCount).toBe(1);
    expect(result.countExceededCount).toBe(1);
  });

  it("should normalize stringified direct images and tolerate invalid or empty string", () => {
    const jsonArrayString = JSON.stringify([
      "data:image/png;base64,iVBORw0KGgoAAA==",
      "http://invalid.url/pic.png",
    ]);
    const parsedResult = normalizeDirectImages(jsonArrayString);
    expect(parsedResult.valid).toHaveLength(1);
    expect(parsedResult.invalidCount).toBe(1);

    const singleDataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    const singleResult = normalizeDirectImages(singleDataUrl);
    expect(singleResult.valid).toHaveLength(1);
    expect(singleResult.invalidCount).toBe(0);

    const emptyStringResult = normalizeDirectImages("");
    expect(emptyStringResult.valid).toHaveLength(0);
    expect(emptyStringResult.invalidCount).toBe(0);

    const invalidStringResult = normalizeDirectImages("not-json-and-not-data-url");
    expect(invalidStringResult.valid).toHaveLength(0);
    expect(invalidStringResult.invalidCount).toBe(1);
  });

  it("should fallback to title or suggestion_title when question is missing or empty", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ question: "echoed", answer: "Fallback Answer" }),
              },
            },
          ],
        }),
        { status: 200 }
      );

    try {
      const reqWithTitleOnly = new Request("http://localhost:3000/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Question via title field",
          options: ["A", "B"],
        }),
      });
      const res1 = await handleClientRequest(reqWithTitleOnly);
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.question).toBe("Question via title field");
      expect(json1.answer).toBe("Fallback Answer");

      const reqWithEmptyQuestionAndTitle = new Request("http://localhost:3000/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "",
          title: "Question from title when question is empty",
        }),
      });
      const res2 = await handleClientRequest(reqWithEmptyQuestionAndTitle);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.question).toBe("Question from title when question is empty");

      const reqWithSuggestionTitleOnly = new Request("http://localhost:3000/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suggestion_title: "Question purely from suggestion_title",
        }),
      });
      const res3 = await handleClientRequest(reqWithSuggestionTitleOnly);
      expect(res3.status).toBe(200);
      const json3 = await res3.json();
      expect(json3.question).toBe("Question purely from suggestion_title");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should explain image placeholder order in prompt only when placeholders and images are present", () => {
    const input = {
      question: "What is in [图片1] and [图片2]?",
      type: "single",
    };
    const reqWithImages = buildOpenAIRequestFromInput(
      input,
      ["data:image/png;base64,iVBORw0KGgoAAA=="],
      "json"
    );
    const userContentWithImages = (reqWithImages.messages as any[])[1].content;
    const textPart = userContentWithImages.find((p: any) => p.type === "text");
    expect(textPart.text).toContain(
      "The placeholders [图片1], [图片2], etc., refer to the attached images in the given order."
    );

    const reqWithoutImages = buildOpenAIRequestFromInput(input, [], "json");
    const userContentWithoutImages = (reqWithoutImages.messages as any[])[1].content;
    expect(userContentWithoutImages).not.toContain(
      "The placeholders [图片1], [图片2], etc., refer to the attached images in the given order."
    );
  });

  it("should log direct_images_processed even when all direct images are invalid or filtered", async () => {
    const originalFetch = globalThis.fetch;
    const originalConsoleLog = console.log;
    const loggedEvents: any[] = [];
    console.log = (msg: any) => {
      try {
        loggedEvents.push(JSON.parse(msg));
      } catch {}
    };

    (globalThis as any).fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ question: "echo", answer: "Valid Answer" }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const response = await handleClientRequest(
        new Request("http://localhost:3000/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: "Question with [图片1]",
            images: ["invalid_base64", "data:image/png;base64,"],
            type: "single",
          }),
        })
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.answer).toBe("Valid Answer");

      const directLog = loggedEvents.find((evt) => evt.event === "direct_images_processed");
      expect(directLog).toBeDefined();
      expect(directLog.level).toBe("WARN");
      expect(directLog.receivedCount).toBe(2);
      expect(directLog.validCount).toBe(0);
      expect(directLog.invalidCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalConsoleLog;
    }
  });

  it("should support directImages without directImagesMeta in getAnswerFromUpstream (N-1)", async () => {
    const originalFetch = globalThis.fetch;
    const originalConsoleLog = console.log;
    const loggedEvents: any[] = [];
    console.log = (msg: any) => {
      try {
        loggedEvents.push(JSON.parse(msg));
      } catch {}
    };

    let upstreamBody: any = null;
    (globalThis as any).fetch = async (_url: any, opts: any) => {
      upstreamBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ question: "echo", answer: "Direct Answer" }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const result = await getAnswerFromUpstream(
        {
          question: "Question without meta [图片1]",
          directImages: ["data:image/png;base64,iVBORw0KGgoAAA=="],
          type: "single",
        },
        "req-without-meta"
      );

      expect(result.degraded).toBe(false);
      expect(result.payload.answer).toBe("Direct Answer");

      expect(upstreamBody).toBeDefined();
      const userMessage = upstreamBody.messages[1].content;
      expect(Array.isArray(userMessage)).toBe(true);
      expect(userMessage[1]).toEqual({
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgoAAA==" },
      });

      const directLog = loggedEvents.find((evt) => evt.event === "direct_images_processed");
      expect(directLog).toBeDefined();
      expect(directLog.level).toBe("INFO");
      expect(directLog.receivedCount).toBe(1);
      expect(directLog.validCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalConsoleLog;
    }
  });

  it("should accept direct images around 1.2MB without triggering 413", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamBody: any = null;

    (globalThis as any).fetch = async (_url: any, opts: any) => {
      upstreamBody = JSON.parse(opts.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ question: "echo", answer: "Large Image Answer" }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const largeBase64Image = "data:image/png;base64," + "A".repeat(1200 * 1024);
      const clientBody = JSON.stringify({
        question: "1.2MB Image Question",
        images: [largeBase64Image],
        type: "single",
      });

      const req = new Request("http://localhost:3000/answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(clientBody.length),
        },
        body: clientBody,
      });

      const res = await handleClientRequest(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.answer).toBe("Large Image Answer");
      expect(upstreamBody).toBeDefined();
      const content = upstreamBody.messages[1].content;
      expect(Array.isArray(content)).toBe(true);
      expect(content[1].type).toBe("image_url");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Client Authentication (CLIENT_API_KEY)", () => {
  it("should extract token from Bearer authorization or X-API-Key header", () => {
    const req1 = new Request("http://localhost:3000/answer", {
      headers: { authorization: "Bearer my-secret-key" },
    });
    expect(extractAuthToken(req1)).toBe("my-secret-key");

    const req2 = new Request("http://localhost:3000/answer", {
      headers: { authorization: "raw-token-123" },
    });
    expect(extractAuthToken(req2)).toBe("raw-token-123");

    const req3 = new Request("http://localhost:3000/answer", {
      headers: { "x-api-key": "api-key-456" },
    });
    expect(extractAuthToken(req3)).toBe("api-key-456");

    const req4 = new Request("http://localhost:3000/answer");
    expect(extractAuthToken(req4)).toBeUndefined();
  });

  it("should verify token correctly with constant-time equality", () => {
    expect(verifyClientToken("secret123", "secret123")).toBe(true);
    expect(verifyClientToken("wrong", "secret123")).toBe(false);
    expect(verifyClientToken(undefined, "secret123")).toBe(false);
    expect(verifyClientToken("secret1234", "secret123")).toBe(false);
  });

  it("should reject requests without valid token when CLIENT_API_KEY is configured", async () => {
    __testing.setClientApiKey("test-client-secret");
    try {
      const unauthReq = new Request("http://localhost:3000/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Secret Question?" }),
      });
      const unauthRes = await handleClientRequest(unauthReq);
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.headers.get("access-control-allow-origin")).toBe("*");
      const unauthJson = await unauthRes.json();
      expect(unauthJson.error).toContain("Token");

      const wrongReq = new Request("http://localhost:3000/answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-password",
        },
        body: JSON.stringify({ question: "Secret Question?" }),
      });
      const wrongRes = await handleClientRequest(wrongReq);
      expect(wrongRes.status).toBe(401);
    } finally {
      __testing.setClientApiKey(process.env.CLIENT_API_KEY?.trim() || undefined);
    }
  });

  it("should allow requests with valid Bearer or X-API-Key token when CLIENT_API_KEY is configured", async () => {
    const originalFetch = globalThis.fetch;
    __testing.setClientApiKey("test-client-secret");

    (globalThis as any).fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ question: "echo", answer: "Auth Answer" }),
              },
            },
          ],
        }),
        { status: 200 }
      );
    };

    try {
      const bearerReq = new Request("http://localhost:3000/answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-client-secret",
        },
        body: JSON.stringify({ question: "Bearer Auth Question" }),
      });
      const bearerRes = await handleClientRequest(bearerReq);
      expect(bearerRes.status).toBe(200);
      const bearerJson = await bearerRes.json();
      expect(bearerJson.answer).toBe("Auth Answer");

      const apiKeyReq = new Request("http://localhost:3000/answer", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "test-client-secret",
        },
        body: JSON.stringify({ question: "API Key Auth Question" }),
      });
      const apiKeyRes = await handleClientRequest(apiKeyReq);
      expect(apiKeyRes.status).toBe(200);
      const apiKeyJson = await apiKeyRes.json();
      expect(apiKeyJson.answer).toBe("Auth Answer");
    } finally {
      globalThis.fetch = originalFetch;
      __testing.setClientApiKey(process.env.CLIENT_API_KEY?.trim() || undefined);
    }
  });

  it("should keep health-check probes accessible without token even when CLIENT_API_KEY is configured", async () => {
    __testing.setClientApiKey("test-client-secret");
    try {
      const headReq = new Request("http://localhost:3000/answer?t=123", {
        method: "HEAD",
      });
      const headRes = await handleClientRequest(headReq);
      expect(headRes.status).toBe(200);

      const getReq = new Request("http://localhost:3000/answer?t=123", {
        method: "GET",
      });
      const getRes = await handleClientRequest(getReq);
      expect(getRes.status).toBe(200);
    } finally {
      __testing.setClientApiKey(process.env.CLIENT_API_KEY?.trim() || undefined);
    }
  });
});

describe("Anti-Scanner and Abuse Defense (IP Jail, Path Traps, and Rate Limiting)", () => {
  it("should detect suspicious scanner paths correctly", () => {
    expect(__testing.isSuspiciousScannerPath("/.env")).toBe(true);
    expect(__testing.isSuspiciousScannerPath("/.env.local")).toBe(true);
    expect(__testing.isSuspiciousScannerPath("/app/.env")).toBe(true);
    expect(__testing.isSuspiciousScannerPath("/.git/config")).toBe(true);
    expect(__testing.isSuspiciousScannerPath("/wp-admin/index.php")).toBe(true);
    expect(__testing.isSuspiciousScannerPath("/phpmyadmin/")).toBe(true);
    expect(__testing.isSuspiciousScannerPath("/actuator/health")).toBe(true);
    expect(__testing.isSuspiciousScannerPath("/index.php")).toBe(true);
    expect(__testing.isSuspiciousScannerPath("/shell.sh")).toBe(true);

    expect(__testing.isSuspiciousScannerPath("/")).toBe(false);
    expect(__testing.isSuspiciousScannerPath("/answer")).toBe(false);
    expect(__testing.isSuspiciousScannerPath("/answer?t=123456")).toBe(false);
  });

  it("should block suspicious paths with 403 and automatically jail the offending IP", async () => {
    __testing.resetSecurityState();
    const attackerIp = "34.32.44.30";
    const mockServer = { requestIP: () => ({ address: attackerIp }) };

    const scanReq = new Request("http://localhost:3000/.env");
    const scanRes = await handleClientRequest(scanReq, mockServer);
    expect(scanRes.status).toBe(403);
    const scanJson = await scanRes.json();
    expect(scanJson.error).toBe("Access denied");

    const normalReq = new Request("http://localhost:3000/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Hello" }),
    });
    const normalRes = await handleClientRequest(normalReq, mockServer);
    expect(normalRes.status).toBe(403);

    const innocentServer = { requestIP: () => ({ address: "198.51.100.1" }) };
    const innocentReq = new Request("http://localhost:3000/answer?t=123", {
      method: "HEAD",
    });
    const innocentRes = await handleClientRequest(innocentReq, innocentServer);
    expect(innocentRes.status).toBe(200);

    __testing.resetSecurityState();
  });

  it("should rate limit rapid POST requests and return 429 with Retry-After header", async () => {
    __testing.resetSecurityState();
    const spamIp = "192.0.2.88";
    const now = Date.now();

    for (let i = 0; i < 3; i++) {
      const res = __testing.checkRateLimit(spamIp, now, 3);
      expect(res.allowed).toBe(true);
    }

    const exceeded = __testing.checkRateLimit(spamIp, now, 3);
    expect(exceeded.allowed).toBe(false);
    expect(exceeded.retryAfterSeconds).toBeGreaterThan(0);

    __testing.resetSecurityState();
  });

  it("should keep health probes accessible even under high frequency without triggering 429", async () => {
    __testing.resetSecurityState();
    const probeServer = { requestIP: () => ({ address: "192.0.2.99" }) };

    for (let i = 0; i < 100; i++) {
      const headReq = new Request("http://localhost:3000/answer?t=123", {
        method: "HEAD",
      });
      const headRes = await handleClientRequest(headReq, probeServer);
      expect(headRes.status).toBe(200);
    }

    __testing.resetSecurityState();
  });

  it("should bound capacity strictly with O(1) LRU eviction preventing CPU lockup", () => {
    __testing.resetSecurityState();
    const now = Date.now();

    const start = performance.now();
    for (let i = 0; i < 15000; i++) {
      __testing.checkRateLimit(`10.0.${Math.floor(i / 256)}.${i % 256}`, now);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(__testing.getTrackedIpsCount()).toBeLessThanOrEqual(10000);

    __testing.resetSecurityState();
  });

  it("should respect unforgeable socket IP and ignore client XFF headers when TRUST_PROXY is false", () => {
    const fakeHeaders = new Headers({
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "1.1.1.1",
    });
    const req = new Request("http://localhost:3000/answer", { headers: fakeHeaders });
    const mockServer = { requestIP: () => ({ address: "203.0.113.195" }) };

    const resolvedIp = __testing.getClientIp(req, mockServer);
    expect(resolvedIp).toBe("203.0.113.195");
    expect(resolvedIp).not.toBe("127.0.0.1");
  });

  it("should return generic 404 without leaking available internal paths", async () => {
    const notFoundReq = new Request("http://localhost:3000/some-random-page");
    const res = await handleClientRequest(notFoundReq);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Not Found");
    expect((json as any).availablePaths).toBeUndefined();
    expect((json as any).message).toBeUndefined();
  });

  it("should normalize IPv4-mapped IPv6 addresses and canonicalize IPv6 variants", () => {
    expect(__testing.normalizeIpAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(__testing.normalizeIpAddress("::FFFF:192.0.2.1")).toBe("192.0.2.1");
    expect(__testing.normalizeIpAddress("0:0:0:0:0:ffff:8.8.8.8")).toBe("8.8.8.8");
    expect(__testing.normalizeIpAddress("::1")).toBe("::1");
    expect(__testing.normalizeIpAddress("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(__testing.normalizeIpAddress("0000:0000:0000:0000:0000:0000:0000:0001")).toBe("::1");
    expect(__testing.normalizeIpAddress("2001:0db8:0000:0000:0000:0000:1428:57ab")).toBe("2001:db8::1428:57ab");
    expect(__testing.normalizeIpAddress("203.0.113.1")).toBe("203.0.113.1");
  });

  it("should extract trusted client IP and normalize addresses when TRUST_PROXY is true", () => {
    __testing.setTrustProxy(true);

    const multiHopHeaders = new Headers({
      "x-forwarded-for": "203.0.113.10, ::ffff:198.51.100.25",
    });
    const multiHopReq = new Request("http://localhost:3000/answer", { headers: multiHopHeaders });
    expect(__testing.getClientIp(multiHopReq)).toBe("198.51.100.25");

    const realIpHeaders = new Headers({
      "x-real-ip": "::ffff:192.0.2.55",
    });
    const realIpReq = new Request("http://localhost:3000/answer", { headers: realIpHeaders });
    expect(__testing.getClientIp(realIpReq)).toBe("192.0.2.55");

    const directReq = new Request("http://localhost:3000/answer");
    const mockServer = { requestIP: () => ({ address: "::ffff:10.0.0.1" }) };
    expect(__testing.getClientIp(directReq, mockServer)).toBe("10.0.0.1");

    __testing.setTrustProxy(false);
  });

  it("should isolate jailed IPs from rate limit eviction", () => {
    __testing.resetSecurityState();
    const now = Date.now();
    const maliciousIp = "34.32.44.30";

    __testing.blockIp(maliciousIp, now);
    expect(__testing.isIpBlocked(maliciousIp, now)).toBe(true);

    for (let i = 0; i < 15000; i++) {
      __testing.checkRateLimit(`10.1.${Math.floor(i / 256)}.${i % 256}`, now);
    }

    expect(__testing.getTrackedIpsCount()).toBeLessThanOrEqual(10000);
    expect(__testing.isIpBlocked(maliciousIp, now)).toBe(true);
    expect(__testing.getBlockedIpsCount()).toBe(1);

    __testing.resetSecurityState();
  });

  async function withRateLimit(limit: number, fn: () => Promise<void> | void) {
    __testing.resetSecurityState();
    const initialLimit = __testing.getRateLimitPerMinute();
    try {
      __testing.setRateLimitPerMinute(limit);
      await fn();
    } finally {
      __testing.setRateLimitPerMinute(initialLimit);
      __testing.resetSecurityState();
    }
  }

  it("should disable rate limiting when RATE_LIMIT_PER_MINUTE is set to 0", async () => {
    await withRateLimit(0, () => {
      const testIp = "192.0.2.100";
      const now = Date.now();
      for (let i = 0; i < 120; i++) {
        const res = __testing.checkRateLimit(testIp, now);
        expect(res.allowed).toBe(true);
      }
    });
  });

  it("should rate limit rapid requests to unknown 404 paths and return 429", async () => {
    await withRateLimit(3, async () => {
      const spamServer = { requestIP: () => ({ address: "192.0.2.77" }) };

      for (let i = 0; i < 3; i++) {
        const notFoundReq = new Request(`http://localhost:3000/random-path-${i}`);
        const res = await handleClientRequest(notFoundReq, spamServer);
        expect(res.status).toBe(404);
      }

      const exceededReq = new Request("http://localhost:3000/random-path-exceeded");
      const exceededRes = await handleClientRequest(exceededReq, spamServer);
      expect(exceededRes.status).toBe(429);
      const json = await exceededRes.json();
      expect(json.error).toBe("Too Many Requests");
      expect(exceededRes.headers.get("Retry-After")).toBeDefined();
    });
  });

  it("should return 429 with CORS headers on /answer when handleClientRequest rate limit is exceeded", async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ question: "Test", answer: "OK" }) } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    try {
      await withRateLimit(2, async () => {
        const spamServer = { requestIP: () => ({ address: "192.0.2.66" }) };

        for (let i = 0; i < 2; i++) {
          const req = new Request("http://localhost:3000/answer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: "Test" }),
          });
          const res = await handleClientRequest(req, spamServer);
          expect(res.status).toBe(200);
        }

        const blockedReq = new Request("http://localhost:3000/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: "Test" }),
        });
        const blockedRes = await handleClientRequest(blockedReq, spamServer);
        expect(blockedRes.status).toBe(429);
        expect(blockedRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(blockedRes.headers.get("Retry-After")).toBeDefined();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should parse integer within range and clamp out of range values to boundary limits or fallback", () => {
    expect(__testing.parseIntInRange("10", 60, 0, 100)).toBe(10);
    expect(__testing.parseIntInRange("0", 60, 0, 100)).toBe(0);
    expect(__testing.parseIntInRange("-1", 60, 0, 100)).toBe(0);
    expect(__testing.parseIntInRange("200", 60, 0, 100)).toBe(100);
    expect(__testing.parseIntInRange("abc", 60, 0, 100)).toBe(60);
    expect(__testing.parseIntInRange(undefined, 60, 0, 100)).toBe(60);

    expect(__testing.parseIntInRange("0", 3000, 1, 65535, "fallback")).toBe(3000);
    expect(__testing.parseIntInRange("-5", 3000, 1, 65535, "fallback")).toBe(3000);
    expect(__testing.parseIntInRange("70000", 3000, 1, 65535, "fallback")).toBe(3000);
    expect(__testing.parseIntInRange("8080", 3000, 1, 65535, "fallback")).toBe(8080);
  });

  it("should throttle scanner_path_blocked logs when client IP is Unknown", async () => {
    __testing.resetSecurityState();
    const originalConsoleLog = console.log;
    const loggedEvents: any[] = [];
    console.log = (msg: any) => {
      try {
        loggedEvents.push(JSON.parse(msg));
      } catch {}
    };

    try {
      for (let i = 0; i < 5; i++) {
        const scanReq = new Request("http://localhost:3000/.env");
        const scanRes = await handleClientRequest(scanReq);
        expect(scanRes.status).toBe(403);
      }
      const scannerLogs = loggedEvents.filter((e) => e.event === "scanner_path_blocked");
      expect(scannerLogs.length).toBe(1);
    } finally {
      console.log = originalConsoleLog;
      __testing.resetSecurityState();
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
