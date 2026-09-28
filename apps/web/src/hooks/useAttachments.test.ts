import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "@k5-work/shared";
import { uploadAttachments } from "./useAttachments";

const STORE_ID = "11111111-1111-4111-8111-111111111111";

type Recorded = { url: string; init: RequestInit };

/** Serves a fixed script of answers, recording every request that was made. */
function serveUploads(
  responses: { status: number; body: unknown }[],
): Recorded[] {
  const calls: Recorded[] = [];
  let index = 0;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)] ?? { status: 200, body: {} };
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return calls;
}

function manifest(attachmentId: string, name: string): unknown {
  return { attachmentId, name, mimeType: "text/plain", kind: "text", size: 4 };
}

function file(name: string, content = "abcd", type = "text/plain"): File {
  return new File([content], name, { type });
}

function queryOf(recorded: Recorded): URLSearchParams {
  return new URL(recorded.url, "http://k5.invalid").searchParams;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadAttachments", () => {
  it("sends the file itself as the body and names it in the query", async () => {
    // The endpoint reads the name and mime out of the query and a byte range out
    // of the stream, so a FormData or base64 body would be silently unreadable.
    const calls = serveUploads([{ status: 200, body: manifest("att-1", "notes.md") }]);
    const picked = file("notes.md", "abcd", "text/markdown");

    const uploaded = await uploadAttachments(STORE_ID, [picked]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(picked);
    expect(new Headers(calls[0]!.init.headers).get("Content-Type")).toBe("text/markdown");
    const query = queryOf(calls[0]!);
    expect(query.get("name")).toBe("notes.md");
    expect(query.get("mime")).toBe("text/markdown");
    expect(uploaded).toEqual([manifest("att-1", "notes.md")]);
  });

  it("encodes a name that would otherwise cut the query short", async () => {
    const calls = serveUploads([{ status: 200, body: manifest("att-1", "a&b c.txt") }]);
    await uploadAttachments(STORE_ID, [file("a&b c.txt")]);
    const query = queryOf(calls[0]!);
    // An unescaped `&` would read as a second parameter and the server would
    // refuse a file it could have accepted.
    expect(query.get("name")).toBe("a&b c.txt");
    expect(query.get("mime")).toBe("text/plain");
    expect(calls[0]!.url).toContain("&mime=");
  });

  it("falls back to octet-stream when the file carries no type", async () => {
    // A dropped file usually has `type === ""`, and the spool records a mime.
    const calls = serveUploads([{ status: 200, body: manifest("att-1", "blob") }]);
    const picked = file("blob", "abcd", "");

    await uploadAttachments(STORE_ID, [picked]);

    expect(queryOf(calls[0]!).get("mime")).toBe("application/octet-stream");
    expect(new Headers(calls[0]!.init.headers).get("Content-Type")).toBe(
      "application/octet-stream",
    );
  });

  it("refuses more attachments than a prompt can carry, before any request", async () => {
    const calls = serveUploads([]);
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) =>
      file(`f${String(index)}.txt`),
    );

    await expect(uploadAttachments(STORE_ID, many)).rejects.toThrow(
      new RegExp(`${String(MAX_ATTACHMENTS)} attachments at most`),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses an over-cap file before any request", async () => {
    const calls = serveUploads([]);
    const huge = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.bin", {
      type: "application/octet-stream",
    });

    await expect(uploadAttachments(STORE_ID, [huge])).rejects.toThrow(
      /huge\.bin is larger than 25 MB/,
    );
    expect(calls).toHaveLength(0);
  });

  it("reports the server's own reason for a refusal, naming the file", async () => {
    // The server read the bytes and knows the store's cap, so its message is the
    // one worth showing.
    serveUploads([{ status: 413, body: { error: "The attachment is too large" } }]);

    await expect(uploadAttachments(STORE_ID, [file("huge.bin")])).rejects.toThrow(
      /huge\.bin could not be attached: The attachment is too large/,
    );
  });

  it("falls back to the status when a refusal carries no message", async () => {
    serveUploads([{ status: 502, body: {} }]);

    await expect(uploadAttachments(STORE_ID, [file("notes.md")])).rejects.toThrow(
      /notes\.md could not be attached \(the server answered 502\)/,
    );
  });

  it("uploads every file and says which one failed", async () => {
    const calls = serveUploads([
      { status: 200, body: manifest("att-1", "one.txt") },
      { status: 200, body: manifest("att-2", "two.txt") },
    ]);

    const uploaded = await uploadAttachments(STORE_ID, [file("one.txt"), file("two.txt")]);

    expect(calls).toHaveLength(2);
    expect(uploaded.map((entry) => entry.attachmentId)).toEqual(["att-1", "att-2"]);
  });

  it("refuses a body the server sent that is not a manifest", async () => {
    // A 200 carrying junk must not become an attachmentId the prompt then cites.
    serveUploads([{ status: 200, body: { attachmentId: "att-1" } }]);

    await expect(uploadAttachments(STORE_ID, [file("one.txt")])).rejects.toThrow();
  });
  it("gives back the attachments that succeeded when one is refused", async () => {
    // A partial batch is a leak: the bytes are spooled inside the store, nothing
    // will ever reference them, and the only other way out is deleting the whole
    // task. So the ones that landed are removed before the failure is reported.
    const calls = serveUploads([
      { status: 200, body: manifest("a-1", "one.txt") },
      { status: 507, body: { error: "the session store is full" } },
      { status: 200, body: manifest("c-1", "three.txt") },
    ]);
    await expect(
      uploadAttachments(STORE_ID, [file("one.txt"), file("two.txt"), file("three.txt")]),
    ).rejects.toThrow(/the session store is full/);

    const deletes = calls.filter((c) => c.init.method === "DELETE");
    expect(deletes.map((c) => c.url.split("/").pop()).sort()).toEqual(["a-1", "c-1"]);
    // Every delete must be addressed to the attachment, not to the session.
    for (const del of deletes) {
      expect(new URL(del.url, "http://k5.invalid").pathname).toBe(
        `/api/sessions/${STORE_ID}/attachments/${del.url.split("/").pop()}`,
      );
    }
  });

  it("still reports the original failure when the give-back also fails", async () => {
    // A failed discard must not replace the error the user can act on.
    serveUploads([
      { status: 200, body: manifest("a-1", "one.txt") },
      { status: 507, body: { error: "the session store is full" } },
    ]);
    const script = globalThis.fetch as (u: string, i: RequestInit) => Promise<Response>;
    globalThis.fetch = ((url: string, init: RequestInit) =>
      init.method === "DELETE"
        ? Promise.reject(new Error("network down"))
        : script(url, init)) as unknown as typeof globalThis.fetch;
    await expect(
      uploadAttachments(STORE_ID, [file("one.txt"), file("two.txt")]),
    ).rejects.toThrow(/the session store is full/);
  });

});
