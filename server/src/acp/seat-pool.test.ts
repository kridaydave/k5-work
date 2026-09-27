import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Harness } from "@k5-work/shared";
import { resolveAccessProfile } from "@k5-work/shared";
import type { AcpChild } from "./spawn.js";
import {
  MAX_SEATS,
  SEAT_PROVISIONAL_TTL_MS,
  SESSION_OPEN_DEADLINE_MS,
  SeatBusyError,
  SeatCapError,
  SeatPool,
  seatKeyId,
  type SeatKey,
} from "./seat-pool.js";

const key = (projectId: string, label: "read" | "full" = "read"): SeatKey => ({
  harness: "opencode" as Harness,
  projectId,
  profile: resolveAccessProfile(label),
});

const fakeChild = (): AcpChild =>
  ({
    argv: ["fake"],
    pid: 1234,
    stream: {} as never,
    exited: Promise.resolve({ code: 0, signal: null, error: null }),
    stderrTail: () => "",
    close: async () => ({ reaped: true, exit: { code: 0, signal: null, error: null } }),
  }) satisfies AcpChild;

describe("seat pool", () => {
  it("counts provisional reservations against the cap", () => {
    const pool = new SeatPool({ maxSeats: 2, idleTtlMs: 1000 });
    pool.reserve(key("p1"), "/tmp/p1");
    pool.reserve(key("p2"), "/tmp/p2");
    assert.equal(pool.size, 2);
    assert.equal(pool.activeCount, 0);
    assert.throws(() => pool.reserve(key("p3"), "/tmp/p3"), SeatCapError);
  });

  it("refuses a second session on a live seat instead of sharing it", () => {
    const pool = new SeatPool({ maxSeats: 4, idleTtlMs: 1000 });
    const seat = pool.reserve(key("p1"), "/tmp/p1");
    pool.promote(seat, "sess-1", fakeChild());
    assert.throws(() => pool.reserve(key("p1"), "/tmp/p1"), SeatBusyError);
    assert.equal(pool.activeCount, 1);
  });

  it("refuses concurrent reservations for the same key before either spawns", () => {
    const pool = new SeatPool({ maxSeats: 4, idleTtlMs: 1000 });
    pool.reserve(key("p1"), "/tmp/p1");
    assert.throws(() => pool.reserve(key("p1"), "/tmp/p1"), SeatBusyError);
  });

  it("frees a cap slot when a reservation is released without promoting", () => {
    const pool = new SeatPool({ maxSeats: 1, idleTtlMs: 1000 });
    const seat = pool.reserve(key("p1"), "/tmp/p1");
    assert.throws(() => pool.reserve(key("p2"), "/tmp/p2"), SeatCapError);
    assert.equal(pool.releaseProvisional(seat), true);
    assert.equal(pool.size, 0);
    assert.doesNotThrow(() => pool.reserve(key("p2"), "/tmp/p2"));
  });

  it("will not promote a seat it no longer holds", () => {
    const pool = new SeatPool({ maxSeats: 2, idleTtlMs: 1000 });
    const seat = pool.reserve(key("p1"), "/tmp/p1");
    pool.releaseProvisional(seat);
    assert.throws(
      () => pool.promote(seat, "sess-1", fakeChild()),
      /not a live reservation/,
    );
  });

  it("separates seats by profile, because posture is part of the key", () => {
    const pool = new SeatPool({ maxSeats: 4, idleTtlMs: 1000 });
    const read = pool.reserve(key("p1", "read"), "/tmp/p1");
    const full = pool.reserve(
      { harness: "opencode", projectId: "p1", profile: resolveAccessProfile("full") },
      "/tmp/p1",
    );
    assert.notEqual(read.id, full.id);
    assert.equal(pool.size, 2);
  });

  it("derives a stable key id from harness, project, and profile", () => {
    assert.equal(seatKeyId(key("p1", "read")), "opencode:p1:read");
    assert.equal(seatKeyId(key("p1", "full")), "opencode:p1:full");
    assert.notEqual(seatKeyId(key("p1", "read")), seatKeyId(key("p2", "read")));
  });

  it("reaps a seat on idle TTL and stops tracking it", async () => {
    let fired: string | null = null;
    const pool = new SeatPool({ maxSeats: 2, idleTtlMs: 20 });
    const seat = pool.reserve(key("p1"), "/tmp/p1");
    pool.promote(seat, "sess-1", fakeChild());
    pool.startIdleTimer(seat, (s) => {
      fired = s.id;
      pool.remove(s);
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fired, seatKeyId(key("p1")));
    assert.equal(pool.size, 0);
  });

  it("clears every timer on demand so a test cannot leak one", () => {
    const pool = new SeatPool({ maxSeats: 2, idleTtlMs: 10_000 });
    const seat = pool.reserve(key("p1"), "/tmp/p1");
    pool.promote(seat, "sess-1", fakeChild());
    pool.startIdleTimer(seat, () => {});
    pool.clearAllTimers();
    assert.equal(seat.idleTimer, null);
  });

  it("reclaims a reservation the caller forgot to release", () => {
    // A caller that throws between reserve() and promote() must not leak a cap
    // slot: three such leaks would brick the workspace for every project.
    let clock = 0;
    const pool = new SeatPool({
      maxSeats: 1,
      idleTtlMs: 10_000,
      provisionalTtlMs: 50,
      now: () => clock,
    });
    pool.reserve(key("p1"), "/tmp/p1");
    assert.equal(pool.size, 1);
    assert.throws(() => pool.reserve(key("p2"), "/tmp/p2"), SeatCapError);

    clock = 100;
    assert.equal(pool.sweepProvisional(), 1, "the stale reservation must be reclaimed");
    assert.equal(pool.size, 0);
    assert.doesNotThrow(() => pool.reserve(key("p2"), "/tmp/p2"));
  });

  it("does not confuse a stale reservation with an active session", () => {
    const pool = new SeatPool({ maxSeats: 2, idleTtlMs: 1000 });
    const seat = pool.reserve(key("p1"), "/tmp/p1");
    try {
      pool.reserve(key("p1"), "/tmp/p1");
      assert.fail("a second reservation for the same key must be refused");
    } catch (err) {
      assert.ok(err instanceof SeatBusyError);
      assert.equal(err.state, "provisional");
      assert.match(err.message, /in-flight reservation/);
      assert.doesNotMatch(err.message, /active session/);
    }
    assert.equal(pool.get(seat.id), null, "a provisional seat is not an active seat");
    assert.deepEqual(pool.list(), []);
  });

  it("ships a conservative local-first cap", () => {
    assert.ok(MAX_SEATS > 0 && MAX_SEATS <= 8, "cap must be bounded for local hardware");
    assert.ok(
      SEAT_PROVISIONAL_TTL_MS > SESSION_OPEN_DEADLINE_MS,
      "a reservation must outlive a cold session/new, or a slow open is reclaimed mid-flight",
    );
  });
});
