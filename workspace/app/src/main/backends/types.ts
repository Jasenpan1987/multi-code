export type BackendName = "claude" | "opencode";

export interface SpawnConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CompletionDetector {
  stop(): void;
}

export interface SessionDiscovery {
  cancel(): void;
}

export interface Backend {
  readonly name: BackendName;

  spawn(cwd: string): SpawnConfig;

  /**
   * Begin trying to discover the sessionId for an instance running in `cwd`.
   * Calls `onFound` once when the sessionId is determined; never calls it
   * if the agent never registers a session within a reasonable window.
   * The returned handle can be used to cancel discovery early.
   */
  discoverSessionId(
    cwd: string,
    onFound: (sessionId: string) => void
  ): SessionDiscovery;

  /**
   * Begin watching for completion / activity events for the session.
   * `onActivity` fires with a string event type whenever the agent
   * reaches a state that warrants notifying the user. Currently a single
   * "waiting" event is emitted on turn completion; more types may be
   * added later (e.g., "permission") without changing this interface.
   */
  createCompletionDetector(
    sessionId: string,
    onActivity: (type: string) => void
  ): CompletionDetector;

  buildResumeCommand(sessionId: string): string;
}
