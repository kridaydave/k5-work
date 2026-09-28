// ACP capability probing, deliberately lenient.
//
// Every field in the SDK's generated `zAgentCapabilities` and
// `zSessionCapabilities` is wrapped in `.catch(...)` (zod.gen.js), and the SDK's
// client path never parses the initialize response at all: `sendRequest` resolves
// `response.result` raw. So a harness that advertises a capability in a slightly
// different shape loses it silently, with no error to notice. Measured: a
// string "true" for loadSession yields `false`, and `{list: true}` yields an
// object with both list and resume missing, `success: true` throughout.
//
// The opposite trap is worse. A *strict* Zod schema over capabilities would
// throw on such a response and fail the seat open entirely, bricking a harness
// that advertised correctly but differently. So: probe by shape, log a mismatch,
// and never throw.

export interface AcpCapabilities {
  /** Top-level boolean, per the spec's `agentCapabilities.loadSession`. */
  readonly loadSession: boolean;
  /** `sessionCapabilities.list`, present as `{}` when supported. */
  readonly list: boolean;
  readonly resume: boolean;
  readonly close: boolean;
  /** True when the harness advertised an image prompt capability. */
  readonly image: boolean;
  /** True when it advertised embedded context, i.e. ACP `resource` blocks. */
  readonly embeddedContext: boolean;
  /** Field names that were present but the wrong shape. Reported, never fatal. */
  readonly mismatches: readonly string[];
}

export const NO_CAPABILITIES: AcpCapabilities = {
  loadSession: false,
  list: false,
  resume: false,
  close: false,
  image: false,
  embeddedContext: false,
  mismatches: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `{}` means supported; absent or null means not. Anything else present is a
 * mismatch worth reporting, because a harness that meant to advertise support
 * and did not is a harness whose capabilities we cannot trust.
 */
function present(value: unknown): boolean {
  return isRecord(value);
}

export function probeCapabilities(rawInitialize: unknown): AcpCapabilities {
  if (!isRecord(rawInitialize)) return NO_CAPABILITIES;
  const agent = rawInitialize["agentCapabilities"];
  if (agent === undefined || agent === null) return NO_CAPABILITIES;
  if (!isRecord(agent)) {
    return { ...NO_CAPABILITIES, mismatches: ["agentCapabilities"] };
  }

  const mismatches: string[] = [];
  const sessions = agent["sessionCapabilities"];
  if (sessions !== undefined && sessions !== null && !isRecord(sessions)) {
    mismatches.push("sessionCapabilities");
  }
  const sessionCaps = isRecord(sessions) ? sessions : {};

  const strictBoolean = (value: unknown, name: string, fallback: boolean): boolean => {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "boolean") return value;
    mismatches.push(name);
    return fallback;
  };

  const capability = (value: unknown, name: string): boolean => {
    if (value === undefined || value === null) return false;
    if (!present(value)) {
      mismatches.push(name);
      return false;
    }
    // Per ACP a capability object is `{}` or `{ _meta }`. Anything else is a
    // harness sending keys k5 does not understand, and treating that as
    // "supported" would make a call k5 has no evidence for.
    const keys = Object.keys(value);
    if (keys.length > 0 && !keys.every((key) => key === "_meta")) {
      mismatches.push(name);
      return false;
    }
    return true;
  };

  const prompt = agent["promptCapabilities"];
  const promptCaps = isRecord(prompt) ? prompt : {};

  return {
    loadSession: strictBoolean(agent["loadSession"], "loadSession", false),
    list: capability(sessionCaps["list"], "sessionCapabilities.list"),
    resume: capability(sessionCaps["resume"], "sessionCapabilities.resume"),
    close: capability(sessionCaps["close"], "sessionCapabilities.close"),
    image: strictBoolean(promptCaps["image"], "promptCapabilities.image", false),
    embeddedContext: strictBoolean(
      promptCaps["embeddedContext"],
      "promptCapabilities.embeddedContext",
      false,
    ),
    mismatches,
  };
}
