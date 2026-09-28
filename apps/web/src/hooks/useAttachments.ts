import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  UploadedAttachmentSchema,
  type AttachmentManifestEntry,
} from "@k5-work/shared";

// The write side of a session's attachment spool.
//
// The bytes go as the raw request body — not JSON, not multipart, not base64 —
// with `name` and `mime` in the query, because that is the shape the endpoint
// reads. Base64 would add a third again to a cap the user can already feel.

/** A picked or dropped file usually carries no type at all. */
const FALLBACK_MIME = "application/octet-stream";

/** Derived from the shared cap, never written out as a second number. */
const MAX_ATTACHMENT_LABEL = `${String(Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024)))} MB`;

// The upload endpoint answers with a manifest entry. `shared` ships the response
// schema but no named response type, and the two schemas are the same object, so
// the manifest entry is what a caller actually receives.
export type UploadedAttachment = AttachmentManifestEntry;

/**
 * Refuses what the browser can judge for free, before a byte is read.
 *
 * The caps come from `shared` because a copy here is a number the browser and the
 * server can disagree about, and the user pays for that disagreement in a 413
 * with no explanation after a 25 MB upload.
 */
function assertWithinBudget(files: readonly File[]): void {
  if (files.length > MAX_ATTACHMENTS) {
    throw new Error(
      `A prompt can carry ${String(MAX_ATTACHMENTS)} attachments at most. Remove ${String(
        files.length - MAX_ATTACHMENTS,
      )} and send again.`,
    );
  }
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `${file.name} is larger than ${MAX_ATTACHMENT_LABEL}. Attach a smaller file.`,
      );
    }
  }
}

/** Reads `{ error }` out of a refusal body without asserting its shape. */
function serverReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const reason: unknown = Reflect.get(body, "error");
  return typeof reason === "string" ? reason : null;
}

/**
 * A refusal the user can act on.
 *
 * The server is the authority on why — it read the bytes and it knows the
 * store's own cap — so its message is the one shown, with the file named so a
 * three-file prompt says which one lost.
 */
async function refusalFor(response: Response, file: File): Promise<Error> {
  let reason: string | null = null;
  try {
    reason = serverReason(await response.json());
  } catch {
    // Something between here and the server answered with a body that is not
    // JSON. The status still carries the failure.
  }
  return new Error(
    reason === null
      ? `${file.name} could not be attached (the server answered ${String(response.status)})`
      : `${file.name} could not be attached: ${reason}`,
  );
}

async function uploadOne(
  storeId: string,
  file: File,
  signal: AbortSignal | undefined,
): Promise<UploadedAttachment> {
  const mime = file.type || FALLBACK_MIME;
  // URLSearchParams, not string concatenation: a name carrying `&` or `#` would
  // otherwise truncate the query and the server would refuse an upload it could
  // have accepted.
  const query = new URLSearchParams({ name: file.name, mime });
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(storeId)}/attachments?${query.toString()}`,
    {
      method: "POST",
      // The File itself, so the browser streams what the user picked rather than
      // a re-encoded copy of it.
      body: file,
      headers: { "Content-Type": mime },
      signal,
    },
  );
  if (!response.ok) throw await refusalFor(response, file);
  return UploadedAttachmentSchema.parse(await response.json());
}

/**
 * Best-effort removal of a spooled attachment.
 *
 * The endpoint exists so this is possible at all; a spooled file with no
 * referring prompt has no other way out except deleting the entire task. A failed
 * discard is deliberately not reported: the caller already has a real error to
 * show, and a second failure about a file the user never knew existed is noise.
 */
async function discardAttachment(storeId: string, attachmentId: string): Promise<void> {
  try {
    await fetch(
      `/api/sessions/${encodeURIComponent(storeId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
    );
  } catch {
    // The bytes are the server's to reap; the store evicts a session whole anyway.
  }
}

/**
 * Spools files into a session and returns what the server recorded for each.
 *
 * `storeId` is k5's own id, not the harness's session id: the spool lives in the
 * store, and a session may not exist yet when a file is picked, which is why the
 * bytes travel here at send time rather than at pick time.
 *
 * A partial success is a leak, so it is undone. `Promise.all` on three files where
 * the second is refused leaves two attachments spooled, referenced by nothing,
 * and the caller never learns their ids. They would sit there until the whole
 * task is deleted. So the batch is settled rather than raced, and whatever
 * succeeded is given back before the failure is reported.
 */
export async function uploadAttachments(
  storeId: string,
  files: readonly File[],
  init: { readonly signal?: AbortSignal } = {},
): Promise<UploadedAttachment[]> {
  assertWithinBudget(files);
  const settled = await Promise.allSettled(
    files.map((file) => uploadOne(storeId, file, init.signal)),
  );
  const uploaded = settled.filter(
    (result): result is PromiseFulfilledResult<UploadedAttachment> => result.status === "fulfilled",
  );
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure === undefined) return uploaded.map((result) => result.value);
  await Promise.all(
    uploaded.map((result) => discardAttachment(storeId, result.value.attachmentId)),
  );
  throw failure.reason;
}
