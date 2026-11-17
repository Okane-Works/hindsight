/**
 * jcode session transcript reader, plus the two host facts every jcode hook needs: where a
 * session lives on disk, and where a hook's event comes from.
 *
 * jcode persists a session as two files under `${JCODE_HOME:-~/.jcode}/sessions/`:
 *
 *   <id>.json           snapshot: `{id, working_dir, is_debug, messages:[...], compaction, ...}`
 *   <id>.journal.jsonl  append-only journal, one `{meta, append_messages?:[...]}` per line,
 *                       folded into the snapshot (and deleted) at the next checkpoint
 *
 * The snapshot alone is NOT the transcript: an active session can hold 2 messages in the snapshot
 * and 65 more in the journal. The reader replays the journal over the snapshot with the same
 * id-based dedupe jcode itself uses, since a crash between snapshot write and journal delete
 * leaves entries in both.
 *
 * Each message is `{id, role, content:[ContentBlock], display_role?, timestamp?}`. Messages with a
 * `display_role` (`system`, `background_task`, `file_activity`) are machine-authored (session
 * context, per-turn `<system-reminder>`, notifications, continuations) and are skipped, which is
 * also what keeps injected memory from being retained again. `text` blocks join into one prose
 * turn; each `tool_use` becomes a compact action turn; tool results and every reasoning variant
 * are dropped. Compaction keeps `messages` intact and stores its summary in a separate top-level
 * field, so no summary turn ever enters the list. Never throws.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TransportTurn } from "./chat";
import { parseHookEvent, readHookEvent } from "./diag";
import { actionLine, stripInjectedMemory } from "./transcript-util";

/** jcode appends this to the user's own message under swarm effort (jcode-base/src/prompt.rs). */
const SWARM_SUFFIX = "Use swarms to get things done in parallel.";

/** jcode's home: `$JCODE_HOME`, else `~/.jcode` (jcode-storage/src/lib.rs). */
export function jcodeHome(home = homedir()): string {
  return process.env.JCODE_HOME || join(home, ".jcode");
}

/** jcode session ids are `session_<name>_<epoch_ms>_<hex>`; anything else must not become a path. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** The snapshot path for a session id, or undefined for an id that is not a plain file stem. */
export function jcodeSessionPath(sessionId: unknown, home?: string): string | undefined {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return undefined;
  return join(jcodeHome(home), "sessions", `${sessionId}.json`);
}

/**
 * A jcode hook's event. Observer hooks (`session_start`, `turn_end`, `session_end`) are spawned
 * with stdin closed and receive the event as `JCODE_HOOK_PAYLOAD` (a JSON mirror of the
 * `JCODE_HOOK_*` env vars, capped at 16 KB). Synchronous hooks, and observers on a jcode that
 * pipes the event, get it on stdin. Stdin wins; the env payload is the fallback. A truncated env
 * payload is invalid JSON and yields null (recorded as `hook_input_invalid`).
 */
