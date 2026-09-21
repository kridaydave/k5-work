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

// --- ooxml-core JSON-in (D-1, extended D-2 review) ---
// Engine owns ordering, rIds, content-types, Deflate. Callers submit parts
// plus rel declarations only, always RAW unescaped text. Schemas are
// strict: unknown keys fail loudly so drift is caught, never stripped.
// Duplicate part names and bad paths are refused engine-side (E_PACKAGE_DUP_PART).
const nonBlank = (label: string) =>
  z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, `${label} must not be blank`);

export const OoxmlPartSchema = z
  .object({
    name: nonBlank("part name"),
    contentType: nonBlank("content type"),
    xml: nonBlank("part xml"),
  })
  .strict();
export type OoxmlPart = z.infer<typeof OoxmlPartSchema>;

export const OoxmlRelModeSchema = z.enum(["internal", "external"]);
export type OoxmlRelMode = z.infer<typeof OoxmlRelModeSchema>;

// Rel declarations for D-3's PackageBuilder (reserved now so adding the
// builder is not a breaking contract change). Targets follow the same
// rules as RelScope: relative part refs internal, absolute IRIs external.
export const OoxmlRelSchema = z
  .object({
    type: nonBlank("rel type"),
    target: nonBlank("rel target"),
    mode: OoxmlRelModeSchema.default("internal"),
  })
  .strict();
export type OoxmlRel = z.infer<typeof OoxmlRelSchema>;

export const OoxmlPackageSpecSchema = z
  .object({
    parts: z.array(OoxmlPartSchema).min(1),
    packageRels: z.array(OoxmlRelSchema).default([]),
    partRels: z.record(z.array(OoxmlRelSchema)).default({}),
  })
  .strict();
export type OoxmlPackageSpec = z.infer<typeof OoxmlPackageSpecSchema>;
