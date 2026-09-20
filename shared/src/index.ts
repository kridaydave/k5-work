import { z } from "zod";

export const HarnessSchema = z.enum(["opencode", "kilo", "cline"]);
export type Harness = z.infer<typeof HarnessSchema>;

export const SessionStatusSchema = z.enum(["new", "active", "closed"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  harness: HarnessSchema,
  status: SessionStatusSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const AccessModeSchema = z.string().min(1).default("full");
export type AccessMode = z.infer<typeof AccessModeSchema>;

export const PromptSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
  model: z.string().optional(),
  // Opaque per-harness access mode, set in composer. Default: full access.
  // e.g. opencode/kilo/cline each map "full" to their own flag.
  access: AccessModeSchema,
});
export type Prompt = z.infer<typeof PromptSchema>;

export const ToolOriginSchema = z.enum(["harness", "k5"]);
export type ToolOrigin = z.infer<typeof ToolOriginSchema>;

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  // origin:'harness' covers harness-native tools (e.g. ask-question).
  // k5 never defines their schema — just streams + audits them.
  origin: ToolOriginSchema,
  tool: z.string().min(1),
  args: z.unknown(),
  idempotencyKey: z.string().min(1),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const PermissionLevelSchema = z.enum([
  "AllowOnce",
  "Thread",
  "Always",
  "Deny",
]);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const PermissionSchema = z.object({
  toolCallId: z.string().min(1),
  level: PermissionLevelSchema,
});
export type Permission = z.infer<typeof PermissionSchema>;

export const AuditSchema = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  actor: z.enum(["user", "harness", "service"]),
  action: z.enum(["prompt", "tool", "permission", "session"]),
  refId: z.string().min(1),
  decision: PermissionLevelSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type Audit = z.infer<typeof AuditSchema>;

export const EventKindSchema = z.enum(["chat", "tool", "permission", "audit"]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EventSchema = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  kind: EventKindSchema,
  payload: z.unknown(),
});
export type Event = z.infer<typeof EventSchema>;
