// Multi-Code's one connection to the user's shared OpenCode 2 service: its event
// stream, the snapshot reads that re-sync after a reconnect, and the dialog replies.
//
// Contract stub (opencode-v2 T-602); T-603 implements it. The facts it rests on are in
// docs/timeline/2026-10-20_opencode-v2-source-reading.md ("Shared service", "Event
// stream", "Answering dialogs through the API"). The service's password never leaves
// this module.

import type { AnswerResult } from "./types";

// One frame of `GET /api/event`, as the service sent it. `data` is the event's payload
// (`sessionID` and the rest); `location` is absent on most session events.
export interface ServiceEvent {
  type: string;
  data: Record<string, unknown>;
  location?: { directory: string };
}

export type ServiceStatus =
  | { state: "connecting" }
  | { state: "connected" }
  // No registration, the service refused us, or the stream keeps dropping. `reason`
  // is one line for a log or the alerts-off bar, never carrying the password.
  | { state: "unreachable"; reason: string };

// What a subscriber hears. `onResync` follows every (re)connect, including a new
// service replacing the old one: events missed meanwhile are gone, so re-read state
// from the snapshot.
export interface ServiceListener {
  onEvent(event: ServiceEvent): void;
  onResync(): void;
  onStatus(status: ServiceStatus): void;
}

// `GET /api/session/:id`, the fields Multi-Code reads.
export interface ServiceSession {
  id: string;
  parentID?: string;
  directory?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
}

// A pending permission request (`permission.asked` data, `GET …/permission` items).
export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  message?: string;
}

// A pending form (`form.created` data's `form`, `GET …/form` items). The question
// tool's forms have `metadata.kind === "question"` and fields `q0…`.
export interface FormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  options?: { value: string; label: string; description?: string }[];
  custom?: boolean;
}

export interface FormInfo {
  id: string;
  sessionID: string;
  title?: string;
  metadata?: Record<string, unknown>;
  fields: FormField[];
}

export interface OpencodeService {
  // The connection opens with the first subscriber and closes after the last one
  // leaves. Returns the unsubscribe.
  subscribe(listener: ServiceListener): () => void;
  status(): ServiceStatus;
  // Sessions with a turn running (`GET /api/session/active`). Null when unreachable.
  activeSessions(): Promise<Set<string> | null>;
  // Null when unknown to the service or unreachable.
  session(sessionId: string): Promise<ServiceSession | null>;
  pendingPermissions(sessionId: string): Promise<PermissionRequest[] | null>;
  pendingForms(sessionId: string): Promise<FormInfo[] | null>;
  replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "always" | "reject",
    message?: string
  ): Promise<AnswerResult>;
  replyForm(
    sessionId: string,
    formId: string,
    answer: Record<string, string | string[]>
  ): Promise<AnswerResult>;
  cancelForm(sessionId: string, formId: string, message?: string): Promise<AnswerResult>;
}

// The process-wide client.
export function getOpencodeService(): OpencodeService {
  throw new Error("opencodeService: not implemented (T-603)");
}
