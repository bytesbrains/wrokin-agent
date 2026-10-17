// A pi extension (#862): reversible compression of tool output, keyed by content hash.
//
// The handler is intentionally narrow: it only touches `bash`, `grep` and `find` output,
// never `read` or `edit`, and returns the original on demand through `retrieve`.
import { createHash } from "node:crypto";

export const COMPRESS_VERSION = 1;
const COMPRESSIBLE_TOOLS = new Set(["bash", "grep", "find"]);

/** The action input is a real bool-like switch, with empty meaning "on". */
export function compressEnabled(value = process.env.WROKIN_COMPRESS_TOOL_OUTPUT) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "no", "off"].includes(raw);
}

export function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function asTextBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function maybeJson(text) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return text;
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function compactJsonText(text) {
  const compact = maybeJson(text);
  if (!compact || compact.length >= text.length) return null;
  return compact;
}

function normalizeLines(text) {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function foldRepeatedLines(lines) {
  const out = [];
  let prev = null;
  let prevCount = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (prev !== null) {
        out.push(prevCount > 1 ? `${prev} ×${prevCount}` : prev);
        prev = null;
        prevCount = 0;
      }
      continue;
    }
    if (prev === line) {
      prevCount++;
      continue;
    }
    if (prev !== null) {
      out.push(prevCount > 1 ? `${prev} ×${prevCount}` : prev);
    }
    prev = line;
    prevCount = 1;
  }
  if (prev !== null) out.push(prevCount > 1 ? `${prev} ×${prevCount}` : prev);
  return out;
}

function normalizeStore(store) {
  if (store && typeof store === "object" && store.store instanceof Map) return store;
  if (store instanceof Map) return { store, set: (text) => { const id = hashText(text); store.set(id, text); return id; } };
  return toolResultStore();
}

export function compressText(text, idPrefix = null) {
  const raw = String(text ?? "");
  if (!raw) return null;
  const compactJson = compactJsonText(raw);
  if (compactJson && compactJson.length < raw.length) {
    const id = idPrefix ?? hashText(raw);
    const marker = `[wrokin: compressed output — retrieve id=${id} for the full text]`;
    return { text: `${compactJson}\n\n${marker}`, id, marker, retained: true };
  }

  const lines = normalizeLines(raw);
  if (lines.length <= 1 && raw.length < 512) return null;

  const folded = foldRepeatedLines(lines).filter((line) => line.length > 0);
  const keep = 20;
  if (folded.length <= 40) {
    const joined = folded.join("\n");
    if (joined.length >= raw.length) return null;
    const id = idPrefix ?? hashText(raw);
    const marker = `[wrokin: compressed output — retrieve id=${id} for the full text]`;
    return { text: `${joined}\n\n${marker}`, id, marker, retained: true };
  }

  const chosen = [...folded.slice(0, keep), ...folded.slice(-10)];
  const id = idPrefix ?? hashText(raw);
  const marker = `[wrokin: ${folded.length - chosen.length} similar lines omitted — retrieve id=${id} for the full text]`;
  const output = `${chosen.join("\n")}\n\n${marker}`;
  return { text: output, id, marker, retained: true };
}

export function toolResultStore() {
  const store = new Map();
  const set = (text) => {
    const id = hashText(text);
    store.set(id, text);
    return id;
  };
  return { store, set };
}

export function compressToolResult(event, store = toolResultStore()) {
  if (!event || !event.toolName || !COMPRESSIBLE_TOOLS.has(event.toolName) || event.isError) return undefined;
  if (event.toolName === "read" || event.toolName === "edit") return undefined;
  const text = asTextBlocks(event.content);
  if (!text) return undefined;
  const original = text;
  const state = normalizeStore(store);
  const id = state.set(original);
  const result = compressText(original, id);
  if (!result || !result.text || result.text.length >= original.length) return undefined;
  state.store.set(id, original);
  return {
    content: [{ type: "text", text: result.text }],
    details: {
      ...(event.details ?? {}),
      wrokinCompression: { version: COMPRESS_VERSION, id, originalBytes: Buffer.byteLength(original, "utf8"), compressedBytes: Buffer.byteLength(result.text, "utf8") },
    },
  };
}

function exactLineSlice(text, startLine, limitLines) {
  const lineMatches = [...text.matchAll(/[^\r\n]*(?:\r\n|\n|$)/g)];
  if (lineMatches.length === 0) return "";
  const start = Math.max(0, Number(startLine) || 0);
  const end = Number.isFinite(Number(limitLines)) && Number(limitLines) > 0 ? start + Number(limitLines) : lineMatches.length;
  return lineMatches.slice(start, end).map((match) => match[0]).join("");
}

export function retrieveText(store, id, offset = 0, limit = Number.POSITIVE_INFINITY) {
  const map = store && typeof store === "object" && store.store instanceof Map ? store.store : store;
  const text = typeof id === "string" ? map.get(id) : undefined;
  if (typeof text !== "string") return { error: "Unknown retrieve id `" + String(id) + "`.", ok: false };
  const limitValue = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : Number.POSITIVE_INFINITY;
  return { ok: true, text: exactLineSlice(text, offset, limitValue) };
}

export function retrieveToolFactory(store) {
  return {
    name: "retrieve",
    label: "Retrieve original tool output",
    description: "Return the stored original output for a compressed tool result, or a requested line range.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_id, params) {
      const state = normalizeStore(store);
      const r = retrieveText(state.store, params.id, params.offset ?? 0, params.limit ?? Number.POSITIVE_INFINITY);
      if (!r.ok) {
        return { content: [{ type: "text", text: r.error }], isError: true, details: {} };
      }
      return { content: [{ type: "text", text: r.text }], details: { id: params.id, offset: params.offset ?? 0 } };
    },
  };
}

export default function compressOutput(pi) {
  const enabled = compressEnabled();
  if (!enabled) return;
  const state = toolResultStore();
  pi.on("tool_result", (event) => compressToolResult(event, state));
  pi.registerTool(retrieveToolFactory(state));
}
