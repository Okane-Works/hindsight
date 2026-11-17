/**
 * jcode's lifecycle, driven through the real declarations in HOOK_HARNESSES.
 *
 * jcode differs from every other hook host in two ways this file pins down:
 *   - its observer hooks may get NO stdin, only a `JCODE_HOOK_PAYLOAD` env mirror of the event, so
 *     each spec reads its event through `jcodeEvent` (stdin first, env second);
 *   - its `session_start` output is discarded, so the session briefing is stashed and delivered by
 *     the next `user_prompt_submit` hook instead.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHook } from "./core/hook";
import { runRetainHook } from "./core/retain-hook";
import { runSessionStartHook } from "./core/session-start";
import type { RawConfig } from "./core/config";
import { HOOK_HARNESSES } from "./harness/hook-lifecycle";

let stdin = "";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (target: unknown, ...rest: unknown[]) =>
      target === 0 ? stdin : (actual.readFileSync as (...a: unknown[]) => unknown)(target, ...rest),
  };
});

let rawConfig: RawConfig = {};
vi.mock("./core/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./core/config")>();
  return { ...actual, loadConfig: () => actual.resolveConfig(rawConfig) };
});

const FIXTURE_ID = "session_eagle_1794927464955_439e5d418915c243";
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "core",
  "fixtures",
  "jcode",
  `${FIXTURE_ID}.json`
);

const jcode = HOOK_HARNESSES.jcode;
let root: string;
let sessionId: string;

const promptClient = () =>
  vi.fn(() => ({
    reflect: async () => "",
    listPages: async () => ({ items: [] }),
    searchPages: async () => [],
    recallObservations: async () => [],
    pagesSupported: false,
  }));

const sessionStartClient = () => ({
  listPages: async () => ({ items: [] }),
  listDocumentIds: async () => new Set<string>(),
});

const retainClient = () => {
  const retain = vi.fn().mockResolvedValue(undefined);
  const makeClient = vi.fn(() => ({
    retain,
    supportsAppendRetain: async () => false,
  })) as unknown as Parameters<typeof runRetainHook>[1];
  return { retain, makeClient };
};

/** Everything a hook wrote to stdout. */
const captured = async (run: () => Promise<void>): Promise<string> => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    await run();
    return write.mock.calls.map((c) => String(c[0])).join("");
  } finally {
    write.mockRestore();
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hs-jcode-harness-"));
  execFileSync("git", ["init", "-q", root]);
  sessionId = `session_test_${basename(root).replace(/[^A-Za-z0-9]/g, "")}`;
  rawConfig = { autoSeed: false, autoUpdate: false };
  stdin = "";
  vi.stubEnv("HINDSIGHT_DIAG_FILE", join(root, "diag.log"));
  vi.stubEnv("JCODE_HOME", join(root, "jcode-home"));
  vi.stubEnv("JCODE_HOOK_PAYLOAD", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("jcode lifecycle declaration", () => {
  it("registers jcode's own event names, with session_end as a second retain trigger", () => {
    expect(jcode.configStyle).toBe("toml-table");
    expect(jcode.install.sessionStart.event).toBe("session_start");
    expect(jcode.install.prompt.event).toBe("user_prompt_submit");
    expect(jcode.install.stop.event).toBe("turn_end");
    expect(jcode.additionalHooks).toEqual([
      { event: "session_end", entry: jcode.install.stop.entry, timeout: 60 },
    ]);
  });

  it("retains on turn_end and session_end only", () => {
    const accept = jcode.retain.accept!;
    expect(accept({ event: "turn_end" })).toBe(true);
    expect(accept({ event: "session_end" })).toBe(true);
    expect(accept({ event: "turn_start" })).toBe(false);
    expect(accept({ event: "post_tool" })).toBe(false);
    expect(accept({})).toBe(false);
  });

  it("starts a session on create and resume, not when a client re-attaches", () => {
    const accept = jcode.sessionStart.accept!;
    expect(accept({ event: "session_start", source: "create" })).toBe(true);
    expect(accept({ event: "session_start", source: "resume" })).toBe(true);
    expect(accept({ event: "session_start", source: "attach" })).toBe(false);
  });

  it("derives the snapshot path from the session id, and prefers transcript_path when sent", () => {
    expect(jcode.retain.parse({ session_id: FIXTURE_ID, cwd: "/repo" })).toEqual({
      sessionId: FIXTURE_ID,
      transcriptPath: join(root, "jcode-home", "sessions", `${FIXTURE_ID}.json`),
      cwd: "/repo",
    });
    expect(
      jcode.retain.parse({ session_id: FIXTURE_ID, transcript_path: "/elsewhere/s.json" })
        .transcriptPath
    ).toBe("/elsewhere/s.json");
    // An id that cannot be a file stem yields no path, so the hook does nothing.
    expect(jcode.retain.parse({ session_id: "../x" }).transcriptPath).toBeUndefined();
  });

  it("never maps the truncated last_assistant_text", () => {
    // jcode cuts that field at 4000 characters. buildRetain appends a reply that differs from the
    // transcript tail, so mapping it would store a shortened duplicate of every long reply.
    const parsed = jcode.retain.parse({
      session_id: FIXTURE_ID,
      last_assistant_text: "a truncated reply",
      last_assistant_message: "a truncated reply",
    });
    expect(parsed.lastAssistantMessage).toBeUndefined();
  });

  it("answers the prompt hook in Claude's schema, which jcode's hook parser reads", () => {
    expect(jcode.prompt.emit("CTX", undefined, {})).toEqual(
      HOOK_HARNESSES["claude-code"].prompt.emit("CTX", undefined, {})
    );
    expect(jcode.prompt.emit("CTX", "NOTE", {})).toEqual({
      systemMessage: "NOTE",
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "CTX" },
    });
    expect(
      jcode.prompt.parse({ prompt: "p", cwd: "/c", session_id: "s", model: "m", source: "tui" })
    ).toEqual({ prompt: "p", cwd: "/c", sessionId: "s" });
  });
});

describe("jcode retain", () => {
  /** Put the real fixture session where jcode would keep it. */
  const stageSession = () => {
    const dir = join(root, "jcode-home", "sessions");
    mkdirSync(dir, { recursive: true });
    copyFileSync(FIXTURE, join(dir, `${FIXTURE_ID}.json`));
  };
  const event = (extra: Record<string, unknown> = {}) => ({
    event: "turn_end",
    session_id: FIXTURE_ID,
    cwd: root,
    status: "ok",
    last_assistant_text: "TRUNCATED-SNIPPET",
    ...extra,
  });
  const retainedText = (retain: ReturnType<typeof vi.fn>) => JSON.stringify(retain.mock.calls);

  it("retains from the env payload when the observer got no stdin (current jcode)", async () => {
    stageSession();
    vi.stubEnv("JCODE_HOOK_PAYLOAD", JSON.stringify(event()));
    const { retain, makeClient } = retainClient();
    await runRetainHook(jcode.retain, makeClient);
    expect(retain).toHaveBeenCalledTimes(1);
    const sent = retainedText(retain);
    expect(sent).toContain("How can I use self-dev mode?");
    expect(sent).toContain("Self-dev mode is jcode's mechanism");
    expect(sent).toContain("harness:jcode");
    expect(sent).not.toContain("TRUNCATED-SNIPPET");
  });

  it("retains from stdin when jcode pipes the event, ignoring a stale env payload", async () => {
    stageSession();
    stdin = JSON.stringify(event({ transcript_path: FIXTURE }));
    vi.stubEnv("JCODE_HOOK_PAYLOAD", JSON.stringify(event({ event: "turn_start" })));
    const { retain, makeClient } = retainClient();
    await runRetainHook(jcode.retain, makeClient);
    expect(retain).toHaveBeenCalledTimes(1);
  });

  it("retains on session_end too, and does nothing for other events", async () => {
    stageSession();
    const { retain, makeClient } = retainClient();
    vi.stubEnv("JCODE_HOOK_PAYLOAD", JSON.stringify(event({ event: "session_end" })));
    await runRetainHook(jcode.retain, makeClient);
    expect(retain).toHaveBeenCalledTimes(1);

    vi.stubEnv("JCODE_HOOK_PAYLOAD", JSON.stringify(event({ event: "turn_start" })));
    await runRetainHook(jcode.retain, makeClient);
    expect(retain).toHaveBeenCalledTimes(1);
  });

  it("does nothing with no event at all, or a session that has no file", async () => {
    const { retain, makeClient } = retainClient();
    await runRetainHook(jcode.retain, makeClient);
    expect(makeClient).not.toHaveBeenCalled();

    vi.stubEnv("JCODE_HOOK_PAYLOAD", JSON.stringify(event({ session_id: "session_absent_1_a" })));
    await runRetainHook(jcode.retain, makeClient);
    expect(retain).not.toHaveBeenCalled();
  });
});

describe("jcode context delivery", () => {
  const start = (source = "create") =>
    JSON.stringify({ event: "session_start", session_id: sessionId, cwd: root, source });
  const prompt = (text: string) =>
    JSON.stringify({
      event: "user_prompt_submit",
      session_id: sessionId,
      cwd: root,
      prompt: text,
      model: "m",
      source: "tui",
    });

  it("delivers the session-start briefing once, on the next prompt hook", async () => {
    // session_start is an observer: env payload in, and jcode discards whatever comes out, so
    // the briefing must not be spent there.
    vi.stubEnv("JCODE_HOOK_PAYLOAD", start());
    const started = await captured(() =>
      runSessionStartHook(jcode.sessionStart, sessionStartClient)
    );
    expect(started).not.toContain("hindsight_pages");
    expect(started).not.toContain("additionalContext");

    // user_prompt_submit is synchronous: stdin in, Claude-shaped JSON out.
    vi.stubEnv("JCODE_HOOK_PAYLOAD", "");
    stdin = prompt("which parser do we use?");
    const first = JSON.parse(await captured(() => runHook(jcode.prompt, promptClient() as never)));
    expect(first.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const context: string = first.hookSpecificOutput.additionalContext;
    expect(context).toContain("<hindsight_pages>");
    // The stashed briefing goes ahead of whatever this turn produced itself.
    expect(context.indexOf("<hindsight_pages>")).toBe(0);

    // Delivered once: the next prompt carries no second copy of the briefing.
    stdin = prompt("and the retry policy?");
    const second = await captured(() => runHook(jcode.prompt, promptClient() as never));
    expect(second).not.toContain("<hindsight_pages>");
  });

  it("stashes nothing for an attach, so a reconnect cannot replay the briefing", async () => {
    vi.stubEnv("JCODE_HOOK_PAYLOAD", start("attach"));
    const makeClient = vi.fn(sessionStartClient);
    await captured(() => runSessionStartHook(jcode.sessionStart, makeClient));
    expect(makeClient).not.toHaveBeenCalled();

    vi.stubEnv("JCODE_HOOK_PAYLOAD", "");
    stdin = prompt("which parser do we use?");
    const out = await captured(() => runHook(jcode.prompt, promptClient() as never));
    expect(out).not.toContain("<hindsight_pages>");
  });

  it("leaves a host that emits its own SessionStart context unaffected", async () => {
    // Claude Code delivers the briefing from SessionStart itself; nothing is stashed, so its
    // prompt hook has nothing extra to prepend.
    const claude = HOOK_HARNESSES["claude-code"];
    stdin = JSON.stringify({ session_id: sessionId, cwd: root, source: "startup" });
    const started = await captured(() =>
      runSessionStartHook(claude.sessionStart, sessionStartClient)
    );
    expect(started).toContain("<hindsight_pages>");

    stdin = JSON.stringify({ session_id: sessionId, cwd: root, prompt: "which parser?" });
    const prompted = await captured(() => runHook(claude.prompt, promptClient() as never));
    expect(prompted).not.toContain("<hindsight_pages>");
  });
});