export function jcodeEvent(
  readStdin: () => Record<string, unknown> | null = () => readHookEvent("jcode")
): Record<string, unknown> | null {
  const fromStdin = readStdin();
  if (fromStdin) return fromStdin;
  const raw = process.env.JCODE_HOOK_PAYLOAD;
  return raw ? parseHookEvent("jcode", raw) : null;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

interface StoredMessage {
  id?: unknown;
  role?: unknown;
  display_role?: unknown;
  timestamp?: unknown;
  content?: unknown;
}

/** `apply_patch` carries its paths inside the patch text; name them instead of a bare tool. */
function patchPaths(patch: string): string[] {
  const out: string[] = [];
  const re = /^(?:\*\*\* (?:Update|Add|Delete) File: (.+)|\+\+\+ (?:b\/)?(.+))$/gm;
  for (const m of patch.matchAll(re)) {
    const p = (m[1] ?? m[2] ?? "").trim();
    if (p && p !== "/dev/null" && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Action lines for one tool call. `batch` unrolls into its inner calls. */
function toolActions(name: string, input: unknown, depth = 0): string[] {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  if (name === "batch" && depth === 0 && Array.isArray(rec?.tool_calls)) {
    const lines: string[] = [];
    for (const call of rec.tool_calls) {
      if (!call || typeof call !== "object") continue;
      const c = call as Record<string, unknown>;
      if (typeof c.tool !== "string") continue;
      // Inner call arguments are siblings of `tool`, or nested under `parameters` in older shapes.
      const args = c.parameters && typeof c.parameters === "object" ? c.parameters : c;
      lines.push(...toolActions(c.tool, args, depth + 1));
    }
    if (lines.length) return lines;
  }
  if (name === "apply_patch" && typeof rec?.patch_text === "string") {
    const paths = patchPaths(rec.patch_text);
    if (paths.length) return [`apply_patch ${paths.join(" ")}`.slice(0, 200)];
  }
  return [actionLine(name, input)];
}

function stripUserText(text: string, role: string): string {
  let t = stripInjectedMemory(text).trim();
  if (role === "user" && t.endsWith(SWARM_SUFFIX)) t = t.slice(0, -SWARM_SUFFIX.length).trim();
  return t;
}

function renderMessage(m: StoredMessage): TransportTurn[] {
  const role = m.role;
  if (role !== "user" && role !== "assistant") return [];
  if (m.display_role !== undefined && m.display_role !== null) return [];
  if (!Array.isArray(m.content)) return [];
  const texts: string[] = [];
  const actions: string[] = [];
  for (const block of m.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as ContentBlock;
    if (b.type === "text" && typeof b.text === "string") {
      const t = stripUserText(b.text, role);
      if (t) texts.push(t);
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      actions.push(...toolActions(b.name, b.input));
    }
    // tool_result, reasoning variants, images, provider-native blocks: dropped.
  }
  const stamp = typeof m.timestamp === "string" && m.timestamp ? { timestamp: m.timestamp } : {};
  const out: TransportTurn[] = [];
  const joined = texts.join("\n").trim();
  if (joined) out.push({ role, content: joined, ...stamp });
  for (const a of actions) out.push({ role: "action", content: a, ...stamp });
  return out;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The journal that belongs to a snapshot path. */
export function jcodeJournalPath(snapshotPath: string): string {
  return `${snapshotPath.replace(/\.json$/, "")}.journal.jsonl`;
}

/** Snapshot messages followed by unseen journal messages, in order. Never throws. */
export function readJcodeMessages(path: string): StoredMessage[] {
  const snap = readJson(path) as { messages?: unknown } | undefined;
  const messages: StoredMessage[] = [];
  const seen = new Set<string>();
  const add = (m: unknown) => {
    if (!m || typeof m !== "object") return;
    const msg = m as StoredMessage;
    if (typeof msg.id === "string") {
      if (seen.has(msg.id)) return;
      seen.add(msg.id);
    }
    messages.push(msg);
  };
  if (snap && typeof snap === "object" && Array.isArray(snap.messages)) snap.messages.forEach(add);

  const journal = jcodeJournalPath(path);
  let raw = "";
  try {
    if (existsSync(journal) && statSync(journal).isFile()) raw = readFileSync(journal, "utf8");
  } catch {
    raw = "";
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a glued or half-written line: skip, fail open
    }
    if (!entry || typeof entry !== "object") continue;
    const appended = (entry as { append_messages?: unknown }).append_messages;
    if (Array.isArray(appended)) appended.forEach(add);
  }
  return messages;
}

/** Read a jcode session (snapshot path) into normalized turns. Never throws. */
export function readJcodeTranscript(path: string): TransportTurn[] {
  try {
    return readJcodeMessages(path).flatMap(renderMessage);
  } catch {
    return [];
  }
}

/** Session metadata the history importer needs: newest journal meta wins over the snapshot.
 *  `readable` is false for a file that is not a session snapshot at all (not JSON, not an object). */
export function readJcodeSessionMeta(path: string): {
  workingDir?: string;
  isDebug: boolean;
  readable: boolean;
} {
  const raw = readJson(path);
  const readable = !!raw && typeof raw === "object" && !Array.isArray(raw);
  const snap = readable ? (raw as Record<string, unknown>) : undefined;
  let workingDir = typeof snap?.working_dir === "string" ? snap.working_dir : undefined;
  let isDebug = snap?.is_debug === true;
  try {
    const journal = jcodeJournalPath(path);
    if (existsSync(journal)) {
      for (const line of readFileSync(journal, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const meta = (JSON.parse(line) as { meta?: Record<string, unknown> }).meta;
          if (meta && typeof meta === "object") {
            if (typeof meta.working_dir === "string") workingDir = meta.working_dir;
            if (typeof meta.is_debug === "boolean") isDebug = meta.is_debug;
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* fail open */
  }
  return { workingDir, isDebug, readable };
}
