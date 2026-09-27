import {
  client,
  PROTOCOL_VERSION,
  RequestError,
  type AgentCapabilities,
  type AuthenticateRequest,
  type AuthMethod,
  type Implementation,
  type InitializeRequest,
  type NewSessionResponse,
  type Stream,
} from "@agentclientprotocol/sdk";
import { ACP_REQUEST_TIMEOUT_MS } from "./spawn.js";

export class AcpAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpAuthRequiredError";
  }
}

export class AcpProtocolMismatchError extends Error {
  constructor(readonly offered: number) {
    super(
      `agent negotiated ACP protocolVersion ${offered}, client only speaks ${PROTOCOL_VERSION}`,
    );
    this.name = "AcpProtocolMismatchError";
  }
}

// Terminal auth needs a client-run TUI and its own approved design. k5 has
// neither, so it refuses loudly rather than skipping the login step.
export class AcpTerminalAuthUnsupportedError extends Error {
  constructor(readonly methodId: string) {
    super(
      `agent requires terminal auth method "${methodId}", which k5-work does not implement`,
    );
    this.name = "AcpTerminalAuthUnsupportedError";
  }
}

export class AcpRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} exceeded ${timeoutMs}ms and was cancelled`);
    this.name = "AcpRequestTimeoutError";
  }
}

const ACP_AUTH_REQUIRED_CODE = -32000;
const ACP_CANCELLED_CODE = -32800;

export type AuthOfferKind = "agent" | "terminal";

export interface AuthOffer {
  id: string;
  name: string;
  kind: AuthOfferKind;
}

export interface AcpProbeResult {
  protocolVersion: number;
  agentInfo: Implementation | null;
  agentCapabilities: AgentCapabilities | null;
  authOffers: AuthOffer[];
  authenticatedWith: string | null;
  sessionId: string;
  configOptionIds: string[];
  modeIds: string[];
}

export interface AcpProbeOptions {
  stream: Stream;
  cwd: string;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
}

// `type` is optional on the wire and defaults to "agent", so the discriminator
// must be branched on rather than assumed from the method's shape.
function classifyAuthMethod(method: AuthMethod): AuthOffer {
  const kind: AuthOfferKind =
    "type" in method && method.type === "terminal" ? "terminal" : "agent";
  return { id: method.id, name: method.name, kind };
}

function isAuthRequired(err: unknown): boolean {
  return (
    err instanceof RequestError &&
    (err.code === ACP_AUTH_REQUIRED_CODE ||
      err.message.includes("Authentication required"))
  );
}

function isCancelled(err: unknown): boolean {
  return err instanceof RequestError && err.code === ACP_CANCELLED_CODE;
}

// Phase 0 advertises nothing k5 cannot honor. An advertisement is a promise to
// the agent, and each of these needs a real handler before it can be switched on.
const K5_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
};

export async function runAcpProbe(
  options: AcpProbeOptions,
): Promise<AcpProbeResult> {
  const timeoutMs = options.requestTimeoutMs ?? ACP_REQUEST_TIMEOUT_MS;
  const clientName = options.clientName ?? "k5-work";

  // Held as typed consts: the SDK infers its per-method param types from these,
  // and an inline object literal defeats that inference.
  const initializeParams: InitializeRequest = {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: K5_CLIENT_CAPABILITIES,
    clientInfo: { name: clientName, version: options.clientVersion ?? "0.1.0" },
  };

  return client({ name: clientName }).connectWith(
    options.stream,
    async (ctx) => {
      const init = await ctx.request("initialize", initializeParams, {
        cancellationSignal: AbortSignal.timeout(timeoutMs),
      });

      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new AcpProtocolMismatchError(init.protocolVersion);
      }

      const authOffers = (init.authMethods ?? []).map(classifyAuthMethod);
      const terminal = authOffers.filter((offer) => offer.kind === "terminal");
      if (terminal.length > 0) {
        throw new AcpTerminalAuthUnsupportedError(terminal[0].id);
      }

      let authenticatedWith: string | null = null;
      const agentAuth = authOffers.filter((offer) => offer.kind === "agent");
      if (agentAuth.length > 0) {
        const authParams: AuthenticateRequest = { methodId: agentAuth[0].id };
        try {
          await ctx.request("authenticate", authParams, {
            cancellationSignal: AbortSignal.timeout(timeoutMs),
          });
          authenticatedWith = agentAuth[0].id;
        } catch (err) {
          if (isAuthRequired(err)) {
            throw new AcpAuthRequiredError(
              `harness auth method "${agentAuth[0].id}" reported authentication required`,
            );
          }
          throw err;
        }
      }

      // Awaited rather than fired alongside initialize and closed immediately:
      // a cold session/new routinely takes tens of seconds.
      const active = await ctx
        .buildSession(options.cwd)
        .start({ cancellationSignal: AbortSignal.timeout(timeoutMs) })
        .catch((err: unknown) => {
          // A harness can report provider auth at session/new rather than at
          // authenticate, so that failure must stay typed.
          if (isAuthRequired(err)) {
            throw new AcpAuthRequiredError(
              `session/new reported authentication required: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          if (isCancelled(err)) {
            throw new AcpRequestTimeoutError("session/new", timeoutMs);
          }
          throw err;
        });

      const created: NewSessionResponse = active.newSessionResponse;
      const modes = active.modes ?? created.modes ?? null;
      const configOptions = created.configOptions ?? null;

      return {
        protocolVersion: init.protocolVersion,
        agentInfo: init.agentInfo ?? null,
        agentCapabilities: init.agentCapabilities ?? null,
        authOffers,
        authenticatedWith,
        sessionId: created.sessionId,
        configOptionIds: configOptions ? configOptions.map((o) => o.id) : [],
        modeIds: modes ? modes.availableModes.map((m) => m.id) : [],
      };
    },
  );
}
