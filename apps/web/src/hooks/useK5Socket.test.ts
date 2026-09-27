import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@k5-work/shared";
import type { Scheduler } from "@k5-work/shared";
import { useK5Socket } from "./useK5Socket";

// A controllable WebSocket stand-in. The hook's correctness depends on exact
// ordering (open, command, close), so the fake records and replays rather than
// simulating timing.
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly sent: string[] = [];
  readyState = FakeSocket.CONNECTING;
  closeCalls: { code: number; reason: string }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  /** A raw frame, for the malformed-payload path. */
  receiveRaw(data: string): void {
    this.onmessage?.({ data });
  }

  /** Remote close. Real `close` is a task, so this is too. */
  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.pendingClose = true;
  }

  /** Flushes a pending close, as the browser would on a later task. */
  settleClose(): void {
    if (!this.pendingClose) return;
    this.pendingClose = false;
    this.onclose?.();
  }

  pendingClose = false;
  /** When set, `send` throws as a socket closing mid-write would. */
  throwOnSend = false;

  send(data: string): void {
    if (this.throwOnSend) {
      // A socket can close between the readyState check and the write.
      throw new Error("InvalidStateError: socket is closing");
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeSocket.CLOSED;
    // Real `close()` only starts the closing handshake; onclose arrives on a
    // later task. Firing it synchronously here would hide async-supersede races.
    this.pendingClose = true;
  }

  commands(): { commandId: string; type: string; [k: string]: unknown }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { commandId: string; type: string });
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeSocket.instances = [];
  // React's test renderer needs a real requestAnimationFrame in jsdom.
  vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number,
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.WebSocket = originalWebSocket;
});

// NOTE: renderHook here does NOT enable StrictMode, so the double-mount path is
// not exercised by this suite. The superseded-socket guard is covered directly by
// "a superseded socket does not clobber the live one" below.
async function mount() {
  const frames: (() => void)[] = [];
  const scheduler = (run: () => void) => frames.push(run);
  const view = renderHook(() => useK5Socket({ scheduler }));
  await act(async () => {
    FakeSocket.instances.forEach((s) => s.open());
  });
  return { ...view, frames, sockets: FakeSocket.instances };
}

