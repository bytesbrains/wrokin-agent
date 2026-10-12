import { describe, it, expect, afterEach } from "vitest";
import readCap, { DEFAULT_CAP_KB, capBytes, capRead } from "./read-cap.mjs";
import { summarize } from "./run-pi.mjs";

const KB = 1024;
// A file of `n` lines, each `width` bytes before its newline.
const file = (n, width = 99) => Array.from({ length: n }, (_, i) => String(i + 1).padEnd(width, "x")).join("\n");
const readEvent = (text, over = {}) => ({
  type: "tool_result",
  toolName: "read",
  toolCallId: "t1",
  input: { path: "src/big.ts" },
  content: [{ type: "text", text }],
  details: undefined,
  isError: false,
  ...over,
});

describe("read-cap (#861)", () => {
  it("passes a read under the cap through untouched", () => {
    expect(capRead(readEvent(file(200)), 24 * KB)).toBeUndefined(); // 20,000 bytes
  });

  it("never caps a read that passed offset or limit", () => {
    const big = file(1000); // ~100 KB
    expect(capRead(readEvent(big, { input: { path: "a", offset: 1 } }), 24 * KB)).toBeUndefined();
    expect(capRead(readEvent(big, { input: { path: "a", limit: 2000 } }), 24 * KB)).toBeUndefined();
    expect(capRead(readEvent(big, { input: { path: "a", offset: 0 } }), 24 * KB)).toBeUndefined();
  });

  it("cuts an oversized read at a line boundary and says exactly where it stopped", () => {
    const text = file(1000); // 100-byte lines with newline: 245 fit in 24 KB
    const out = capRead(readEvent(text), 24 * KB);
    const [head, note] = out.content[0].text.split("\n\n[wrokin: ");
    // The head is whole lines of the file, from the top: an edit can only target seen text.
    expect(text.startsWith(head + "\n")).toBe(true);
    expect(head.split("\n")).toHaveLength(245);
    expect(Buffer.byteLength(head)).toBeLessThanOrEqual(24 * KB);
    expect(note).toContain("showing lines 1-245 of 1000");
    expect(note).toContain("ends at the end of line 245");
    expect(note).toContain("offset=246");
    expect(note).toContain("24 KB");
    expect(out.details.wrokinReadCap).toEqual({ cap: 24 * KB, shownLines: 245, shownBytes: Buffer.byteLength(head), totalLines: 1000, totalBytes: Buffer.byteLength(text) });
  });

  it("measures pi's own 50 KB cut by the file text, not pi's note, and reports the whole file", () => {
    const fileText = file(2000);
    const piCut = fileText.slice(0, fileText.lastIndexOf("\n", 50 * KB));
    const shownLines = piCut.split("\n").length;
    const text = `${piCut}\n\n[Showing lines 1-${shownLines} of 2000 (50.0KB limit). Use offset=${shownLines + 1} to continue.]`;
    const truncation = { content: piCut, truncated: true, truncatedBy: "bytes", totalLines: 2000, totalBytes: Buffer.byteLength(fileText), outputLines: shownLines, firstLineExceedsLimit: false };
    const out = capRead(readEvent(text, { details: { truncation } }), 24 * KB);
    expect(out.content[0].text).not.toContain("[Showing lines");
    expect(out.content[0].text).toContain("showing lines 1-245 of 2000");
    expect(out.details.truncation).toBe(truncation);
    expect(out.details.wrokinReadCap.totalBytes).toBe(Buffer.byteLength(fileText));
  });

  // The hook gets pi's flat `tool_result` event and returns { content, details }; pi merges
  // that into the result it then emits as `tool_execution_end.result` (pi 1.0.4, measured
  // live in #869). This pins the two shapes together: what capRead returns is what
  // summarize reads.
  it("round-trips into the tool_execution_end result that summarize counts (#869 review)", () => {
    const out = capRead(readEvent(file(1000)), 24 * KB);
    const end = { type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: out, isError: false };
    const s = summarize(JSON.stringify(end));
    expect(s.cappedReads).toBe(1);
    expect(s.tools.read.bytes).toBe(Buffer.byteLength(out.content[0].text));
  });

  it("leaves errors, other tools, images and a single huge line alone", () => {
    const big = file(1000);
    expect(capRead(readEvent(big, { isError: true }), 24 * KB)).toBeUndefined();
    expect(capRead(readEvent(big, { toolName: "bash" }), 24 * KB)).toBeUndefined();
    expect(capRead(readEvent(big, { toolName: "grep" }), 24 * KB)).toBeUndefined();
    expect(capRead(readEvent("", { content: [{ type: "text", text: "see image" }, { type: "image", data: "x".repeat(99 * KB), mimeType: "image/png" }] }), 24 * KB)).toBeUndefined();
    expect(capRead(readEvent("y".repeat(30 * KB)), 24 * KB)).toBeUndefined();
    expect(capRead(readEvent(big, { details: { truncation: { firstLineExceedsLimit: true } } }), 24 * KB)).toBeUndefined();
  });

  it("reads the cap from the input: KB, 0 for off, default otherwise", () => {
    expect(capBytes(undefined)).toBe(DEFAULT_CAP_KB * KB);
    expect(capBytes("")).toBe(DEFAULT_CAP_KB * KB);
    expect(capBytes("16")).toBe(16 * KB);
    expect(capBytes(" 32 ")).toBe(32 * KB);
    expect(capBytes("0")).toBe(0);
    expect(capBytes("lots")).toBe(DEFAULT_CAP_KB * KB);
    expect(capBytes("-4")).toBe(DEFAULT_CAP_KB * KB);
  });

  describe("registration", () => {
    const saved = process.env.WROKIN_READ_CAP_KB;
    afterEach(() => {
      if (saved === undefined) delete process.env.WROKIN_READ_CAP_KB;
      else process.env.WROKIN_READ_CAP_KB = saved;
    });
    const load = () => {
      const on = [];
      readCap({ on: (name, h) => on.push([name, h]) });
      return on;
    };

    it("hooks tool_result with the configured cap", () => {
      process.env.WROKIN_READ_CAP_KB = "8";
      const on = load();
      expect(on.map(([n]) => n)).toEqual(["tool_result"]);
      expect(on[0][1](readEvent(file(100))).details.wrokinReadCap.cap).toBe(8 * KB);
    });

    it("registers nothing when the cap is 0", () => {
      process.env.WROKIN_READ_CAP_KB = "0";
      expect(load()).toEqual([]);
    });
  });
});
