import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

function base64urlEncode(data) {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function generatePKCE() {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isProxyDebugEnabled() {
  return typeof process !== "undefined" && process.env.OPENCODE_AUTH_PROXY_DEBUG === "1";
}

function redactHeaderValue(key, value) {
  const lowerKey = key.toLowerCase();

  if (lowerKey === "authorization") {
    const scheme = value.split(" ", 1)[0] || "REDACTED";
    return `${scheme} ***`;
  }

  if (lowerKey === "x-api-key" || lowerKey.endsWith("api-key")) return "***";
  if (lowerKey === "cookie") return "***";

  return value;
}

function headersToDebugObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    out[k] = redactHeaderValue(k, v);
  }
  return out;
}

function summarizeRequestBody(body) {
  if (typeof body !== "string") {
    return body == null ? null : { type: typeof body };
  }

  try {
    const parsed = JSON.parse(body);
    const systemTexts = [];
    if (Array.isArray(parsed.system)) {
      for (const block of parsed.system) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          systemTexts.push(block.text);
        }
      }
    } else if (typeof parsed.system === "string") {
      systemTexts.push(parsed.system);
    }

	    return {
	      keys: Object.keys(parsed).sort(),
	      model: parsed.model,
	      max_tokens: parsed.max_tokens,
	      stream: parsed.stream,
	      tools_count: Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
	      messages_count: Array.isArray(parsed.messages) ? parsed.messages.length : undefined,
      system_blocks: Array.isArray(parsed.system) ? parsed.system.length : undefined,
      system_text_sha256: systemTexts.length ? sha256Hex(systemTexts.join("\n")) : undefined,
    };
  } catch {
    return { raw_length: body.length };
  }
}

function proxyDebugLog(event, payload) {
  if (!isProxyDebugEnabled()) return;
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, event, payload }) + "\n";
  const file = typeof process !== "undefined" ? process.env.OPENCODE_AUTH_PROXY_DEBUG_FILE : undefined;
  if (file) {
    try {
      appendFileSync(file, line);
      return;
    } catch {
      // fall through to stderr
    }
  }
  console.error(`[opencode-auth-proxy] ${ts} ${event} ${JSON.stringify(payload)}`);
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

async function delayMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOOL_PREFIX = "mcp_";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const OAUTH_SCOPE = "org:create_api_key user:profile user:inference";
const ANTHROPIC_BETAS = "claude-code-20250219,interleaved-thinking-2025-05-14";
const USER_AGENT = "claude-cli/2.1.4 (external, sdk-cli)";

const API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";
const AUTH_INSTRUCTIONS = "Paste the authorization code here: ";

/**
 * @param {"max" | "console"} mode
 */
async function authorize(mode) {
  const pkce = await generatePKCE();
  const host = mode === "console" ? "console.anthropic.com" : "claude.ai";
  const url = new URL(`https://${host}/oauth/authorize`);

  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);

  return { url: url.toString(), verifier: pkce.verifier };
}

/**
 * @param {string} code
 * @param {string} verifier
 */
async function exchange(code, verifier) {
  const [authCode, state] = code.split("#");
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: authCode,
      state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!result.ok) {
    return { type: "failed" };
  }

  const json = await result.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/**
 * Merge headers from various sources into a Headers object
 * @param {Request | null} request
 * @param {RequestInit["headers"]} initHeaders
 * @returns {Headers}
 */
function mergeHeaders(request, initHeaders) {
  const headers = new Headers();

  if (request instanceof Request) {
    request.headers.forEach((v, k) => headers.set(k, v));
  }

  if (!initHeaders) return headers;

  if (initHeaders instanceof Headers) {
    initHeaders.forEach((v, k) => headers.set(k, v));
  } else if (Array.isArray(initHeaders)) {
    for (const [k, v] of initHeaders) {
      if (v !== undefined) headers.set(k, String(v));
    }
  } else {
    for (const [k, v] of Object.entries(initHeaders)) {
      if (v !== undefined) headers.set(k, String(v));
    }
  }

  return headers;
}

