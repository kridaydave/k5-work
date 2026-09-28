import { z } from "zod";

// --- k5 browser wire contract ---
// This union is the single source of truth for the /ws channel. The internal
// plug->service `Event` type is not a browser format and must not be used as
// one. Both the gateway and the web client validate against these schemas, so
// schema drift fails loudly at the boundary instead of silently null-writing.

export const CommandIdSchema = z.string().min(1).max(128);
export type CommandId = z.infer<typeof CommandIdSchema>;

// k5-minted identity for a stored transcript. The harness session id is opaque,
// harness-controlled and up to 256 chars, so it is never an addressable
// identity on the wire: two harnesses can return the same one.
/**
 * The wire cap on a config option's values, exported so the seat that assembles
 * them cannot hold a different number. The store already does this for its list cap.
 */
export const MAX_CONFIG_OPTION_VALUES = 64;

/** The wire cap on config options in one event, exported for the same reason. */
export const MAX_CONFIG_OPTIONS = 32;

export const StoreIdSchema = z.string().min(1).max(64);
export type StoreId = z.infer<typeof StoreIdSchema>;

export const TurnIdSchema = z.string().min(1).max(128);
export type TurnId = z.infer<typeof TurnIdSchema>;

export const SessionIdSchema = z.string().min(1).max(256);
export type WireSessionId = z.infer<typeof SessionIdSchema>;

// --- attachments ---

/** k5-minted identity for one spooled attachment. Opaque, like StoreId. */
export const AttachmentIdSchema = z.string().min(1).max(64);
export type AttachmentId = z.infer<typeof AttachmentIdSchema>;

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const AttachmentKindSchema = z.enum(["text", "image", "binary"]);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

/**
 * The client names an attachment by id only. Name, mime, size and kind are the
 * server's to decide, read back off the spooled bytes, so a client cannot claim
 * a file is a 10-byte PNG.
 */
export const AttachmentRefSchema = z.object({ attachmentId: AttachmentIdSchema }).strict();
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/**
 * What one attachment contributed to a turn. Bytes are never recorded.
 *
 * The bytes live in the spool and are addressed by `attachmentId` alone. Writing
 * them into `events.jsonl` would blow the store's 12 MiB per-session cap on a
 * single screenshot and render as a wall of base64 in the user bubble, so the
 * manifest records identity and provenance and nothing else.
 */
export const AttachmentManifestEntrySchema = z
  .object({
    attachmentId: AttachmentIdSchema,
    name: z.string().min(1).max(200),
    mimeType: z.string().min(1).max(120),
    kind: AttachmentKindSchema,
    size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
  })
  .strict();
export type AttachmentManifestEntry = z.infer<typeof AttachmentManifestEntrySchema>;

/** Returned by a successful upload. */
export const UploadedAttachmentSchema = AttachmentManifestEntrySchema;

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
  "capability-unsupported",
  "cwd-mismatch",
  "session-unknown",
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

/**
 * Ceiling on a prompt's text, in UTF-8 bytes rather than characters.
 *
 * The character cap was 20,000 code units, which reads as "20,000 characters" and
 * is not what the transport allows. The websocket caps a frame at 64 KiB of
 * bytes, so 20,000 CJK characters is 60,000 bytes and 20,000 emoji is 80,000. A
 * prompt that passed the schema was then killed by the gateway with a 1009 and
 * no `command.result`, so the optimistic turn hung and the whole socket
 * reconnected. Measured in bytes, "over budget" is an ordinary invalid payload
 * the gateway answers with a correlated result.
 *
 * The store's own per-record cap is 256 KiB, so this stays far inside it and
 * `turn.started.userText` needs no matching change.
 */
export const MAX_PROMPT_TEXT_BYTES = 48 * 1024;

export const SessionPromptCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("session.prompt"),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    text: z.string().min(1).max(20_000),
    // Defaulted so a client predating attachments still sends a valid prompt
    // instead of being refused at the boundary for a field it cannot know.
    attachments: z.array(AttachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
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

/**
 * Asks the harness what sessions it knows about for a project. The server opens
 * a short-lived headless seat for the read, so a list never creates a session
 * and never holds a pool slot.
 */
export const SessionListCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("session.list"),
    projectId: z.string().min(1).max(256),
  })
  .strict();
export type SessionListCommand = z.infer<typeof SessionListCommandSchema>;

/**
 * Continues a stored session on the harness. The browser names a k5 store id,
 * never a harness session id: the harness id is opaque, harness-controlled, and
 * up to 256 chars, so it never crosses the wire as an addressable identity.
 */
export const SessionLoadCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("session.load"),
    storeId: StoreIdSchema,
  })
  .strict();
export type SessionLoadCommand = z.infer<typeof SessionLoadCommandSchema>;

/**
 * Every command the browser may send, in one place.
 *
 * The union is derived from this list rather than hand-listed, so the guard that
 * stops a new command from shipping untested has something of ours to read. A
 * test reaching into `ZodDiscriminatedUnion.options` would be asserting on a
 * library's internals instead of on our contract.
 */
