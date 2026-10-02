import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AttachmentManifestEntry } from "@k5-work/shared";

// Protocol translation only: k5's spool plus a capability flag in, ACP content
// blocks out. No I/O and no session state, so every rule below is testable
// without a harness, which is the only way to pin a rule that is invisible on
// the happy path.

export interface PlannedPrompt {
  readonly blocks: ContentBlock[];
  /** Attachments that were dropped, with the one reason this module has. */
  readonly refused: readonly { name: string; reason: "no-embedded-context" }[];
}

/**
 * A k5-minted, opaque handle rather than the file's real location.
 *
 * The harness runs on the same host and can see the store, but a prompt block
 * that carried `/home/k5/.local/share/...` would be a path handed to a model and
 * echoed into the transcript, and it would break the moment the store moved. The
 * bytes are inlined instead, so nothing needs to open anything.
 */
function attachmentUri(attachmentId: string): string {
  return `k5-attachment:${attachmentId}`;
}

/**
 * A Linux filename may legally contain a newline, a control sequence and a bidi
 * override, and a name reaches the model inside a text block, so it is stripped
 * here rather than at the edges: the manifest is the same string, so sanitising
 * here is the last point before harness-adjacent text.
 */
function harnessSafeName(raw: string): string {
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return stripped.length > 0 ? stripped : "attachment";
}

/**
 * ACP's `resource` block has no `name` field — only `uri`, `mimeType` and the
 * payload — so the filename has nowhere else to go. A harness that renders the
 * prompt therefore needs a text block saying what was attached, or the model sees
 * eight anonymous blobs and the user cannot say which one is the screenshot.
 */
function attachedListing(manifests: readonly AttachmentManifestEntry[]): string {
  const lines = manifests.map(
    (entry) =>
      `- ${harnessSafeName(entry.name)} (${entry.mimeType}, ${String(entry.size)} bytes)`,
  );
  return `Attached files:\n${lines.join("\n")}\n`;
}

export function planPromptBlocks(input: {
  readonly text: string;
  readonly attachments: readonly { manifest: AttachmentManifestEntry; bytes: Buffer }[];
  readonly caps: { readonly embeddedContext: boolean };
}): PlannedPrompt {
  const blocks: ContentBlock[] = [{ type: "text", text: input.text }];
  if (input.attachments.length === 0) {
    return { blocks, refused: [] };
  }

  const manifests = input.attachments.map((entry) => entry.manifest);
  blocks.push({ type: "text", text: attachedListing(manifests) });

  // `resource` is the only variant that carries the bytes inline, and it is
  // exactly the variant gated on promptCapabilities.embeddedContext. Without that
  // capability the harness may drop the block, which would leave a turn that
  // claims an attachment the model never saw — so the whole turn is refused
  // instead, and the text still goes out.
  if (!input.caps.embeddedContext) {
    return {
      blocks,
      refused: manifests.map((manifest) => ({
        name: manifest.name,
        reason: "no-embedded-context" as const,
      })),
    };
  }

  for (const { manifest, bytes } of input.attachments) {
    // `resource_link` is deliberately never emitted. It renders as a real
    // attachment and carries no content: it is a path the agent is expected to
    // open itself, and k5 advertises clientCapabilities.fs.readTextFile: false,
    // so a harness asking for one is asking k5 to read a file off its own disk
    // and gets an error. Inline bytes work; a link to a path k5 will not serve
    // is an attachment that delivers nothing.
    const uri = attachmentUri(manifest.attachmentId);
    if (manifest.kind === "text") {
      blocks.push({
        type: "resource",
        resource: { uri, text: new TextDecoder("utf-8").decode(bytes), mimeType: manifest.mimeType },
      });
      continue;
    }
    // An image travels as a resource rather than an `image` block: that keeps one
    // capability gate for every kind, and the mime type is already known.
    blocks.push({
      type: "resource",
      resource: { uri, blob: bytes.toString("base64"), mimeType: manifest.mimeType },
    });
  }

  return { blocks, refused: [] };
}
