import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jcodeEvent,
  jcodeHome,
  jcodeJournalPath,
  jcodeSessionPath,
  readJcodeSessionMeta,
  readJcodeTranscript,
} from "./transcript-jcode";

/**
 * A real jcode session (v1.0.0), trimmed: tool results are cut to 160 characters, token usage and
 * environment snapshots are dropped, and the home directory and repository name are replaced.
 * Message ids, roles, block types and ordering are exactly as jcode wrote them.
 */
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "jcode",
  "session_eagle_1794927464955_439e5d418915c243.json"
);

interface Message {
  id: string;
  role: string;
  display_role?: string;
  timestamp?: string;
  content: Record<string, unknown>[];
}

const fixture = (): { messages: Message[]; working_dir: string } & Record<string, unknown> =>
  JSON.parse(readFileSync(FIXTURE, "utf8"));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hs-jcode-transcript-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const message = (
  role: string,
  content: unknown[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({ id: `message_${++seq}`, role, content, ...extra });
const text = (t: string) => ({ type: "text", text: t });

/** Write a snapshot (and optionally a journal) the way jcode lays a session out on disk. */
function writeSession(
  messages: unknown[],
  journal?: (Record<string, unknown> | string)[],
  top: Record<string, unknown> = {}
): string {
  const path = join(dir, "session_test_1_abc.json");
  writeFileSync(path, JSON.stringify({ id: "session_test_1_abc", ...top, messages }));
  if (journal) {
    writeFileSync(
      jcodeJournalPath(path),
      journal.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n"
    );
  }
  return path;
}

describe("readJcodeTranscript", () => {
  it("normalizes a real session: prose turns, tool calls as actions, nothing else", () => {
    const turns = readJcodeTranscript(FIXTURE);
    // 17 stored messages -> 10 turns: one prompt, eight tool calls, one reply.
    expect(fixture().messages).toHaveLength(17);
    expect(turns.map((t) => t.role)).toEqual([
      "user",
      "action",
      "action",
      "action",
      "action",
      "action",
      "action",
      "action",
      "action",
      "assistant",
    ]);
    expect(turns[0]).toEqual({
      role: "user",
      content: "How can I use self-dev mode? How is it intended to be used?",
      timestamp: "2026-11-17T14:58:45.589418Z",
    });
    expect(turns.slice(1, 5).map((t) => t.content)).toEqual([
      "agentgrep self-dev",
      "agentgrep self_dev",
      "load_tools",
      "jcode_docs self-dev mode",
    ]);
    // Two tool calls of one assistant message share that message's timestamp.
    expect(turns[1].timestamp).toBe(turns[2].timestamp);
    expect(turns.at(-1)!.content).toMatch(/^Self-dev mode is jcode's mechanism/);
    expect(turns.at(-1)!.timestamp).toBe("2026-11-17T14:59:27.970618Z");
  });

  it("drops tool results, reasoning and the session-context message of a real session", () => {
    const all = readJcodeTranscript(FIXTURE)
      .map((t) => t.content)
      .join("\n");
    // The first stored message is jcode's own `display_role: system` session context.
    expect(fixture().messages[0].display_role).toBe("system");
    expect(all).not.toContain("Session Context");
    // tool_result text and reasoning_trace text, both present in the stored session.
    expect(all).not.toContain("matches: 0 in 0 files");
    expect(all).not.toContain("I'm checking whether");
  });

  it("skips every display_role value", () => {
    const path = writeSession([
      message("user", [text("session context")], { display_role: "system" }),
      message("user", [text("a task finished")], { display_role: "background_task" }),
      message("user", [text("a file changed")], { display_role: "file_activity" }),
      message("assistant", [text("an alert")], { display_role: "system" }),
      message("user", [text("the real prompt")]),
    ]);
    expect(readJcodeTranscript(path).map((t) => t.content)).toEqual(["the real prompt"]);
  });

  it("drops every non-prose block type and keeps unknown ones out", () => {
    const path = writeSession([
      message("assistant", [
        { type: "reasoning", text: "r1" },
        { type: "reasoning_trace", text: "r2" },
        { type: "anthropic_thinking", thinking: "r3" },
        { type: "openai_reasoning", summary: "r4" },
        { type: "provider_native", data: { x: 1 } },
        { type: "tool_reference", tool_name: "x" },
        { type: "image", data: "…" },
        { type: "openai_compaction", data: "…" },
        { type: "something_new", text: "r5" },
        text("the answer"),
      ]),
      message("user", [{ type: "tool_result", tool_use_id: "t1", content: "output" }]),
      message("tool", [text("not a conversation role")]),
    ]);
    expect(readJcodeTranscript(path)).toEqual([{ role: "assistant", content: "the answer" }]);
  });

  it("joins a message's text blocks and puts its tool calls after the prose", () => {
    const path = writeSession([
      message(
        "assistant",
        [
          { type: "tool_use", id: "t1", name: "read", input: { file_path: "/repo/a.ts" } },
          text("First."),
          text("  "),
          text("Second."),
        ],
        { timestamp: "2026-11-17T10:00:00Z" }
      ),
    ]);
    expect(readJcodeTranscript(path)).toEqual([
      { role: "assistant", content: "First.\nSecond.", timestamp: "2026-11-17T10:00:00Z" },
      { role: "action", content: "read /repo/a.ts", timestamp: "2026-11-17T10:00:00Z" },
    ]);
  });

  it("unrolls batch into its inner calls and names the files an apply_patch touches", () => {
    const path = writeSession([
      message("assistant", [
        {
          type: "tool_use",
          id: "t1",
          name: "batch",
          input: {
            intent: "look around",
            tool_calls: [
              { tool: "read", intent: "x", file_path: "/repo/a.ts" },
              { tool: "bash", intent: "y", command: "npm test" },
              "not a call",
            ],
          },
        },
        {
          type: "tool_use",
          id: "t2",
          name: "apply_patch",
          input: {
            patch_text:
              "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch",
          },
        },
        { type: "tool_use", id: "t3", name: "batch", input: { tool_calls: [] } },
      ]),
    ]);
    expect(readJcodeTranscript(path).map((t) => t.content)).toEqual([
      "read /repo/a.ts",
      "bash npm test",
      "apply_patch src/a.ts src/b.ts",
      "batch",
    ]);
  });

  it("replays the journal over the snapshot, in order", () => {
    const a = message("user", [text("one")]);
    const b = message("assistant", [text("two")]);
    const c = message("user", [text("three")]);
    const d = message("assistant", [text("four")]);
    const path = writeSession(
      [a, b],
      [
        { meta: { status: "Active" }, append_messages: [c] },
        { meta: { status: "Active" } },
        { meta: { status: "Active" }, append_messages: [d] },
      ]
    );
    expect(readJcodeTranscript(path).map((t) => t.content)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });

  it("reads all 67 messages of a session whose snapshot holds only 2", () => {
    // The shape measured on a live session: a checkpoint has not run yet, so nearly the whole
    // conversation is still in the journal. A snapshot-only reader would retain two messages.
    const messages = Array.from({ length: 67 }, (_, i) =>
      message(i % 2 ? "assistant" : "user", [text(`turn ${i}`)])
    );
    const path = writeSession(
      messages.slice(0, 2),
      messages.slice(2).map((m) => ({ meta: {}, append_messages: [m] }))
    );
    const turns = readJcodeTranscript(path);
    expect(turns).toHaveLength(67);
    expect(turns.map((t) => t.content)).toEqual(messages.map((_, i) => `turn ${i}`));
  });

  it("does not duplicate a journal entry the snapshot already holds", () => {
    // A crash between the snapshot write and the journal delete leaves entries in both.
    const a = message("user", [text("one")]);
    const b = message("assistant", [text("two")]);
    const c = message("user", [text("three")]);
    const path = writeSession([a, b], [{ meta: {}, append_messages: [b, c] }]);
    expect(readJcodeTranscript(path).map((t) => t.content)).toEqual(["one", "two", "three"]);
  });

  it("returns identical turns before and after a checkpoint folds the journal in", () => {
    // The retain cursor appends only while the already-sent prefix is unchanged, so the reader
    // must not care which of the two files a message currently lives in.
    const messages = fixture().messages;
    const before = writeSession(
      messages.slice(0, 5),
      messages.slice(5).map((m) => ({ meta: {}, append_messages: [m] }))
    );
    const beforeTurns = readJcodeTranscript(before);
    rmSync(jcodeJournalPath(before));
    writeFileSync(before, JSON.stringify({ messages }));
    expect(readJcodeTranscript(before)).toEqual(beforeTurns);
    expect(beforeTurns).toEqual(readJcodeTranscript(FIXTURE));
  });

  it("strips injected memory and the swarm reminder jcode appends to a prompt", () => {
    const path = writeSession([
      message("user", [
        text(
          "<hindsight_pages>\nroster\n</hindsight_pages>\nfix the parser\n\n" +
            "Use swarms to get things done in parallel."
        ),
      ]),
      message("user", [text("<system-reminder>\nonly a reminder\n</system-reminder>")]),
      // The phrase is the user's own words when an assistant says it, or mid-sentence.
      message("assistant", [text("Use swarms to get things done in parallel.")]),
    ]);
    expect(readJcodeTranscript(path)).toEqual([
      { role: "user", content: "fix the parser" },
      { role: "assistant", content: "Use swarms to get things done in parallel." },
    ]);
  });

  it("keeps every message of a compacted session and adds no summary turn", () => {
    // jcode stores the summary in a top-level field and leaves `messages` intact.
    const path = writeSession(
      [message("user", [text("one")]), message("assistant", [text("two")])],
      undefined,
      { compaction: { summary: "THE SUMMARY", compacted_count: 2 } }
    );
    const turns = readJcodeTranscript(path);
    expect(turns.map((t) => t.content)).toEqual(["one", "two"]);
    expect(JSON.stringify(turns)).not.toContain("THE SUMMARY");
  });

  it("fails open on a missing file, bad JSON, and a damaged journal", () => {
    expect(readJcodeTranscript(join(dir, "absent.json"))).toEqual([]);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(readJcodeTranscript(bad)).toEqual([]);

    const shapes = join(dir, "shapes.json");
    for (const body of ["[]", "null", '{"messages":"nope"}', '{"messages":[null,7,"x"]}']) {
      writeFileSync(shapes, body);
      expect(readJcodeTranscript(shapes), body).toEqual([]);
    }

    const a = message("user", [text("one")]);
    const b = message("assistant", [text("two")]);
    const path = writeSession(
      [a],
      [
        "not json",
        "null",
        "[1,2]",
        { meta: {}, append_messages: "nope" },
        { meta: {}, append_messages: [b] },
        // A torn final line: the write was interrupted mid-record.
        '{"meta":{},"append_messages":[{"id":"message_x","role":"user","content":[{"type":"te',
      ]
    );
    expect(readJcodeTranscript(path).map((t) => t.content)).toEqual(["one", "two"]);
  });

  it("reads the journal of an unreadable snapshot rather than nothing", () => {
    const path = writeSession([], [{ meta: {}, append_messages: [message("user", [text("x")])] }]);
    writeFileSync(path, "{torn");
    expect(readJcodeTranscript(path).map((t) => t.content)).toEqual(["x"]);
  });
});

describe("readJcodeSessionMeta", () => {
  it("reads the working directory of a real session", () => {
    expect(readJcodeSessionMeta(FIXTURE)).toEqual({
      workingDir: "/Users/me/repos/acme",
      isDebug: false,
      readable: true,
    });
  });

  it("prefers the newest journal entry, since a session can change directory", () => {
    const path = writeSession(
      [],
      [
        { meta: { working_dir: "/repo/first", is_debug: false } },
        "not json",
        { meta: { working_dir: "/repo/second", is_debug: true } },
      ],
      { working_dir: "/repo/snapshot", is_debug: false }
    );
    expect(readJcodeSessionMeta(path)).toEqual({
      workingDir: "/repo/second",
      isDebug: true,
      readable: true,
    });
  });

  it("reports a file that is not a session snapshot", () => {
    const path = join(dir, "x.json");
    writeFileSync(path, "[]");
    expect(readJcodeSessionMeta(path).readable).toBe(false);
    expect(readJcodeSessionMeta(join(dir, "absent.json")).readable).toBe(false);
  });
});

describe("jcode session paths", () => {
  it("resolves the snapshot under ~/.jcode, or JCODE_HOME when set", () => {
    vi.stubEnv("JCODE_HOME", "");
    expect(jcodeHome("/home/u")).toBe(join("/home/u", ".jcode"));
    expect(jcodeSessionPath("session_eagle_1_ab", "/home/u")).toBe(
      join("/home/u", ".jcode", "sessions", "session_eagle_1_ab.json")
    );
    vi.stubEnv("JCODE_HOME", "/custom/jcode");
    expect(jcodeSessionPath("session_eagle_1_ab", "/home/u")).toBe(
      join("/custom/jcode", "sessions", "session_eagle_1_ab.json")
    );
  });

  it("refuses an id that is not a plain file stem", () => {
    // The id arrives in a hook payload and becomes a path, so it must not be able to leave
    // the sessions directory.
    for (const id of ["../../etc/passwd", "a/b", "a.b", "", undefined, 7, null]) {
      expect(jcodeSessionPath(id, "/home/u"), String(id)).toBeUndefined();
    }
  });

  it("names the journal beside the snapshot", () => {
    expect(jcodeJournalPath("/s/session_a.json")).toBe("/s/session_a.journal.jsonl");
  });
});

describe("jcodeEvent", () => {
  const payload = { event: "turn_end", session_id: "session_a_1_b", cwd: "/repo" };

  it("returns the stdin event when jcode piped one", () => {
    vi.stubEnv("JCODE_HOOK_PAYLOAD", JSON.stringify({ event: "from_env" }));
    expect(jcodeEvent(() => payload)).toEqual(payload);
  });

  it("falls back to JCODE_HOOK_PAYLOAD when stdin is empty or closed", () => {
    vi.stubEnv("JCODE_HOOK_PAYLOAD", JSON.stringify(payload));
    expect(jcodeEvent(() => null)).toEqual(payload);
  });

  it("returns null with neither source", () => {
    vi.stubEnv("JCODE_HOOK_PAYLOAD", "");
    expect(jcodeEvent(() => null)).toBeNull();
  });

  it("returns null and records hook_input_invalid for a truncated env payload", () => {
    // jcode caps the env mirror at 16 KB; a cut-off payload is not valid JSON.
    const diagFile = join(dir, "diag.jsonl");
    vi.stubEnv("HINDSIGHT_DIAG_FILE", diagFile);
    vi.stubEnv("JCODE_HOOK_PAYLOAD", '{"event":"turn_end","last_assistant_text":"cut of');
    expect(jcodeEvent(() => null)).toBeNull();
    const records = readFileSync(diagFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { harness: string; event: string });
    expect(records).toContainEqual(
      expect.objectContaining({ harness: "jcode", event: "hook_input_invalid" })
    );
  });
});