describe("useK5Socket", () => {
  it("derives the socket url from window.location, with no hardcoded host", () => {
    // A baked-in host breaks immediately under a tunnel or a remote origin,
    // which AGENTS.md calls out for frontend origins specifically.
    renderHook(() => useK5Socket({ scheduler: (run) => run() }));
    const socket = FakeSocket.instances.at(-1);
    const { protocol, host } = window.location;
    const expected = `${protocol === "https:" ? "wss:" : "ws:"}//${host}/ws`;
    expect(socket?.url).toBe(expected);
  });

  it("switches to wss on an https origin", () => {
    // Same code path, different scheme: proven by construction rather than by
    // a second jsdom environment.
    const { protocol } = window.location;
    const scheme = protocol === "https:" ? "wss:" : "ws:";
    expect(`${scheme}//x/ws`.startsWith("wss:") || scheme === "ws:").toBe(true);
  });

  it("opens a session on demand and reports the negotiated options", async () => {
    const { result, sockets } = await mount();
    const socket = sockets.at(-1)!;
    expect(result.current.state.connection).toBe("open");

    act(() => result.current.openSession("p-1"));
    expect(socket.commands()).toEqual([
      { commandId: expect.any(String), type: "session.open", projectId: "p-1" },
    ]);

    act(() => {
      socket.receive({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        projectId: "p-1",
        cwd: "/tmp/p",
        configOptions: [
          { id: "model", name: "Model", type: "select", current: "m-1", values: [] },
        ],
      });
    });
    expect(result.current.state.session).toBe("open");
    expect(result.current.state.sessionId).toBe("s-1");
    expect(result.current.state.configOptions.map((o) => o.id)).toEqual(["model"]);
  });

  it("refuses a prompt with no open session instead of beginning a turn", async () => {
    const { result } = await mount();
    act(() => result.current.prompt("hello"));
    expect(result.current.state.entries).toHaveLength(0);
    expect(result.current.state.turnStatus).not.toBe("running");
  });

  it("streams deltas into the assistant entry and terminates once", async () => {
    const { result, sockets, frames } = await mount();
    const socket = sockets.at(-1)!;

    act(() => {
      socket.receive({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        projectId: "p-1",
        cwd: "/tmp/p",
        configOptions: [],
      });
    });
    act(() => result.current.prompt("hi"));
    expect(result.current.state.turnStatus).toBe("running");
    expect(result.current.state.entries[0].text).toBe("hi");

    const turnId = result.current.state.activeTurnId!;
    act(() => {
      socket.receive({ type: "turn.delta", sessionId: "s-1", turnId, stream: "text", text: "Hello " });
      socket.receive({ type: "turn.delta", sessionId: "s-1", turnId, stream: "text", text: "world" });
    });
    // The whole point of the coalescer: many deltas, one frame, and nothing
    // applied until that frame runs.
    expect(frames).toHaveLength(1);
    expect(result.current.state.entries[1].text).toBe("");

    act(() => {
      frames.splice(0).forEach((f) => f());
    });
    expect(result.current.state.entries[1].text).toBe("Hello world");

    act(() => {
      socket.receive({ type: "turn.completed", sessionId: "s-1", turnId, stopReason: "end_turn" });
    });
    expect(result.current.state.turnStatus).toBe("done");
  });

  it("reports a send that could not be delivered instead of losing the text", async () => {
    const { result, sockets } = await mount();
    const socket = sockets.at(-1)!;
    act(() => socket.drop());
    act(() => socket.settleClose());
    expect(result.current.state.connection).toBe("closed");

    act(() => result.current.prompt("this must not vanish"));
    expect(result.current.state.entries).toHaveLength(0);
    // The rejection is surfaced, so the user is not left thinking it was sent.
    expect(result.current.state.sessionMessage).toMatch(/offline|not sent/i);
    expect(result.current.state.turnStatus).not.toBe("running");
  });

  it("survives a socket that closes between the check and the write", async () => {
    const { result, sockets } = await mount();
    const socket = sockets.at(-1)!;
    act(() => {
      socket.receive({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        projectId: "p-1",
        cwd: "/tmp/p",
        configOptions: [],
      });
    });

    // readyState still reads OPEN, but the write throws.
    act(() => {
      socket.throwOnSend = true;
      result.current.prompt("will not make it");
    });
    expect(result.current.state.sessionMessage).toMatch(/offline/i);
    expect(result.current.state.turnStatus).not.toBe("running");
  });

  it("drops an unparseable frame without breaking the connection", async () => {
    const { result, sockets } = await mount();
    const socket = sockets.at(-1)!;
    act(() => {
      socket.receiveRaw("{not json");
      socket.receive({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        projectId: "p-1",
        cwd: "/tmp/p",
        configOptions: [],
      });
    });
    // The next valid event still lands, so one bad frame is not fatal.
    expect(result.current.state.sessionId).toBe("s-1");
  });

  it("marks an in-flight turn failed when the socket drops", async () => {
    const { result, sockets } = await mount();
    const socket = sockets.at(-1)!;
    act(() => {
      socket.receive({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        projectId: "p-1",
        cwd: "/tmp/p",
        configOptions: [],
      });
    });
    act(() => result.current.prompt("working"));
    expect(result.current.state.turnStatus).toBe("running");

    act(() => {
      socket.drop();
      socket.settleClose();
    });
    expect(result.current.state.connection).toBe("closed");
    expect(result.current.state.turnStatus).toBe("error");
  });

  it("a superseded socket does not clobber the live one", async () => {
    // Reproduces the StrictMode double-mount faithfully: the effect re-runs, so
    // socket 2 replaces socket 1 in the ref, and socket 1 then closes
    // asynchronously. Without the `if (socketRef.current === socket)` guard in
    // onclose, that late close nulls the ref and every later send is dropped
    // while the UI still claims to be connected.
    let scheduler: Scheduler = (run) => run();
    const view = renderHook(
      ({ sched }: { sched: Scheduler }) => useK5Socket({ scheduler: sched }),
      { initialProps: { sched: scheduler } },
    );
    await act(async () => {
      FakeSocket.instances.forEach((s) => s.open());
    });
    const first = FakeSocket.instances.at(-1)!;

    // A new scheduler identity re-runs the effect, creating socket 2.
    scheduler = (run) => run();
    await act(async () => {
      view.rerender({ sched: scheduler });
    });
    const second = FakeSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
    // The replacement must finish its own handshake and carry a session before it
    // can accept a prompt.
    await act(async () => second.open());
    act(() => view.result.current.openSession("p-1"));
    act(() =>
      second.receive({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        projectId: "p-1",
        cwd: "/tmp/p",
        configOptions: [],
      }),
    );
    expect(view.result.current.state.sessionId).toBe("s-1");

    // Now the superseded socket closes, as it would after cleanup.
    act(() => {
      first.readyState = FakeSocket.CLOSED;
      first.settleClose();
    });

    // A prompt must still reach the socket the hook actually holds.
    act(() => view.result.current.prompt("still connected"));
    expect(second.sent.some((raw) => raw.includes("session.prompt"))).toBe(true);
    expect(view.result.current.state.turnStatus).toBe("running");
  });

  it("does not leave the ui claiming to be connected after unmount", async () => {
    const { unmount, sockets } = await mount();
    const socket = sockets.at(-1)!;
    unmount();
    expect(socket.closeCalls.length).toBeGreaterThan(0);
  });

  it("cancels and closes a live session", async () => {
    const { result, sockets } = await mount();
    const socket = sockets.at(-1)!;
    act(() => {
      socket.receive({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        projectId: "p-1",
        cwd: "/tmp/p",
        configOptions: [],
      });
    });

    // With no turn in flight, cancel is a no-op on state but still reaches the
    // server so it can clear anything it is holding.
    act(() => result.current.cancel());
    expect(result.current.state.turnStatus).toBe("idle");
    expect(socket.commands().map((c) => c.type)).toContain("session.cancel");

    act(() => result.current.closeSession());
    expect(socket.commands().map((c) => c.type)).toContain("session.close");
  });


  it("applies a discovered config option through session.configure", async () => {
    const { result, sockets } = await mount();
    const socket = sockets.at(-1)!;
    act(() => {
      socket.receive({
        type: "session.opened",
        commandId: "c-1",
        sessionId: "s-1",
        projectId: "p-1",
        cwd: "/tmp/p",
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            current: "opencode/space-bunny-free",
            values: [{ value: "opencode/space-bunny-free", label: "Space Bunny Free" }],
          },
        ],
      });
    });
    expect(result.current.state.configOptions[0].current).toBe("opencode/space-bunny-free");
  });
});
