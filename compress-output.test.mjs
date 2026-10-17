import { describe, it, expect } from "vitest";
import { compressEnabled, compressText, compressToolResult, hashText, retrieveText, retrieveToolFactory, toolResultStore } from "./compress-output.mjs";

describe("compress-output", () => {
  it("turns tool output compression off when disabled", () => {
    expect(compressEnabled("off")).toBe(false);
    expect(compressEnabled("0")).toBe(false);
    expect(compressEnabled("false")).toBe(false);
    expect(compressEnabled("on")).toBe(true);
    expect(compressEnabled("")).toBe(true);
  });

  it("reads the env default from process.env exactly as documented", () => {
    const prev = process.env.WROKIN_COMPRESS_TOOL_OUTPUT;
    delete process.env.WROKIN_COMPRESS_TOOL_OUTPUT;
    expect(compressEnabled()).toBe(true);
    process.env.WROKIN_COMPRESS_TOOL_OUTPUT = "0";
    expect(compressEnabled()).toBe(false);
    if (prev === undefined) delete process.env.WROKIN_COMPRESS_TOOL_OUTPUT;
    else process.env.WROKIN_COMPRESS_TOOL_OUTPUT = prev;
  });

  it("compresses bash output deterministically and stores the original for retrieval", () => {
    const text = [
      "status=ok",
      "status=ok",
      "status=ok",
      "user=alice",
      "user=bob",
      "user=bob",
      "user=bob",
      "x=1",
      "x=2",
      "x=3",
      "x=4",
      "x=5",
      "x=6",
      "x=7",
      "x=8",
      "x=9",
      "x=10",
      "x=11",
      "x=12",
      "x=13",
      "x=14",
      "x=15",
      "x=16",
      "x=17",
      "x=18",
      "x=19",
      "x=20",
      "x=21",
      "x=22",
      "x=23",
      "x=24",
      "x=25",
      "x=26",
      "x=27",
      "x=28",
      "x=29",
      "x=30",
      "x=31",
      "x=32",
      "x=33",
      "x=34",
      "x=35",
      "x=36",
      "x=37",
      "x=38",
      "x=39",
      "x=40",
      "x=41",
      "x=42",
      "x=43",
      "x=44",
    ].join("\n");
    const compressed = compressText(text);
    expect(compressed).not.toBeNull();
    expect(compressed.text.length).toBeLessThan(text.length);
    expect(compressed.text).toContain("retrieve id=");
    expect(compressText(text)).toEqual(compressed);
    expect(hashText(text)).toHaveLength(12);
  });

  it("does not compress read or edit output and preserves exact retrieval for bash output", async () => {
    const store = new Map();
    const bashText = `${Array.from({ length: 60 }, (_, index) => (index % 5 === 0 ? "line 1" : "line 2")).join("\n")}\n`;
    const bash = { toolName: "bash", content: [{ type: "text", text: bashText }], details: {} };
    const read = { toolName: "read", content: [{ type: "text", text: "long body" }], details: {} };
    const edit = { toolName: "edit", content: [{ type: "text", text: "updated" }], details: {} };

    expect(compressToolResult(read, store)).toBeUndefined();
    expect(compressToolResult(edit, store)).toBeUndefined();

    const out = compressToolResult(bash, store);
    expect(out).toBeDefined();
    expect(out.content[0].text).toContain("retrieve id=");
    const id = out.details.wrokinCompression.id;
    expect(store.has(id)).toBe(true);
    expect(store.get(id)).toBe(bashText);

    const recovered = retrieveText(store, id);
    expect(recovered).toMatchObject({ ok: true });
    expect(recovered.text).toBe(bashText);

    const tool = retrieveToolFactory(store);
    const result = await tool.execute("t", { id, offset: 1, limit: 2 });
    expect(result.content[0].text).toBe("line 2\nline 2\n");

    const state = toolResultStore();
    const original = "alpha\nbeta\n\ngamma\n";
    const stateId = state.set(original);
    expect(retrieveText(state.store, stateId)).toMatchObject({ ok: true, text: original });
    expect(retrieveText(state.store, stateId, 2, 2)).toMatchObject({ ok: true, text: "\ngamma\n" });
  });
});
