import type { AcpChild } from "./spawn.js";

// Tracks every live harness child so process teardown can reap it. Kept
// deliberately small: it owns liveness and nothing else, so it cannot grow into
// the seat pool's policy decisions.
export class SeatRegistry {
  private readonly seats = new Map<number, AcpChild>();

  register(child: AcpChild): void {
    if (child.pid === undefined) return;
    this.seats.set(child.pid, child);
    void child.exited.then(() => {
      if (child.pid !== undefined) this.seats.delete(child.pid);
    });
  }

  /** Forgets a child that was already reaped on its normal path. */
  unregister(child: AcpChild | null): void {
    if (child?.pid !== undefined) this.seats.delete(child.pid);
  }

  get size(): number {
    return this.seats.size;
  }

  pids(): number[] {
    return [...this.seats.keys()];
  }

  /**
   * Reaps every tracked child. Returns the PIDs that survived, so a partial
   * teardown is reportable rather than silent.
   */
  async closeAll(): Promise<number[]> {
    const survivors: number[] = [];
    const children = [...this.seats.values()];
    this.seats.clear();

    for (const child of children) {
      const result = await child.close();
      if (!result.reaped && child.pid !== undefined) survivors.push(child.pid);
    }
    return survivors;
  }
}
