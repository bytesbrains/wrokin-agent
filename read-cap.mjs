// A pi extension (#861): a soft cap on whole-file reads.
//
// Whole-file `read`s are 95–97% of Builder tool output (bytesbrains-cruise#593), and each
// one is paid for again on every later turn. When a `read` that passed neither `offset`
// nor `limit` returns more than the cap, this keeps whole lines up to the cap and says
// exactly where it stopped, so an `edit` can only target text the agent has seen. A read
// that passed `offset` or `limit` is never capped: that is the way to get the rest.
//
// Loaded with `-e` by run-pi.mjs, inside pi, as the agent's user. Runs in pi's
// `afterToolCall`, so the capped result is what the model reads and what pi-events.jsonl
// records (#860's `read` bytes measure it). No dependencies: pi loads it as is.

export const DEFAULT_CAP_KB = 24;

/** The cap in bytes from the `read_cap_kb` input: a whole number of KB, 0 for off. */
export function capBytes(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return DEFAULT_CAP_KB * 1024;
  if (!/^\d+$/.test(raw)) return DEFAULT_CAP_KB * 1024;
  return Number(raw) * 1024;
}

const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

/**
 * The file text a `tool_result` event's whole-file `read` returned, or undefined when the
 * event is not one the cap applies to.
 *
 * pi 1.0.4's `read` returns the file's text as is (no line numbers), already cut at 50 KB
 * or 2,000 lines with a note of its own; its `details.truncation` holds the counts for the
 * whole file and the text before that note. Anything not shaped like that passes through.
 */
function wholeFileRead(event) {
  if (event?.toolName !== "read" || event.isError) return undefined;
  if (event.input?.offset != null || event.input?.limit != null) return undefined;
  const blocks = event.content;
  if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0]?.type !== "text") return undefined;
  const text = blocks[0].text;
  const t = event.details?.truncation;
  if (t?.firstLineExceedsLimit) return undefined;
  // pi's own cut: measure the file text, not its note.
  const body = t?.truncated && typeof t.content === "string" && text.startsWith(t.content) ? t.content : text;
  return { text, body, t };
}

/** The capped result for a `tool_result` event, or undefined to leave it alone. */
export function capRead(event, cap) {
  const read = cap ? wholeFileRead(event) : undefined;
  if (!read) return undefined;
  const { text, body, t } = read;
  if (Buffer.byteLength(body, "utf8") <= cap) return undefined;

  const lines = body.split("\n");
  let kept = 0;
  let bytes = 0;
  for (const line of lines) {
    const next = bytes + Buffer.byteLength(line, "utf8") + (kept ? 1 : 0);
    if (next > cap) break;
    bytes = next;
    kept++;
  }
  if (kept === 0) return undefined;

  const totalLines = Number.isInteger(t?.totalLines) ? t.totalLines : lines.length;
  const totalBytes = Number.isInteger(t?.totalBytes) ? t.totalBytes : Buffer.byteLength(text, "utf8");
  const note =
    `[wrokin: showing lines 1-${kept} of ${totalLines} (${kb(bytes)} of ${kb(totalBytes)}). ` +
    `Whole-file reads are capped at ${kb(cap)} to save context; the text above ends at the end of line ${kept}. ` +
    `Read more with offset=${kept + 1} and a limit, or grep for what you need first. ` +
    "A read that passes offset or limit is not capped.]";
  return {
    content: [{ type: "text", text: `${lines.slice(0, kept).join("\n")}\n\n${note}` }],
    details: { ...(event.details ?? {}), wrokinReadCap: { cap, shownLines: kept, shownBytes: bytes, totalLines, totalBytes } },
  };
}

export default function readCap(pi) {
  const cap = capBytes(process.env.WROKIN_READ_CAP_KB);
  if (!cap) return;
  pi.on("tool_result", (event) => capRead(event, cap));
}
