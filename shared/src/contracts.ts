import { z } from "zod";

// --- k5 browser wire contract ---
// This union is the single source of truth for the /ws channel. The internal
// plug->service `Event` type is not a browser format and must not be used as
// one. Both the gateway and the web client validate against these schemas, so
// schema drift fails loudly at the boundary instead of silently null-writing.

export const CommandIdSchema = z.string().min(1).max(128);
export type CommandId = z.infer<typeof CommandIdSchema>;

export const TurnIdSchema = z.string().min(1).max(128);
export type TurnId = z.infer<typeof TurnIdSchema>;

export const SessionIdSchema = z.string().min(1).max(256);
export type WireSessionId = z.infer<typeof SessionIdSchema>;

// Closed so the UI can switch exhaustively and a typo cannot invent a branch.
export const CommandFailureReasonSchema = z.enum([
  "ok",
  "invalid-payload",
  "unknown-command",
  "rate-limited",
  "payload-too-large",
  "not-found",
  "busy",
  "seat-busy",
  "seat-cap",
  "socket-cap",
  "queue-full",
  "live-seats-disabled",
  "profile-not-servable",
  "project-has-plugins",
  "harness-unconfigured",
  "posture-unverifiable",
  "posture-too-weak",
  "initialize-failed",
  "protocol-mismatch",
  "auth-required",
  "terminal-auth-unsupported",
  "session-new-failed",
  "timeout",
  "seat-reaped",
  "not-sent",
  "internal",
]);
export type CommandFailureReason = z.infer<typeof CommandFailureReasonSchema>;

const commandBase = { commandId: CommandIdSchema };

export const SessionOpenCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("session.open"),
    // The browser names a project; only the server resolves the canonical path.
    projectId: z.string().min(1).max(256),
  })
  .strict();
export type SessionOpenCommand = z.infer<typeof SessionOpenCommandSchema>;

export const SessionConfigureCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("session.configure"),
    sessionId: SessionIdSchema,
    configOptionId: z.string().min(1).max(128),
    value: z.union([z.string().max(256), z.boolean()]),
  })
  .strict();
export type SessionConfigureCommand = z.infer<
  typeof SessionConfigureCommandSchema
>;

export const SessionPromptCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("session.prompt"),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    text: z.string().min(1).max(20_000),
  })
  .strict();
export type SessionPromptCommand = z.infer<typeof SessionPromptCommandSchema>;

export const SessionCancelCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("session.cancel"),
    sessionId: SessionIdSchema,
  })
  .strict();
export type SessionCancelCommand = z.infer<typeof SessionCancelCommandSchema>;

export const SessionCloseCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("session.close"),
    sessionId: SessionIdSchema,
  })
  .strict();
export type SessionCloseCommand = z.infer<typeof SessionCloseCommandSchema>;

export const PermissionDecideCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("permission.decide"),
    sessionId: SessionIdSchema,
    requestId: z.string().min(1).max(128),
    // Only an option the server actually offered, or a cancel.
    optionId: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type PermissionDecideCommand = z.infer<
  typeof PermissionDecideCommandSchema
>;

export const BrowserCommandSchema = z.discriminatedUnion("type", [
  SessionOpenCommandSchema,
  SessionConfigureCommandSchema,
  SessionPromptCommandSchema,
  SessionCancelCommandSchema,
  SessionCloseCommandSchema,
  PermissionDecideCommandSchema,
]);
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

// --- events ---

export const CommandResultEventSchema = z
  .object({
    type: z.literal("command.result"),
    commandId: CommandIdSchema,
    ok: z.boolean(),
    reason: CommandFailureReasonSchema,
    message: z.string().max(500).optional(),
  })
  .strict();
export type CommandResultEvent = z.infer<typeof CommandResultEventSchema>;

export const ConnectionClosedEventSchema = z
  .object({
    type: z.literal("connection.closed"),
    reason: z.string().min(1).max(200),
    code: z.number().int().optional(),
  })
  .strict();
export type ConnectionClosedEvent = z.infer<typeof ConnectionClosedEventSchema>;

// One selectable value of a config option. The pair is carried rather than a
// bare string so a menu can show the harness's own label, which is how a user
// recognises a model they actually have credentials for.
export const ConfigOptionValueSchema = z
  .object({
    value: z.string().min(1).max(256),
    label: z.string().min(1).max(200),
  })
  .strict();
export type ConfigOptionValue = z.infer<typeof ConfigOptionValueSchema>;

// Advertised `configOptions` are harness-controlled and can be a large
// inventory, so the list is bounded and each entry is length-capped.
export const ConfigOptionSummarySchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().max(200),
    type: z.enum(["select", "boolean"]),
    current: z.string().max(256).nullable(),
    values: z.array(ConfigOptionValueSchema).max(64),
  })
  .strict();
export type ConfigOptionSummary = z.infer<typeof ConfigOptionSummarySchema>;

/** Finds a discovered option by id, or null when the harness advertised none. */
export function findConfigOption(
  options: readonly ConfigOptionSummary[],
  id: string,
): ConfigOptionSummary | null {
  return options.find((o) => o.id === id) ?? null;
}

