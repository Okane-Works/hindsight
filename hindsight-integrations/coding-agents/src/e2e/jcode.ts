import type { HarnessDockerSetup } from "./harness";

/**
 * jcode — `jcode run <prompt>` runs one prompt non-interactively, hosts its agent in-process (no
 * daemon is left behind) and prints the reply on stdout.
 *
 * Driven through the stub model: jcode's OpenAI-compatible provider is configured entirely from
 * the environment and needs no account, so there is no credential to mount. The route is set by
 * the image's entry script (e2e/jcode-e2e-exec.sh) rather than passed as plain environment,
 * because jcode rejects a plain-http base URL whose host is a DNS name and the stub is reached as
 * `host.docker.internal`; the script resolves it to an address first.
 *
 * `injectsIntoModel` is false for now. Injection rides jcode's synchronous `user_prompt_submit`
 * hook, which is newer than its observer hooks: a release without it ignores the installed key and
 * runs retain-only, and asserting injection against such a release would keep this harness red for
 * something no change here can fix. Flip it once the image's jcode release has the hook. Retention
 * is asserted either way: `turn_end` fires for `jcode run`, and the session snapshot plus journal
 * are read back by core/transcript-jcode.ts.
 */
export const jcodeDockerSetup: HarnessDockerSetup = {
  name: "jcode",
  hindsightHarness: "jcode",
  installCommand: "hindsight-coding-agents install jcode",
  stubModelEnv: (baseUrl) => ({
    HINDSIGHT_STUB_BASE_URL: `${baseUrl}/v1`,
  }),
  injectsIntoModel: false,
  command: (prompt) => ["hindsight-jcode-e2e-exec", prompt],
};