export const BROWSER_COMMAND_TYPES = [
  "session.open",
  "session.configure",
  "session.prompt",
  "session.cancel",
  "session.close",
  "session.list",
  "session.load",
] as const;

export type BrowserCommandType = (typeof BROWSER_COMMAND_TYPES)[number];

/**
 * Keyed by the same names as `BROWSER_COMMAND_TYPES`, so the union below is built
 * from lookups and cannot quietly grow a member the list does not name.
 *
 * `satisfies` and not an annotation: an annotation widens each entry to the
 * generic `ZodDiscriminatedUnionOption`, which erases every command's own `type`
 * literal. That leaves the server's dispatch switch with nothing to narrow on,
 * so each handler's parameter resolves to `never`. `satisfies` checks the same
 * thing and keeps the precise types.
 */
const BROWSER_COMMAND_SCHEMAS = {
  "session.open": SessionOpenCommandSchema,
  "session.configure": SessionConfigureCommandSchema,
  "session.prompt": SessionPromptCommandSchema,
  "session.cancel": SessionCancelCommandSchema,
  "session.close": SessionCloseCommandSchema,
  "session.list": SessionListCommandSchema,
  "session.load": SessionLoadCommandSchema,
} satisfies Record<BrowserCommandType, z.ZodTypeAny>;

const BrowserCommandUnionSchema = z.discriminatedUnion("type", [
  BROWSER_COMMAND_SCHEMAS["session.open"],
  BROWSER_COMMAND_SCHEMAS["session.configure"],
  BROWSER_COMMAND_SCHEMAS["session.prompt"],
  BROWSER_COMMAND_SCHEMAS["session.cancel"],
  BROWSER_COMMAND_SCHEMAS["session.close"],
  BROWSER_COMMAND_SCHEMAS["session.list"],
  BROWSER_COMMAND_SCHEMAS["session.load"],
]);

/**
 * The union plus the one check that cannot live on a member.
 *
 * It lives here because a `discriminatedUnion` member must be a plain object, and
 * `.superRefine` returns a `ZodEffects` that cannot sit inside one. The browser
 * validates every command it sends against this schema, so putting the budget
 * here is what turns an over-budget prompt into a refused command rather than a
 * socket the gateway closes.
 */
export const BrowserCommandSchema = BrowserCommandUnionSchema.superRefine(
  (command, ctx) => {
    if (command.type !== "session.prompt") return;
    const bytes = new TextEncoder().encode(command.text).length;
    if (bytes > MAX_PROMPT_TEXT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: `the prompt is ${bytes} bytes of UTF-8, over the ${MAX_PROMPT_TEXT_BYTES}-byte cap`,
      });
    }
  },
);
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
    values: z.array(ConfigOptionValueSchema).max(MAX_CONFIG_OPTION_VALUES),
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
    /**
     * The durable record this session is being written to, so the browser can
     * rehydrate from the store after a reconnect. The harness session id cannot
     * serve that purpose: it is opaque and the browser has no way to address a
     * store by it.
     */
    storeId: StoreIdSchema,
    projectId: z.string().min(1).max(256),
    cwd: z.string().min(1).max(4096),
    configOptions: z.array(ConfigOptionSummarySchema).max(MAX_CONFIG_OPTIONS),
  })
  .strict();
export type SessionOpenedEvent = z.infer<typeof SessionOpenedEventSchema>;

