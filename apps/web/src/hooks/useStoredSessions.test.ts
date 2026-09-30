import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { SessionEventsResponse, ServerEvent } from "@k5-work/shared";
import { readStoredTranscript, isUnrecorded } from "./useStoredSessions";

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

afterEach(() => {
  fetchCalls = 0;
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

function event(seq: number, type: "turn.started" | "turn.delta" | "turn.completed", text = ""): ServerEvent {
  if (type === "turn.started") {
    return { type, sessionId: "ses", turnId: `t${String(seq)}`, attachments: [], userText: `q${String(seq)}` };
  }
  if (type === "turn.completed") {
    return { type, sessionId: "ses", turnId: `t${String(seq)}`, stopReason: "end_turn" };
  }
  return { type, sessionId: "ses", turnId: `t${String(seq)}`, stream: "text", text };
}

function page(
  overrides: Partial<SessionEventsResponse> & { events: SessionEventsResponse["events"] },
): SessionEventsResponse {
  return {
    storeId: "11111111-1111-4111-8111-111111111111",
    status: "appended",
    firstSeq: 1,
    lastSeq: 3,
    nextSince: 3,
    hasMore: false,
    dropped: 0,
    ...overrides,
  } as SessionEventsResponse;
}

/** Serves a fixed script of responses, recording the `since` each request asked for. */
function serveScript(responses: SessionEventsResponse[]): { since: (string | null)[] } {
  const since: (string | null)[] = [];
  let index = 0;
  vi.stubGlobal("fetch", (_url: string, init?: { method?: string }) => {
    if (init?.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    fetchCalls += 1;
    const query = new URL(String(_url), "http://k5.invalid").searchParams.get("since");
    since.push(query);
    const body = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return { since };
}

describe("readStoredTranscript", () => {
  it("treats the all-zero store id as nothing to fetch", async () => {
    // The server sends that id when no recorder is wired, so a fetch would be a
    // guaranteed 404 on every reconnect.
    expect(isUnrecorded(null)).toBe(true);
    expect(isUnrecorded("00000000-0000-4000-8000-000000000000")).toBe(true);
    expect(isUnrecorded("11111111-1111-4111-8111-111111111111")).toBe(false);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await readStoredTranscript("00000000-0000-4000-8000-000000000000");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.transcript.turns).toHaveLength(0);
  });

  it("pages with the cursor the store hands back", async () => {
    const first = page({
      events: [
        { seq: 1, ts: "t", event: event(1, "turn.started") },
        { seq: 2, ts: "t", event: event(1, "turn.delta", "one") },
      ],
      nextSince: 2,
      hasMore: true,
      lastSeq: 4,
    });
    const second = page({
      events: [
        { seq: 3, ts: "t", event: event(1, "turn.completed") },
        { seq: 4, ts: "t", event: event(2, "turn.started") },
      ],
      nextSince: 4,
      hasMore: false,
      lastSeq: 4,
    });
    const { since } = serveScript([first, second]);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111");
    // The first request asks for everything, the second resumes at the cursor.
    expect(since).toEqual([null, "2"]);
    expect(result.nextSince).toBe(4);
    expect(result.transcript.turns[0]?.assistantText).toBe("one");
  });

  it("restarts from the beginning when the store says the cursor is unusable", async () => {
    // A cursor past the end is a reset or a foreign cursor. Trusting it would
    // leave the client believing it had read a transcript it never saw.
    const impossible = page({ status: "cursor-invalid", events: [], nextSince: 99, lastSeq: 3 });
    const good = page({
      events: [{ seq: 1, ts: "t", event: event(1, "turn.delta", "recovered") }],
      nextSince: 1,
      hasMore: false,
      lastSeq: 1,
    });
    const { since } = serveScript([impossible, good]);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111", {
      since: 42,
    });
    expect(since[0]).toBe("42");
    expect(since.slice(1)).toContain(null);
    expect(result.rehydrateRequired).toBe(true);
    expect(result.transcript.turns[0]?.assistantText).toBe("recovered");
  });

  it("reports a store that says its records were compacted", async () => {
    const tooOld = page({ status: "cursor-too-old", events: [], nextSince: 0 });
    serveScript([tooOld]);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111", {
      since: 5,
    });
    // Nothing was returned, and the caller is told the cursor was not honoured.
    expect(result.transcript.turns).toHaveLength(0);
  });

  it("surfaces dropped records rather than presenting a partial history as whole", async () => {
    const lossy = page({
      events: [{ seq: 1, ts: "t", event: event(1, "turn.delta", "partial") }],
      nextSince: 1,
      hasMore: false,
      dropped: 3,
    });
    serveScript([lossy]);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111");
    expect(result.transcript.dropped).toBe(3);
    expect(result.transcript.turns[0]?.assistantText).toBe("partial");
  });

  it("throws rather than pretending, when the store cannot be read", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 503 })));
    await expect(readStoredTranscript("11111111-1111-4111-8111-111111111111")).rejects.toThrow(
      /could not be read/,
    );
  });

  it("stops paging when the store reports more but sends nothing new", async () => {
    // A store stuck on hasMore with a cursor that never advances used to be paged
    // to the page bound, which is the silent-partial case. Counted, not assumed.
    const empty = page({
      events: [],
      nextSince: 4,
      hasMore: true,
      lastSeq: 99,
    });
    serveScript([
      page({
        events: [{ seq: 1, ts: "t", event: event(1, "turn.delta", "x") }],
        nextSince: 1,
        hasMore: true,
        lastSeq: 99,
      }),
      empty,
    ]);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111");
    expect(result.transcript.turns[0]?.assistantText).toBe("x");
    expect(fetchCalls).toBe(2);
  });

  it("reports a transcript it could not finish reading as a prefix", async () => {
    // Otherwise the UI cannot tell a whole history from a fragment of one.
    serveScript([
      page({
        events: [{ seq: 1, ts: "t", event: event(1, "turn.delta", "x") }],
        nextSince: 1,
        hasMore: true,
        lastSeq: 99,
      }),
      page({ status: "cursor-invalid", events: [], nextSince: 99, lastSeq: 99 }),
    ]);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111");
    expect(result.transcript.truncated).toBe(true);
    expect(result.rehydrateRequired).toBe(true);
    // And the records already read are kept, not cleared away.
    expect(result.transcript.turns[0]?.assistantText).toBe("x");
    // One page, one restart attempt, then it gives up rather than looping.
    expect(fetchCalls).toBe(3);
  });

  it("does not erase a transcript when the restart also fails", async () => {
    // The discard is deferred until a restart actually returns a usable page.
    // Clearing eagerly turned a full transcript into an empty one with no error
    // anywhere, after the page bound.
    serveScript([
      page({
        events: [{ seq: 1, ts: "t", event: event(1, "turn.delta", "kept") }],
        nextSince: 1,
        hasMore: true,
        lastSeq: 1,
      }),
      page({ status: "cursor-invalid", events: [], nextSince: 5, lastSeq: 5 }),
    ]);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111", { since: 7 });
    expect(result.rehydrateRequired).toBe(true);
    expect(result.transcript.truncated).toBe(true);
    // What was read is still there, so a partial history beats none.
    expect(result.transcript.turns[0]?.assistantText).toBe("kept");
    // One page, one restart attempt, then it stops.
    expect(fetchCalls).toBe(3);
  });

  it("reports a transcript the page budget cut short as a prefix", async () => {
    // The store said there was more on the last page it served, and the reader
    // stopped anyway. That is a partial history whatever its record count says,
    // and the count used to stand in for it.
    serveScript(
      Array.from({ length: 200 }, (_unused, index) =>
        page({
          events: [{ seq: index + 1, ts: "t", event: event(index + 1, "turn.delta", `x${String(index)}`) }],
          nextSince: index + 1,
          hasMore: true,
          lastSeq: 100_000,
        }),
      ),
    );
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111");
    expect(fetchCalls).toBe(64);
    expect(result.transcript.truncated).toBe(true);
  });

  it("does not call a complete read a prefix because of its length", async () => {
    // The same 64 pages, but the store reported no more on the last one. This is
    // the case the record count could not tell apart from the one above.
    const responses = Array.from({ length: 63 }, (_unused, index) =>
      page({
        events: [{ seq: index + 1, ts: "t", event: event(index + 1, "turn.delta", `x${String(index)}`) }],
        nextSince: index + 1,
        hasMore: true,
        lastSeq: 63,
      }),
    );
    responses.push(
      page({
        events: [{ seq: 64, ts: "t", event: event(64, "turn.delta", "last") }],
        nextSince: 64,
        hasMore: false,
        lastSeq: 64,
      }),
    );
    serveScript(responses);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111");
    expect(fetchCalls).toBe(64);
    expect(result.transcript.truncated).toBe(false);
  });

  it("replaces the records once a restart returns a usable page", async () => {
    serveScript([
      page({
        events: [{ seq: 1, ts: "t", event: event(1, "turn.delta", "stale") }],
        nextSince: 1,
        hasMore: true,
        lastSeq: 1,
      }),
      page({ status: "cursor-invalid", events: [], nextSince: 9, lastSeq: 9 }),
      page({
        events: [{ seq: 1, ts: "t", event: event(1, "turn.delta", "fresh") }],
        nextSince: 1,
        hasMore: false,
        lastSeq: 1,
      }),
    ]);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111");
    expect(result.transcript.turns[0]?.assistantText).toBe("fresh");
    expect(result.rehydrateRequired).toBe(true);
  });
});

describe("stored transcript ordering", () => {
  it("collects pages in sequence order, however they arrive", async () => {
    // The projection orders turns by first appearance, so a log that arrived out of
    // order would render the conversation backwards. A second page whose records
    // interleave with the first must still come out ascending.
    serveScript([
      page({
        events: [
          { seq: 3, ts: "t", event: event(1, "turn.delta", "third") },
          { seq: 1, ts: "t", event: event(1, "turn.started") },
        ],
        nextSince: 3,
        hasMore: true,
        lastSeq: 5,
      }),
      page({
        events: [
          { seq: 5, ts: "t", event: event(1, "turn.completed") },
          { seq: 4, ts: "t", event: event(1, "turn.delta", "fourth") },
        ],
        nextSince: 5,
        hasMore: false,
        lastSeq: 5,
      }),
    ]);
    const result = await readStoredTranscript("11111111-1111-4111-8111-111111111111");
    assert.equal(result.transcript.turns[0]?.assistantText, "thirdfourth");
  });
});