/**
 * Prefix tool name with TOOL_PREFIX
 * @param {string | undefined} name
 * @returns {string | undefined}
 */
function prefixToolName(name) {
  return name ? `${TOOL_PREFIX}${name}` : name;
}

/**
 * Add mcp_ prefix to tool names in request body
 * @param {string} body
 * @returns {string}
 */
function prefixToolsInBody(body) {
  try {
    const parsed = JSON.parse(body);

    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((t) => ({
        ...t,
        name: prefixToolName(t.name),
      }));
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg) => {
        if (Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === "tool_use" && block.name) {
              return { ...block, name: prefixToolName(block.name) };
            }
            return block;
          });
        }
        return msg;
      });
    }

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Strip mcp_ prefix from tool names in streaming response
 * @param {ReadableStream} responseBody
 * @returns {ReadableStream}
 */
function stripToolPrefixFromStream(responseBody) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      let text = decoder.decode(value, { stream: true });
      text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
      controller.enqueue(encoder.encode(text));
    },
  });
}

/**
 * Parse URL from various input types
 * @param {RequestInfo | URL} input
 * @returns {URL | null}
 */
function parseRequestUrl(input) {
  try {
    if (typeof input === "string" || input instanceof URL) {
      return new URL(input.toString());
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
  } catch {
    // Invalid URL
  }
  return null;
}

/**
 * Get token from auth object based on type
 * @param {{ type: string, access?: string, key?: string, apiKey?: string }} auth
 * @returns {string}
 */
function getToken(auth) {
  if (auth.type === "oauth") {
    return auth.access || "";
  }
  if (auth.type === "api") {
    return auth.key || auth.apiKey || "";
  }
  return "";
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin({ client }) {
  return {
    auth: {
      provider: "anthropic",
	      async loader(getAuth, provider) {
        // Zero out cost for all modes
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          };
        }

	        return {
	          apiKey: "",
	          async fetch(input, init) {
	            const auth = await getAuth();

            // Refresh OAuth token if expired
            if (auth.type === "oauth" && (!auth.access || auth.expires < Date.now())) {
              const response = await fetch(TOKEN_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  grant_type: "refresh_token",
                  refresh_token: auth.refresh,
                  client_id: CLIENT_ID,
                }),
              });
              if (!response.ok) {
                throw new Error(`Token refresh failed: ${response.status}`);
              }
              const json = await response.json();
              await client.auth.set({
                path: { id: "anthropic" },
                body: {
                  type: "oauth",
                  refresh: json.refresh_token,
                  access: json.access_token,
                  expires: Date.now() + json.expires_in * 1000,
                },
              });
              auth.access = json.access_token;
            }

            // Prepare headers with official client signatures
            const requestInit = init ?? {};
	            const requestHeaders = mergeHeaders(
	              input instanceof Request ? input : null,
	              requestInit.headers,
	            );

	            const token = getToken(auth);
	            const authMode = (typeof process !== "undefined"
	              ? process.env.OPENCODE_ANTHROPIC_AUTH_MODE
	              : undefined) || (auth.type === "api" ? "x-api-key" : "bearer");
	            if (token && authMode === "x-api-key") {
	              requestHeaders.set("x-api-key", token);
	              requestHeaders.delete("authorization");
	            } else if (token) {
	              requestHeaders.set("authorization", `Bearer ${token}`);
	              requestHeaders.delete("x-api-key");
	            }
	            requestHeaders.set("anthropic-beta", ANTHROPIC_BETAS);
	            requestHeaders.set("user-agent", USER_AGENT);
				// --- [Annie Start] 注入官方 CLI 伪装指纹 ---
				// 这些是从成功日志  中提取的关键字段
				requestHeaders.set("x-app", "cli");
				requestHeaders.set("anthropic-dangerous-direct-browser-access", "true");
				requestHeaders.set("anthropic-version", "2023-06-01"); // 确保版本对齐
            
				// 模拟 Stainless SDK 的特征 (让它以为我们是官方 Node SDK)
				requestHeaders.set("X-Stainless-Lang", "js");
				requestHeaders.set("X-Stainless-Package-Version", "0.70.0");
				requestHeaders.set("X-Stainless-OS", "Linux"); // 或者根据你的系统填
				requestHeaders.set("X-Stainless-Arch", "x64");
				requestHeaders.set("X-Stainless-Runtime", "node");
				requestHeaders.set("X-Stainless-Runtime-Version", "v24.11.1");
				// --- [Annie End] ---

	            // Prefix tool names in request body
	            let body = requestInit.body;
	            if (body && typeof body === "string") {
	              body = prefixToolsInBody(body);
            }

            // Add beta param to messages endpoint
            let requestInput = input;
            const requestUrl = parseRequestUrl(input);
	            if (requestUrl?.pathname.endsWith("/messages") && !requestUrl.searchParams.has("beta")) {
	              requestUrl.searchParams.set("beta", "true");
	              requestInput = input instanceof Request
	                ? new Request(requestUrl.toString(), input)
	                : requestUrl;
	            }

	            proxyDebugLog("request", {
	              url: requestUrl?.toString(),
	              authMode,
	              method: requestInit.method || (input instanceof Request ? input.method : undefined),
	              headers: headersToDebugObject(requestHeaders),
	              body: summarizeRequestBody(body),
	            });

	            const maxAttempts = Math.max(
	              1,
	              Number.parseInt(
	                (typeof process !== "undefined" ? process.env.OPENCODE_AUTH_PROXY_RETRY_MAX_ATTEMPTS : undefined)
	                  || "3",
	                10,
	              ) || 3,
	            );
	            const maxDelay = Math.max(
	              0,
	              Number.parseInt(
	                (typeof process !== "undefined" ? process.env.OPENCODE_AUTH_PROXY_RETRY_MAX_DELAY_MS : undefined)
	                  || "30000",
	                10,
	              ) || 30000,
	            );

	            // Execute request (with limited 429 retry)
	            let response;
	            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
	              response = await fetch(requestInput, {
	                ...requestInit,
	                body,
	                headers: requestHeaders,
	              });

	              const retryAfter = response.headers.get("retry-after");
	              const retryAfterMs = parseRetryAfterMs(retryAfter);
	              proxyDebugLog("response", {
	                url: requestUrl?.toString(),
	                attempt,
	                status: response.status,
	                statusText: response.statusText,
	                retryAfter,
	                headers: headersToDebugObject(response.headers),
	              });

	              if (response.status !== 429 || attempt === maxAttempts) break;
	              try {
	                await response.body?.cancel();
	              } catch {
	                // ignore
	              }

	              const delay = Math.min(retryAfterMs ?? 1000 * Math.pow(2, attempt - 1), maxDelay);
	              proxyDebugLog("retry", { attempt, delayMs: delay });
	              await delayMs(delay);
	            }

	            if (isProxyDebugEnabled() && response && !response.ok) {
	              const contentType = response.headers.get("content-type") || "";
	              if (!contentType.includes("text/event-stream")) {
	                try {
	                  const text = await response.clone().text();
	                  proxyDebugLog("error_body", { contentType, preview: text.slice(0, 2000) });
	                } catch {
	                  // ignore
	                }
	              }
	            }

	            // Transform streaming response to strip tool name prefixes
	            if (response.body) {
	              return new Response(stripToolPrefixFromStream(response.body), {
	                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            }

            return response;
          },
        };
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("max");
            return {
              url,
              instructions: AUTH_INSTRUCTIONS,
              method: "code",
              callback: (code) => exchange(code, verifier),
            };
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console");
            return {
              url,
              instructions: AUTH_INSTRUCTIONS,
              method: "code",
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;

                const result = await fetch(API_KEY_URL, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${credentials.access}`,
                  },
                }).then((r) => r.json());

                return { type: "success", key: result.raw_key };
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
}