// A refreshed option snapshot after a successful configure, taken from the
// harness rather than assumed locally.
export const SessionConfiguredEventSchema = z
  .object({
    type: z.literal("session.configured"),
    sessionId: SessionIdSchema,
    configOptions: z.array(ConfigOptionSummarySchema).max(MAX_CONFIG_OPTIONS),
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
    // The prompt that opened the turn. The browser already has this text and
    // shows it optimistically, so the live reducer ignores it; it is here
    // because a reloaded transcript is read from the store, and without it a
    // stored session shows only the assistant's half of every exchange.
    userText: z.string().min(1).max(20_000),
    // The same manifest the command named, resolved against the spool. This is
    // the durable half: a reloaded transcript has the command's ids but not the
    // names and sizes, so the manifest is what lets it say what was attached.
    attachments: z.array(AttachmentManifestEntrySchema).max(MAX_ATTACHMENTS).default([]),
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

// The four reasons ACP reports, plus the three k5 produces locally when a turn
// is bounded, refused, or fails. Named so the store's projection and the live
// reducer cannot disagree about what a terminal turn looks like.
export const StopReasonSchema = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
  "k5-timeout",
  "k5-cancelled",
  "k5-error",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const TurnCompletedEventSchema = z
  .object({
    type: z.literal("turn.completed"),
    sessionId: SessionIdSchema,
    turnId: TurnIdSchema,
    stopReason: StopReasonSchema,
  })
  .strict();
export type TurnCompletedEvent = z.infer<typeof TurnCompletedEventSchema>;

// The harness's own view of the session's metadata. ACP's session_info_update
// exists so an agent can auto-generate a title after the first exchange, and a
// stored session with no title is a blank row in the sidebar forever.
//
// Deliberately NOT the ACP "null clears the title" semantic. k5 never blanks a
// title it already has: a stored session that loses its name falls back to its
// opening prompt, which is more useful than an empty row. So null here means
// "this update carried no title", and title and updatedAt are independently
// optional.
export const SessionUpdatedEventSchema = z
  .object({
    type: z.literal("session.updated"),
    sessionId: SessionIdSchema,
    title: z.string().min(1).max(200).nullable(),
    updatedAt: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type SessionUpdatedEvent = z.infer<typeof SessionUpdatedEventSchema>;

/**
 * One `allow` rule the harness's own resolver reported, with the scope it was
 * scoped to.
 *
 * The pattern is carried because the scope is the whole point: a permission
 * allowed only for `.opencode/plans/*.md` is a materially different fact from
 * one allowed everywhere, and a list of bare permission names would collapse
 * two very different postures into one.
 */
export const PostureGrantSchema = z
  .object({
    permission: z.string().min(1).max(64),
    pattern: z.string().min(1).max(1024),
  })
  .strict();
export type PostureGrant = z.infer<typeof PostureGrantSchema>;

/** How many grants one event may carry, so a hostile rule list stays bounded. */
export const MAX_POSTURE_GRANTS = 256;

/**
 * What the harness actually resolved, so the browser can report it instead of
 * asserting a profile it cannot see.
 *
 * `verified` is separate from the counts because "the resolver reported a blanket
 * `*: allow`" and "the resolver could not be read and `full` tolerated it" both
 * arrive as `wildcardAllow: true` with nothing to back it up. A viewer that only
 * had the counts would have to render the second as the first, which is the same
 * unsupported claim this record exists to remove.
 */
export const ResolvedPostureSchema = z
  .object({
    verified: z.boolean(),
    /** Named permissions the harness resolves to `allow`. */
    allowedTools: z.array(z.string().min(1).max(64)).max(MAX_POSTURE_GRANTS),
    /** True when the harness resolves a blanket `*: allow`. */
    wildcardAllow: z.boolean(),
    /** How many permission rules the resolver read. Zero means it read none. */
    ruleCount: z.number().int().nonnegative(),
    grants: z.array(PostureGrantSchema).max(MAX_POSTURE_GRANTS),
  })
  .strict();
export type ResolvedPostureReport = z.infer<typeof ResolvedPostureSchema>;

/**
 * The resolved posture, republished.
 *
 * A NEW event rather than a field on `session.opened`, for two reasons. It is
 * republished on its own when the posture is re-resolved, and adding a required
 * field to an existing event would break every older stored record and every
 * hand-written test literal the moment it landed.
 *
 * Deliberately NOT in `PERSISTED_EVENT_TYPES`. A posture is a property of the
 * seat, not of the conversation: it is identical for every turn, so storing it
 * repeats one unchanging value across the whole log, and a rehydrated
 * transcript would display the permissions of a harness that has since been
 * reaped. The live seat reports its own posture, and a view with no live seat
 * correctly says the posture is unverified.
 */
export const SessionPostureEventSchema = z
  .object({
    type: z.literal("session.posture"),
    sessionId: SessionIdSchema,
    posture: ResolvedPostureSchema,
  })
  .strict();
export type SessionPostureEvent = z.infer<typeof SessionPostureEventSchema>;

// What the harness reports for a project, from a short-lived read. Distinct from
// a stored session on purpose: these are sessions k5 has no record of, and the
// sidebar shows them differently rather than pretending they are history.
export const HarnessSessionSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    cwd: z.string().min(1).max(4096),
    title: z.string().min(1).max(200).nullable(),
    updatedAt: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type HarnessSession = z.infer<typeof HarnessSessionSchema>;

export const SessionListedEventSchema = z
  .object({
    type: z.literal("session.listed"),
    commandId: CommandIdSchema,
    projectId: z.string().min(1).max(256),
    sessions: z.array(HarnessSessionSchema).max(100),
    /** True when the harness does not offer session/list at all. */
    unsupported: z.boolean(),
  })
  .strict();
export type SessionListedEvent = z.infer<typeof SessionListedEventSchema>;

export const SessionLoadedEventSchema = z
  .object({
    type: z.literal("session.loaded"),
    commandId: CommandIdSchema,
    storeId: StoreIdSchema,
    sessionId: SessionIdSchema,
    projectId: z.string().min(1).max(256),
    cwd: z.string().min(1).max(4096),
    configOptions: z.array(ConfigOptionSummarySchema).max(MAX_CONFIG_OPTIONS),
  })
  .strict();
export type SessionLoadedEvent = z.infer<typeof SessionLoadedEventSchema>;

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
  TurnCompletedEventSchema,
  SessionListedEventSchema,
  SessionLoadedEventSchema,
  SeatReapedEventSchema,
  SessionUpdatedEventSchema,
  SessionPostureEventSchema,
  ErrorEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export type ServerEventType = ServerEvent["type"];