export const SessionOpenedEventSchema = z
  .object({
    type: z.literal("session.opened"),
    commandId: CommandIdSchema,
    sessionId: SessionIdSchema,
    projectId: z.string().min(1).max(256),
    cwd: z.string().min(1).max(4096),
    configOptions: z.array(ConfigOptionSummarySchema).max(32),
  })
  .strict();
export type SessionOpenedEvent = z.infer<typeof SessionOpenedEventSchema>;

// A refreshed option snapshot after a successful configure, taken from the
// harness rather than assumed locally.
export const SessionConfiguredEventSchema = z
  .object({
    type: z.literal("session.configured"),
    sessionId: SessionIdSchema,
    configOptions: z.array(ConfigOptionSummarySchema).max(32),
  })
  .strict();
export type SessionConfiguredEvent = z.infer<typeof SessionConfiguredEventSchema>;

export const SessionClosedEventSchema = z
  .object({
    type: z.literal("session.closed"),
    sessionId: SessionIdSchema,
    reason: z.string().min(1).max(200),
    message: z.string().max(500).optional(),
  })
  .strict();
export type SessionClosedEvent = z.infer<typeof SessionClosedEventSchema>;

export const SessionFailedEventSchema = z
  .object({
    type: z.literal("session.failed"),
    sessionId: SessionIdSchema.nullable(),
    reason: CommandFailureReasonSchema,
    message: z.string().max(500).optional(),
  })
  .strict();
export type SessionFailedEvent = z.infer<typeof SessionFailedEventSchema>;

export const TurnStartedEventSchema = z
  .object({
    type: z.literal("turn.started"),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
  })
  .strict();
export type TurnStartedEvent = z.infer<typeof TurnStartedEventSchema>;

export const TurnDeltaEventSchema = z
  .object({
    type: z.literal("turn.delta"),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    stream: z.enum(["text", "thought"]),
    text: z.string().max(200_000),
  })
  .strict();
export type TurnDeltaEvent = z.infer<typeof TurnDeltaEventSchema>;

// ACP 1.5.0 has no `cancelled` tool status, so lifecycle is a k5-local field
// and must never be conflated with the harness status.
export const ToolStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

export const ToolLifecycleSchema = z.enum(["active", "cancelled", "orphaned"]);
export type ToolLifecycle = z.infer<typeof ToolLifecycleSchema>;

export const ToolUpdatedEventSchema = z
  .object({
    type: z.literal("tool.updated"),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    toolCallId: z.string().min(1).max(256),
    title: z.string().max(500),
    status: ToolStatusSchema,
    lifecycle: ToolLifecycleSchema,
  })
  .strict();
export type ToolUpdatedEvent = z.infer<typeof ToolUpdatedEventSchema>;

export const PermissionRequestedEventSchema = z
  .object({
    type: z.literal("permission.requested"),
    requestId: z.string().min(1).max(128),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    toolCallId: z.string().max(256).nullable(),
    title: z.string().max(500),
    options: z
      .array(
        z
          .object({
            optionId: z.string().min(1).max(128),
            name: z.string().max(200),
            kind: z.string().max(100),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type PermissionRequestedEvent = z.infer<
  typeof PermissionRequestedEventSchema
>;

export const PermissionResolvedReasonSchema = z.enum([
  "selected",
  "cancelled",
  "timeout",
  "revoked",
  "forged",
  "protocol-cancelled",
  "socket-closed",
  "overflow",
  "turn-cancelled",
  "child-failure",
  "seat-reaped",
]);
export type PermissionResolvedReason = z.infer<
  typeof PermissionResolvedReasonSchema
>;

export const PermissionResolvedEventSchema = z
  .object({
    type: z.literal("permission.resolved"),
    requestId: z.string().min(1).max(128),
    reason: PermissionResolvedReasonSchema,
  })
  .strict();
export type PermissionResolvedEvent = z.infer<
  typeof PermissionResolvedEventSchema
>;

export const TurnCompletedEventSchema = z
  .object({
    type: z.literal("turn.completed"),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    stopReason: z.enum([
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
      "k5-timeout",
      "k5-cancelled",
      "k5-error",
    ]),
  })
  .strict();
export type TurnCompletedEvent = z.infer<typeof TurnCompletedEventSchema>;

export const SeatReapedEventSchema = z
  .object({
    type: z.literal("seat.reaped"),
    // Null when a seat died before a session ever existed, so the failure is
    // not attributed to a session that was never opened.
    sessionId: SessionIdSchema.nullable(),
    reason: z.string().min(1).max(200),
  })
  .strict();
export type SeatReapedEvent = z.infer<typeof SeatReapedEventSchema>;

export const ErrorEventSchema = z
  .object({
    type: z.literal("error"),
    scope: z.string().min(1).max(100),
    message: z.string().max(500),
  })
  .strict();
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  CommandResultEventSchema,
  ConnectionClosedEventSchema,
  SessionOpenedEventSchema,
  SessionConfiguredEventSchema,
  SessionClosedEventSchema,
  SessionFailedEventSchema,
  TurnStartedEventSchema,
  TurnDeltaEventSchema,
  ToolUpdatedEventSchema,
  PermissionRequestedEventSchema,
  PermissionResolvedEventSchema,
  TurnCompletedEventSchema,
  SeatReapedEventSchema,
  ErrorEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export type ServerEventType = ServerEvent["type"];
