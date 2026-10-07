// The environment variable that names a Multi-Code instance to its own agent's
// hooks (Claude) or plugin (OpenCode). process-manager sets it on each agent's
// spawn; every env Multi-Code builds deletes an inherited one first, because a
// dev build launched from inside a Multi-Code session would otherwise pass the
// parent's id to every agent and terminal it starts, and their alerts would land
// on someone else's contact.
export const INSTANCE_ENV = "MULTICODE_INSTANCE_ID";

// A fresh value per spawn of an instance, sent back by its hooks alongside the
// instance id. A restart keeps the id, and the old process's async hooks can still
// deliver after the new one is up; this is what lets those be dropped instead of
// raising, say, a finish on a session that has only just started. Stripped from
// inherited envs for the same reason as INSTANCE_ENV.
export const SPAWN_ENV = "MULTICODE_SPAWN_ID";

// OpenCode only: the path of the 0600 file holding `/alert`'s endpoint and token,
// which Multi-Code's plugin reads at init (backends/opencodePlugin.ts). The path
// travels by env, the token never does. Set only on an OpenCode spawn that loads the
// plugin, and stripped from OpenCode's inherited env otherwise.
export const ALERT_FILE_ENV = "MULTICODE_ALERT_FILE";
