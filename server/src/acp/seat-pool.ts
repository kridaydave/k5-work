import type { AccessProfile, Harness } from "@k5-work/shared";
import type { AcpChild } from "./spawn.js";

export type SeatState = "provisional" | "active";

/**
 * One harness process. Keyed by (harness, project, profile) because OpenCode
 * loads each session directory's config, plugins, agents, and MCP servers, so
 * sharing a seat across projects would cross those boundaries.
 */
export interface SeatKey {
  harness: Harness;
  projectId: string;
  profile: AccessProfile;
}

export function seatKeyId(key: SeatKey): string {
  return `${key.harness}:${key.projectId}:${key.profile.label}`;
}

export interface Seat {
  readonly id: string;
  readonly key: SeatKey;
  state: SeatState;
  readonly cwd: string;
  child: AcpChild | null;
  sessionId: string | null;
  /** Live ACP turn id, or null when no turn is running. */
  turnId: string | null;
  /** When the reservation was taken, for the provisional sweep. */
  reservedAt: number;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
}

export interface SeatPoolOptions {
  maxSeats: number;
  idleTtlMs: number;
  /**
   * How long a reservation may sit unpromoted. A cold session/new can take tens
   * of seconds, so this is comfortably longer than the open deadline.
   */
  provisionalTtlMs?: number;
  now?: () => number;
}

export class SeatCapError extends Error {
  constructor(readonly max: number) {
    super(`seat cap reached (${max}); no seat available`);
    this.name = "SeatCapError";
  }
}

export class SeatBusyError extends Error {
  constructor(
    readonly seatId: string,
    readonly state: "active" | "provisional",
  ) {
    // One active session per seat in the first slice: multiplexing is an
    // isolation question, not an assumption. The state is named so an operator
    // is not told a seat has a session when it has only a stale reservation.
    super(
      state === "active"
        ? `seat ${seatId} already has an active session`
        : `seat ${seatId} has an in-flight reservation`,
    );
    this.name = "SeatBusyError";
  }
}

/**
 * Reserves before spawning so two concurrent opens cannot both observe a free
 * slot. A provisional seat that never promotes must be released by the caller.
 */
export class SeatPool {
  private readonly seats = new Map<string, Seat>();
  private readonly provisional = new Map<string, Seat>();
  private readonly now: () => number;
  private readonly provisionalTtlMs: number;

  constructor(private readonly options: SeatPoolOptions) {
    this.now = options.now ?? Date.now;
    this.provisionalTtlMs =
      options.provisionalTtlMs ?? SEAT_PROVISIONAL_TTL_MS;
  }

  /** Provisional and active seats both count against the cap. */
  get size(): number {
    this.sweepProvisional();
    return this.seats.size + this.provisional.size;
  }

  /**
   * Reclaims reservations that were never promoted.
   *
   * Without this a caller that throws between reserve() and promote() leaks a
   * cap slot permanently: the key stays reserved, every later request for it
   * reports a busy seat, and nothing is visible in list() or activeCount. A few
   * such leaks would brick the workspace for every project.
   */
  sweepProvisional(): number {
    const cutoff = this.now() - this.provisionalTtlMs;
    let reclaimed = 0;
    for (const seat of [...this.provisional.values()]) {
      if (seat.reservedAt <= cutoff) {
        this.provisional.delete(seat.id);
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  get activeCount(): number {
    return this.seats.size;
  }

  has(key: SeatKey): boolean {
    const id = seatKeyId(key);
    return this.seats.has(id) || this.provisional.has(id);
  }

  reserve(key: SeatKey, cwd: string): Seat {
    this.sweepProvisional();
    const id = seatKeyId(key);
    const existing = this.seats.get(id);
    if (existing) throw new SeatBusyError(existing.id, "active");
    if (this.provisional.has(id)) throw new SeatBusyError(id, "provisional");
    if (this.seats.size + this.provisional.size >= this.options.maxSeats) {
      throw new SeatCapError(this.options.maxSeats);
    }

    const seat: Seat = {
      id,
      key,
      state: "provisional",
      cwd,
      child: null,
      sessionId: null,
      turnId: null,
      reservedAt: this.now(),
      lastUsedAt: this.now(),
      idleTimer: null,
    };
    this.provisional.set(id, seat);
    return seat;
  }

  /** Promotes only a seat this pool reserved, so a foreign seat cannot slip in. */
  promote(seat: Seat, sessionId: string, child: AcpChild): void {
    if (this.provisional.get(seat.id) !== seat) {
      throw new Error(`seat ${seat.id} is not a live reservation`);
    }
    this.provisional.delete(seat.id);
    seat.state = "active";
    seat.sessionId = sessionId;
    seat.child = child;
    seat.lastUsedAt = this.now();
    this.seats.set(seat.id, seat);
  }

  /** Releases a reservation that never became a seat. */
  releaseProvisional(seat: Seat): boolean {
    return this.provisional.delete(seat.id);
  }

  touch(seat: Seat): void {
    seat.lastUsedAt = this.now();
  }

  get(id: string): Seat | null {
    return this.seats.get(id) ?? null;
  }

  list(): Seat[] {
    return [...this.seats.values()];
  }

  /** Removes a seat from the table. Closing its child is the caller's job. */
  remove(seat: Seat): void {
    this.clearIdleTimer(seat);
    this.provisional.delete(seat.id);
    this.seats.delete(seat.id);
  }

  /** Starts a per-seat idle countdown that invokes `onIdle` for that seat. */
  startIdleTimer(seat: Seat, onIdle: (seat: Seat) => void): void {
    this.clearIdleTimer(seat);
    seat.idleTimer = setTimeout(() => {
      seat.idleTimer = null;
      onIdle(seat);
    }, this.options.idleTtlMs);
    seat.idleTimer.unref();
  }

  /** Cancels a seat's idle countdown, called whenever the user acts again. */
  clearIdleTimer(seat: Seat): void {
    if (seat.idleTimer) {
      clearTimeout(seat.idleTimer);
      seat.idleTimer = null;
    }
  }

  clearAllTimers(): void {
    for (const seat of [...this.seats.values(), ...this.provisional.values()]) {
      if (seat.idleTimer) {
        clearTimeout(seat.idleTimer);
        seat.idleTimer = null;
      }
    }
  }
}

/** Local-first starting values; every one is a named constant with a test. */
export const MAX_SEATS = 4;
export const SEAT_IDLE_TTL_MS = 10 * 60_000;
export const SEAT_PROVISIONAL_TTL_MS = 3 * 60_000;
export const SESSION_OPEN_DEADLINE_MS = 60_000;
export const TURN_WATCHDOG_MS = 10_000;
export const TURN_TIMEOUT_MS = 30 * 60_000;
