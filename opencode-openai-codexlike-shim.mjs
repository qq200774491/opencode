/**
 * OpenAI Codex-like request shim for OpenCode.
 *
 * Goal: Make OpenCode's OpenAI Responses requests closer to Codex CLI, to avoid
 * rs_* item-id based continuation errors on CX/CCH gateways.
 *
 * This plugin patches `globalThis.fetch` (once) and only rewrites OpenAI Responses
 * requests (POST to a path ending with `/responses`) whose JSON payload targets a GPT model.
 *
 * - Force `store: false` (Codex default for non-Azure).
 * - Strip `id` fields from `input` items (Codex doesn't serialize ids by default).
 * - Add `conversation_id`/`session_id` headers (Codex sets both to the same value).
 * - Ensure Authorization header is present (reads from `~/.local/share/opencode/auth.json`).
 *
 * Debug: set `OPENCODE_OPENAI_CODEXLIKE_DEBUG=1`.
 *
 * @type {import("@opencode-ai/plugin").Plugin}
 */
export default async function openaiCodexLikeShim() {
  const debug = process?.env?.OPENCODE_OPENAI_CODEXLIKE_DEBUG === "1"
  const stripCacheKey =
    process?.env?.OPENCODE_OPENAI_CODEXLIKE_STRIP_CACHE_KEY === "1"
  const enableToolRealityOverlay =
    (process?.env?.OPENCODE_OPENAI_CODEXLIKE_TOOL_REALITY_OVERLAY ?? "1") !== "0"
  const toolRealityMaxToolNames = Number.parseInt(
    process?.env?.OPENCODE_OPENAI_CODEXLIKE_TOOL_REALITY_MAX_TOOLS ?? "60",
    10,
  )
  const baseInstructionsSymbol = Symbol.for(
    "opencode.openai.codex.base_instructions.gpt-5.2",
  )
  const toolRealityMarker = "<runtime_tool_notice>"
  /** @type {Map<string, { injected: boolean; strike: number }>} */
  const toolRealityByConversation = new Map()

  const log = (...args) => {
    if (!debug) return
    // eslint-disable-next-line no-console
    console.warn("[openai-codexlike]", ...args)
  }

  const logFile = process?.env?.OPENCODE_OPENAI_CODEXLIKE_LOG_FILE
  const fileLog = async (category, data) => {
    if (!debug || !logFile) return
    try {
      const { appendFile } = await import("node:fs/promises")
      const timestamp = new Date().toISOString()
      const line = JSON.stringify({ timestamp, category, ...data }) + "\n"
      await appendFile(logFile, line)
    } catch {
      // ignore
    }
  }

  const marker = Symbol.for("opencode.openai.codexlike.fetchpatched")
  if (globalThis[marker]) return {}

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== "function") return {}

  const codexConversationID =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `oc_${Math.random().toString(16).slice(2)}`

  /** @type {string | undefined} */
  let openaiApiKey
  try {
    const { readFile } = await import("node:fs/promises")
    const dataHome = process?.env?.XDG_DATA_HOME || `${process?.env?.HOME}/.local/share`
    const authPath = `${dataHome}/opencode/auth.json`
    const authJson = JSON.parse(await readFile(authPath, "utf8"))
    if (authJson?.openai?.type === "api" && typeof authJson.openai.key === "string") {
      openaiApiKey = authJson.openai.key
    }
  } catch {
    // ignore
  }

  /**
   * @param {Request | URL | string} input
   * @returns {URL | null}
   */
  function parseRequestUrl(input) {
    try {
      if (input instanceof Request) return new URL(input.url)
      if (input instanceof URL) return new URL(input.toString())
      if (typeof input === "string") return new URL(input)
      return null
    } catch {
      return null
    }
  }

  /**
   * @param {Request | null} request
   * @param {RequestInit["headers"]} initHeaders
   * @returns {Headers}
   */
  function mergeHeaders(request, initHeaders) {
    const headers = new Headers()

    if (request instanceof Request) {
      request.headers.forEach((v, k) => headers.set(k, v))
    }

    if (!initHeaders) return headers

    if (initHeaders instanceof Headers) {
      initHeaders.forEach((v, k) => headers.set(k, v))
    } else if (Array.isArray(initHeaders)) {
      for (const [k, v] of initHeaders) {
        if (v !== undefined) headers.set(k, String(v))
      }
    } else {
      for (const [k, v] of Object.entries(initHeaders)) {
        if (v !== undefined) headers.set(k, String(v))
      }
    }

    return headers
  }

  /**
   * @param {unknown} body
   * @returns {string | null}
   */
  function decodeBodyToString(body) {
    if (typeof body === "string") return body
    if (body instanceof Uint8Array) return new TextDecoder().decode(body)
    if (body instanceof ArrayBuffer)
      return new TextDecoder().decode(new Uint8Array(body))
    if (ArrayBuffer.isView(body)) {
      return new TextDecoder().decode(
        new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      )
    }
    return null
  }

  /**
   * @param {Request | URL | string} input
   * @param {RequestInit | undefined} init
   * @returns {Promise<string | null>}
   */
  async function readBodyText(input, init) {
    const fromInit = decodeBodyToString(init?.body)
    if (fromInit != null) return fromInit

    if (input instanceof Request) {
      try {
        return await input.clone().text()
      } catch {
        return null
      }
    }

    return null
  }

  /**
   * @param {any} payload
   * @returns {string[]}
   */
  function extractToolNamesFromPayload(payload) {
    if (!payload || typeof payload !== "object") return []
    const tools = payload.tools
    if (!Array.isArray(tools)) return []

    /** @type {string[]} */
    const names = []
    for (const tool of tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue
      if (typeof tool.name === "string" && tool.name.trim().length > 0) {
        names.push(tool.name.trim())
        continue
      }
      const fn = tool.function
      if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
        const n = fn.name.trim()
        if (n.length > 0) names.push(n)
      }
    }

    const deduped = [...new Set(names)]
    deduped.sort()
    return deduped
  }

  /**
   * @param {string[]} toolNames
   * @param {string | undefined} attemptedTool
   * @returns {string[]}
   */
  function suggestToolAlternatives(toolNames, attemptedTool) {
    if (!Array.isArray(toolNames) || toolNames.length === 0) return []
    const q = typeof attemptedTool === "string" ? attemptedTool.toLowerCase() : ""

    // Direct Codex CLI tool → OpenCode tool mappings
    const codexToolMappings = {
      "apply_patch": [/mcp_edit/i, /mcp_write/i, /edit/i, /write/i],
      "update_plan": [/mcp_todowrite/i, /todowrite/i, /todo/i],
      "local_shell": [/mcp_bash/i, /bash/i, /shell/i],
      "read_file": [/mcp_read/i, /read/i],
      "write_file": [/mcp_write/i, /write/i],
      "list_dir": [/mcp_glob/i, /glob/i, /list_dir/i],
    }

    // Check for direct Codex tool mapping first
    for (const [codexTool, patterns] of Object.entries(codexToolMappings)) {
      if (q === codexTool || q.includes(codexTool)) {
        const matches = toolNames.filter((name) => patterns.some((p) => p.test(name)))
        if (matches.length > 0) return matches.slice(0, 8)
      }
    }

    /** @type {RegExp[]} */
    const patterns = []
    if (/shell|bash|cmd|terminal|exec|run|local_shell/.test(q)) patterns.push(/bash|shell|cmd|terminal|local_shell/i)
    if (/read|cat|open|file/.test(q)) patterns.push(/read|file|cat|open/i)
    if (/write|edit|patch|apply/.test(q)) patterns.push(/write|edit|patch|apply/i)
    if (/search|web|browse|fetch|http/.test(q)) patterns.push(/web|search|fetch|grok/i)
    if (/grep|find|ripgrep|rg|pattern/.test(q)) patterns.push(/grep|rg|pattern|search/i)
    if (/idea|lsp|typecheck|diagnostic|problem/.test(q)) patterns.push(/idea|lsp|typecheck|problem|diagnostic/i)
    if (/plan|todo|task/.test(q)) patterns.push(/todo|plan|task/i)

    if (patterns.length === 0) return []

    const candidates = toolNames.filter((name) => patterns.some((p) => p.test(name)))
    return candidates.slice(0, 8)
  }

  /**
   * @param {any} payload
   * @param {string} markerText
   * @returns {boolean}
   */
  function payloadHasMarker(payload, markerText) {
    if (!payload || typeof payload !== "object") return false
    if (!Array.isArray(payload.input)) return false

    for (const item of payload.input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const content = item.content
      if (typeof content === "string" && content.includes(markerText)) return true
      if (typeof item.output === "string" && item.output.includes(markerText)) return true
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue
          const t = typeof block.text === "string" ? block.text : typeof block.output === "string" ? block.output : ""
          if (t.includes(markerText)) return true
        }
      }
    }
    return false
  }

  /**
   * @param {string[]} toolNames
   * @returns {{ text: string; truncated: boolean }}
   */
  function formatToolNameList(toolNames) {
    const max = Number.isFinite(toolRealityMaxToolNames) ? toolRealityMaxToolNames : 60
    if (!Array.isArray(toolNames) || toolNames.length === 0) {
      return { text: "(unavailable in payload.tools)", truncated: false }
    }
    const slice = toolNames.slice(0, Math.max(1, max))
    const more = toolNames.length - slice.length
    const suffix = more > 0 ? ` …(+${more} more)` : ""
    return { text: `${slice.join(", ")}${suffix}`, truncated: more > 0 }
  }

  /**
   * @param {object} args
   * @param {string[]} args.toolNames
   * @param {"compact" | "escalated"} args.level
   * @param {string | undefined} args.attemptedTool
   * @returns {string}
   */
  function buildToolRealityOverlay({ toolNames, level, attemptedTool }) {
    const toolList = formatToolNameList(toolNames).text
    const suggestions = suggestToolAlternatives(toolNames, attemptedTool)
    const suggestionsText =
      typeof attemptedTool === "string" && attemptedTool.trim().length > 0
        ? suggestions.length > 0
          ? `\nSuggested replacements for \`${attemptedTool}\`: ${suggestions.join(", ")}`
          : `\nNo direct replacement match for \`${attemptedTool}\`. Use only names from the tools schema.`
        : ""

    if (level === "escalated") {
      return [
        `${toolRealityMarker} severity=high`,
        "RUNTIME TOOL REALITY (OpenCode):",
        "1) OhMyOpenCode prompt is authoritative.",
        "2) Codex base `instructions` are compatibility-only and may mention tools that do not exist here.",
        "3) You MUST call tools using exact names from this request's `tools` schema. If a name isn't in the schema, treat it as unavailable.",
        suggestionsText.trimEnd(),
        `Available tools (subset): ${toolList}`,
        `</runtime_tool_notice>`,
      ]
        .filter((l) => typeof l === "string" && l.length > 0)
        .join("\n")
    }

    return [
      toolRealityMarker,
      "RUNTIME TOOL REALITY (OpenCode): Codex base `instructions` may mention non-existent tools.",
      "Tool calls MUST use exact names from this request's `tools` schema only.",
      "Codex→OpenCode mappings: apply_patch→mcp_edit/mcp_write, update_plan→mcp_todowrite, local_shell→mcp_bash",
      `Available tools (subset): ${toolList}`,
      `</runtime_tool_notice>`,
    ]
      .filter((l) => typeof l === "string" && l.length > 0)
      .join("\n")
  }

  /**
   * @param {any} payload
   * @returns {{ found: boolean; attemptedTool: string | undefined }}
   */
  function detectToolUnavailableInInput(payload) {
    if (!payload || typeof payload !== "object") return { found: false, attemptedTool: undefined }
    if (!Array.isArray(payload.input)) return { found: false, attemptedTool: undefined }

    /** @type {RegExp[]} */
    const patterns = [
      /\bunknown tool\b[^\n`"']*[`"']?([a-zA-Z0-9_.:/-]{2,})[`"']?/i,
      /\btool not found\b[^\n`"']*[`"']?([a-zA-Z0-9_.:/-]{2,})[`"']?/i,
      /\bno such tool\b[^\n`"']*[`"']?([a-zA-Z0-9_.:/-]{2,})[`"']?/i,
      /\bunrecognized tool\b[^\n`"']*[`"']?([a-zA-Z0-9_.:/-]{2,})[`"']?/i,
      /\bunknown function\b[^\n`"']*[`"']?([a-zA-Z0-9_.:/-]{2,})[`"']?/i,
      /\binvalid tool\b[^\n`"']*[`"']?([a-zA-Z0-9_.:/-]{2,})[`"']?/i,
    ]

    for (const item of payload.input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const role = typeof item.role === "string" ? item.role : ""
      const type = typeof item.type === "string" ? item.type : ""

      /** @type {string[]} */
      const candidates = []
      if (typeof item.content === "string") candidates.push(item.content)
      else if (typeof item.output === "string") candidates.push(item.output)
      else if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue
          if (typeof block.text === "string") candidates.push(block.text)
          else if (typeof block.output === "string") candidates.push(block.output)
        }
      }

      for (const contentText of candidates) {
        const isProbablyToolOutput =
          (role === "assistant" && contentText.includes("Tool output (call_id=")) ||
          role === "tool" ||
          (typeof type === "string" && type.endsWith("_call_output"))
        if (!isProbablyToolOutput) continue
        if (contentText.includes(toolRealityMarker)) continue

        for (const p of patterns) {
          const m = contentText.match(p)
          if (m) {
            const attempted = typeof m[1] === "string" ? m[1] : undefined
            return { found: true, attemptedTool: attempted }
          }
        }
      }
    }

    return { found: false, attemptedTool: undefined }
  }

  /**
   * @param {any} payload
   * @param {string[]} toolNames
   * @param {string} convKey
   * @returns {boolean}
   */
  function applyToolRealityOverlay(payload, toolNames, convKey) {
    if (!enableToolRealityOverlay) return false
    if (!payload || typeof payload !== "object") return false
    if (!Array.isArray(payload.input)) return false

    const state = toolRealityByConversation.get(convKey) ?? { injected: false, strike: 0 }
    let changed = false

    const { found: toolUnavailable, attemptedTool } = detectToolUnavailableInInput(payload)
    if (toolUnavailable) {
      state.strike = Math.min(3, state.strike + 1)
      const overlay = buildToolRealityOverlay({
        toolNames,
        level: "escalated",
        attemptedTool,
      })
      for (const item of payload.input) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue
        const role = typeof item.role === "string" ? item.role : ""
        const type = typeof item.type === "string" ? item.type : ""

        /** @type {Array<{ obj: any; key: string; text: string }>} */
        const targets = []
        if (typeof item.content === "string") targets.push({ obj: item, key: "content", text: item.content })
        else if (typeof item.output === "string") targets.push({ obj: item, key: "output", text: item.output })
        else if (Array.isArray(item.content)) {
          for (const block of item.content) {
            if (!block || typeof block !== "object" || Array.isArray(block)) continue
            if (typeof block.text === "string") targets.push({ obj: block, key: "text", text: block.text })
            else if (typeof block.output === "string") targets.push({ obj: block, key: "output", text: block.output })
          }
        }

        for (const { obj, key, text } of targets) {
          const isProbablyToolOutput =
            (role === "assistant" && text.includes("Tool output (call_id=")) ||
            role === "tool" ||
            (typeof type === "string" && type.endsWith("_call_output"))
          if (!isProbablyToolOutput) continue
          if (text.includes(toolRealityMarker)) continue

          if (
            /\bunknown tool\b|\btool not found\b|\bno such tool\b|\bunrecognized tool\b|\bunknown function\b|\binvalid tool\b/i.test(
              text,
            )
          ) {
            obj[key] = `${text}\n\n${overlay}`
            changed = true
          }
        }
      }
    }

    const alreadyInjected = payloadHasMarker(payload, toolRealityMarker)
    if (alreadyInjected) state.injected = true

    if (!state.injected) {
      const overlay = buildToolRealityOverlay({ toolNames, level: "compact", attemptedTool: undefined })
      const wantsTypedMessage = payload.input.some(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof item.type === "string",
      )
      payload.input.unshift(
        wantsTypedMessage ? { type: "message", role: "user", content: overlay } : { role: "user", content: overlay },
      )
      state.injected = true
      changed = true
    }

    toolRealityByConversation.set(convKey, state)
    return changed
  }

  /**
   * @param {any} payload
   * @returns {boolean}
   */
  function stripInputItemIds(payload) {
    if (!payload || typeof payload !== "object") return false
    if (!Array.isArray(payload.input)) return false

    let changed = false

    /**
     * @returns {boolean}
     */
    function normalizeOrphanedToolOutputs() {
      /**
       * @param {any} obj
       * @returns {string | undefined}
       */
      function getCallId(obj) {
        if (!obj || typeof obj !== "object") return undefined
        const direct =
          typeof obj.call_id === "string"
            ? obj.call_id
            : typeof obj.callId === "string"
              ? obj.callId
              : typeof obj.tool_call_id === "string"
                ? obj.tool_call_id
                : typeof obj.toolCallId === "string"
                  ? obj.toolCallId
                  : undefined
        return typeof direct === "string" && direct.length > 0 ? direct : undefined
      }

      /**
       * @param {any} obj
       * @returns {string | undefined}
       */
      function getCallIdFromIdField(obj) {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined
        const id = obj.id
        if (typeof id !== "string") return undefined
        if (!id.startsWith("call_")) return undefined
        return id
      }

      /**
       * @param {any} obj
       * @returns {string}
       */
      function getOutputText(obj) {
        const out =
          obj && typeof obj === "object" && !Array.isArray(obj)
            ? Object.prototype.hasOwnProperty.call(obj, "output")
              ? obj.output
              : obj.content
            : undefined

        let text = ""
        try {
          text =
            typeof out === "string"
              ? out
              : out == null
                ? ""
                : JSON.stringify(out)
        } catch {
          text = typeof out === "string" ? out : String(out ?? "")
        }

        // Trust OpenCode's own truncation mechanism for tool outputs
        // Removing this limit to prevent oldString mismatch in Edit tool
        return text
      }

      /**
       * @param {{ role?: unknown, type?: unknown }} referenceItem
       * @param {string} callId
       * @param {string} outputText
       * @returns {any}
       */
      function makeToolOutputMessage(referenceItem, callId, outputText) {
        const wantsTypedMessage =
          referenceItem &&
          typeof referenceItem === "object" &&
          !Array.isArray(referenceItem) &&
          typeof referenceItem.type === "string"
        if (wantsTypedMessage) {
          return {
            type: "message",
            role: "assistant",
            content: `Tool output (call_id=${callId}):\n\n${outputText}`,
          }
        }
        return {
          role: "assistant",
          content: `Tool output (call_id=${callId}):\n\n${outputText}`,
        }
      }

      /**
       * @param {any} obj
       * @returns {boolean}
       */
      function isToolOutput(obj) {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false
        const t = obj.type
        if (typeof t !== "string") return false
        return (
          t === "function_call_output" ||
          t === "tool_call_output" ||
          t === "custom_tool_call_output" ||
          t === "local_shell_call_output"
        )
      }

      /**
       * Collect call ids in a first pass so matching is order-independent.
       * @type {Set<string>}
       */
      const functionCallIds = new Set()
      /** @type {Set<string>} */
      const localShellCallIds = new Set()
      /** @type {Set<string>} */
      const customToolCallIds = new Set()

      /**
       * @param {any} obj
       * @param {"function_call" | "local_shell_call" | "custom_tool_call"} kind
       */
      function addCallId(obj, kind) {
        const fromCallId = getCallId(obj)
        const fromId = getCallIdFromIdField(obj)
        const callId = fromCallId ?? fromId
        if (!callId) return
        if (kind === "function_call") functionCallIds.add(callId)
        else if (kind === "local_shell_call") localShellCallIds.add(callId)
        else customToolCallIds.add(callId)
      }

      for (const item of payload.input) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue
        const t = item.type
        if (t === "function_call") addCallId(item, "function_call")
        else if (t === "local_shell_call") addCallId(item, "local_shell_call")
        else if (t === "custom_tool_call") addCallId(item, "custom_tool_call")

        if (Array.isArray(item.content)) {
          for (const block of item.content) {
            if (!block || typeof block !== "object" || Array.isArray(block)) continue
            const bt = block.type
            if (bt === "function_call") addCallId(block, "function_call")
            else if (bt === "local_shell_call") addCallId(block, "local_shell_call")
            else if (bt === "custom_tool_call") addCallId(block, "custom_tool_call")
          }
        }
      }

      /** @type {any[]} */
      const nextInput = []
      let localChanged = false

      for (const item of payload.input) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          nextInput.push(item)
          continue
        }

        if (Array.isArray(item.content)) {
          /** @type {any[]} */
          const nextBlocks = []
          for (const block of item.content) {
            if (!block || typeof block !== "object" || Array.isArray(block)) {
              nextBlocks.push(block)
              continue
            }

            if (isToolOutput(block)) {
              const callId = getCallId(block)
              const hasMatch =
                typeof callId === "string" &&
                callId.length > 0 &&
                (functionCallIds.has(callId) ||
                  localShellCallIds.has(callId) ||
                  customToolCallIds.has(callId))
              if (typeof callId === "string" && callId.length > 0 && !hasMatch) {
                const outputText = getOutputText(block)
                nextInput.push(makeToolOutputMessage(item, callId, outputText))
                log("rewrote orphaned tool output block", {
                  callId,
                  type: block.type,
                  outputBytes: outputText.length,
                })
                fileLog("orphaned_tool_output_block", {
                  callId,
                  type: block.type,
                  outputPreview: outputText.slice(0, 500),
                  outputBytes: outputText.length,
                })
                localChanged = true
                continue
              }
            }

            // Keep non-call ids from leaking into stateless gateways.
            if (typeof block.id === "string") {
              delete block.id
              localChanged = true
            }

            nextBlocks.push(block)
          }

          if (nextBlocks.length !== item.content.length) localChanged = true
          item.content = nextBlocks
        }

        if (isToolOutput(item)) {
          const callId = getCallId(item)
          const hasMatch =
            typeof callId === "string" &&
            callId.length > 0 &&
            (functionCallIds.has(callId) ||
              localShellCallIds.has(callId) ||
              customToolCallIds.has(callId))
          if (typeof callId === "string" && callId.length > 0 && !hasMatch) {
            const outputText = getOutputText(item)
            nextInput.push(makeToolOutputMessage(item, callId, outputText))
            log("rewrote orphaned tool output item", {
              callId,
              type: item.type,
              outputBytes: outputText.length,
            })
            fileLog("orphaned_tool_output_item", {
              callId,
              type: item.type,
              outputPreview: outputText.slice(0, 500),
              outputBytes: outputText.length,
            })
            localChanged = true
            continue
          }
        }

        // Strip all ids (stateless mode); matching uses call_id fields where available.
        if (typeof item.id === "string") {
          fileLog("stripped_item_id", { id: item.id, type: item.type, role: item.role })
          delete item.id
          localChanged = true
        }

        nextInput.push(item)
      }

      if (!localChanged) return false
      payload.input = nextInput
      return true
    }

    const beforeRefs = payload.input.length
    payload.input = payload.input.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true
      return item.type !== "item_reference"
    })
    if (payload.input.length !== beforeRefs) changed = true

    for (const item of payload.input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      if (Array.isArray(item.content)) {
        const beforeContent = item.content.length
        item.content = item.content.filter(
          (block) =>
            !block ||
            typeof block !== "object" ||
            Array.isArray(block) ||
            block.type !== "item_reference",
        )
        if (item.content.length !== beforeContent) changed = true

        for (const block of item.content) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue
          if (typeof block.id === "string") {
            delete block.id
            changed = true
          }
        }
      }
      // Strip all item ids in stateless mode.
      if (typeof item.id === "string") {
        delete item.id
        changed = true
      }
    }

    if (normalizeOrphanedToolOutputs()) changed = true

    const before = payload.input.length
    payload.input = payload.input.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true
      if (typeof item.role === "string" && Array.isArray(item.content) && item.content.length === 0) return false
      return Object.keys(item).length > 0
    })
    if (payload.input.length !== before) changed = true

    return changed
  }

  /**
   * @param {Headers} headers
   * @param {any} payload
   */
  function ensureCodexConversationHeaders(headers, payload) {
    const cacheKey =
      payload && typeof payload === "object"
        ? typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0
          ? payload.prompt_cache_key
          : typeof payload.promptCacheKey === "string" && payload.promptCacheKey.length > 0
            ? payload.promptCacheKey
            : undefined
        : undefined

    if (!headers.has("conversation_id")) {
      headers.set("conversation_id", cacheKey ?? codexConversationID)
    }
    if (!headers.has("session_id")) {
      headers.set("session_id", cacheKey ?? codexConversationID)
    }
  }

  globalThis[marker] = { originalFetch }
  globalThis.fetch = async (input, init) => {
    const requestInit = init ?? {}
    const requestUrl = parseRequestUrl(input)
    const method = String(
      requestInit.method || (input instanceof Request ? input.method : "GET"),
    ).toUpperCase()

    const requestHeaders = mergeHeaders(
      input instanceof Request ? input : null,
      requestInit.headers,
    )

    const isResponsesRequest = method === "POST" && requestUrl?.pathname.endsWith("/responses")
    if (!isResponsesRequest) {
      return originalFetch(input, init)
    }

    const bodyText = await readBodyText(input, requestInit)
    if (typeof bodyText !== "string" || bodyText.length === 0) {
      return originalFetch(input, init)
    }

    let payload
    try {
      payload = JSON.parse(bodyText)
    } catch {
      return originalFetch(input, init)
    }

    const model = payload?.model
    const isGptModel = typeof model === "string" && model.startsWith("gpt")
    if (!isGptModel) {
      return originalFetch(input, init)
    }

    /**
     * Codex-style gateways often require `instructions` and reject system messages.
     * OpenCode/AI SDK sometimes emits `/responses` requests without `instructions` (e.g. in follow-ups).
     * In strict gateways (e.g. 88code), `instructions` must be present and exact.
     *
     * @param {any} p
     * @returns {boolean}
     */
    function ensureInstructionsFromInput(p) {
      if (!p || typeof p !== "object") return false

      const existing =
        typeof p.instructions === "string" ? p.instructions.trim() : ""
      if (existing.length > 0) return false

      // If we have exact Codex base instructions available, always use it.
      const base =
        typeof globalThis?.[baseInstructionsSymbol] === "string"
          ? globalThis[baseInstructionsSymbol]
          : undefined
      if (typeof base === "string" && base.length > 0) {
        p.instructions = base
        return true
      }

      const fallback = process?.env?.OPENCODE_DEFAULT_INSTRUCTIONS ?? "."
      p.instructions = fallback
      return true
    }

    if (debug) {
      const inputHasIds = Array.isArray(payload?.input)
        ? payload.input.some(
            (item) =>
              item &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              typeof item.id === "string",
          )
        : false

      let inputContentString = 0
      let inputContentArray = 0
      let inputContentOther = 0
      let inputHasTypeField = 0
      /** @type {Array<Record<string, any>>} */
      const inputSamples = []
      if (Array.isArray(payload?.input)) {
        for (let i = 0; i < payload.input.length; i++) {
          const item = payload.input[i]
          if (!item || typeof item !== "object" || Array.isArray(item)) continue
          if (typeof item.type === "string") inputHasTypeField++

          const content = item.content
          if (typeof content === "string") inputContentString++
          else if (Array.isArray(content)) inputContentArray++
          else inputContentOther++

          if (inputSamples.length < 3) {
            const interesting =
              typeof item.id === "string" ||
              typeof item.type === "string" ||
              (content != null && typeof content !== "string")
            if (!interesting) continue
            const keys = Object.keys(item).filter((k) => k !== "content").sort()
            inputSamples.push({
              i,
              keys,
              role: typeof item.role === "string" ? item.role : undefined,
              type: typeof item.type === "string" ? item.type : undefined,
              contentType: Array.isArray(content) ? "array" : typeof content,
              hasId: typeof item.id === "string",
            })
          }
        }
      }
      log("openai /responses request", {
        url: requestUrl?.toString(),
        model,
        keys: payload && typeof payload === "object" ? Object.keys(payload).sort() : undefined,
        store: payload?.store,
        inputCount: Array.isArray(payload?.input) ? payload.input.length : undefined,
        inputHasIds,
        inputContentString,
        inputContentArray,
        inputContentOther,
        inputHasTypeField,
        inputSamples,
        hasMaxOutputTokens: Object.prototype.hasOwnProperty.call(payload, "max_output_tokens"),
        hasMaxTokens: Object.prototype.hasOwnProperty.call(payload, "max_tokens"),
        hasMaxOutputTokensAlt: Object.prototype.hasOwnProperty.call(payload, "maxOutputTokens"),
      })
    }

    if (!requestHeaders.has("authorization") && typeof openaiApiKey === "string") {
      requestHeaders.set("authorization", `Bearer ${openaiApiKey}`)
    }

    ensureCodexConversationHeaders(requestHeaders, payload)

    let changed = false
    if (payload && typeof payload === "object") {
      const convKey = requestHeaders.get("conversation_id") ?? codexConversationID
      const toolNames = extractToolNamesFromPayload(payload)
      if (applyToolRealityOverlay(payload, toolNames, convKey)) changed = true
      if (ensureInstructionsFromInput(payload)) changed = true

      if (payload.store !== false) {
        payload.store = false
        changed = true
      }

      if (Object.prototype.hasOwnProperty.call(payload, "previous_response_id")) {
        delete payload.previous_response_id
        changed = true
      }

      if (Object.prototype.hasOwnProperty.call(payload, "previousResponseId")) {
        delete payload.previousResponseId
        changed = true
      }

      if (!Object.prototype.hasOwnProperty.call(payload, "parallel_tool_calls")) {
        payload.parallel_tool_calls = false
        changed = true
      }
      if (!Object.prototype.hasOwnProperty.call(payload, "include")) {
        payload.include = ["reasoning.encrypted_content"]
        changed = true
      }
      if (Array.isArray(payload.include) && !payload.include.includes("reasoning.encrypted_content")) {
        payload.include = [...payload.include, "reasoning.encrypted_content"]
        changed = true
      }

      if (Object.prototype.hasOwnProperty.call(payload, "max_output_tokens")) {
        delete payload.max_output_tokens
        changed = true
      }
    if (Object.prototype.hasOwnProperty.call(payload, "maxOutputTokens")) {
      delete payload.maxOutputTokens
      changed = true
    }
    if (Object.prototype.hasOwnProperty.call(payload, "max_completion_tokens")) {
      delete payload.max_completion_tokens
      changed = true
    }
    if (Object.prototype.hasOwnProperty.call(payload, "maxCompletionTokens")) {
      delete payload.maxCompletionTokens
      changed = true
    }
    if (Object.prototype.hasOwnProperty.call(payload, "prompt_cache_key")) {
      if (stripCacheKey) {
        delete payload.prompt_cache_key
        changed = true
      }
    }

    if (stripInputItemIds(payload)) changed = true
  }

    if (!changed) {
      return originalFetch(input, { ...requestInit, headers: requestHeaders })
    }

    const newBody = JSON.stringify(payload)
    requestHeaders.set("content-type", "application/json")

    log("patched request", {
      url: requestUrl?.toString(),
      keys: payload && typeof payload === "object" ? Object.keys(payload).sort() : undefined,
      store: payload?.store,
      inputCount: Array.isArray(payload?.input) ? payload.input.length : undefined,
    })

    return originalFetch(requestUrl?.toString() ?? input, {
      ...requestInit,
      headers: requestHeaders,
      body: newBody,
    })
  }

  log("patched global fetch", { codexConversationID, hasKey: Boolean(openaiApiKey) })
  return {}
}
