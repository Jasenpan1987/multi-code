// The environment variable that names a Multi-Code instance to its own agent's
// hooks (and, later, OpenCode's plugin). process-manager sets it on each agent's
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
