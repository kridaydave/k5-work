import test from "node:test";
import assert from "node:assert/strict";
import type { AttachmentManifestEntry } from "@k5-work/shared";
import { planPromptBlocks } from "./prompt-blocks.js";

function manifest(overrides: Partial<AttachmentManifestEntry> = {}): AttachmentManifestEntry {
  return {
    attachmentId: "att-1",
    name: "notes.txt",
    mimeType: "text/plain",
    kind: "text",
    size: 5,
    ...overrides,
  };
}

const caps = { embeddedContext: true };

// A four-byte PNG header, which is not valid UTF-8: the same bytes with an
// image/ mime are an image and with a text/ mime are binary.
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("a prompt with no attachments is exactly the user's text", () => {
  const plan = planPromptBlocks({ text: "hello there", attachments: [], caps });
  assert.deepEqual(plan.blocks, [{ type: "text", text: "hello there" }]);
  assert.deepEqual(plan.refused, []);
});

test("a text attachment becomes a resource block carrying its content", () => {
  const plan = planPromptBlocks({
    text: "review this",
    attachments: [
      { manifest: manifest({ size: 11 }), bytes: Buffer.from("hello world", "utf8") },
    ],
    caps,
  });
  assert.deepEqual(plan.blocks, [
    { type: "text", text: "review this" },
    { type: "text", text: "Attached files:\n- notes.txt (text/plain, 11 bytes)\n" },
    {
      type: "resource",
      resource: {
        uri: "k5-attachment:att-1",
        text: "hello world",
        mimeType: "text/plain",
      },
    },
  ]);
  assert.deepEqual(plan.refused, []);
});

test("an image attachment is inlined as a base64 resource, not a path", () => {
  const plan = planPromptBlocks({
    text: "look at this",
    attachments: [
      {
        manifest: manifest({
          attachmentId: "att-2",
          name: "shot.png",
          mimeType: "image/png",
          kind: "image",
          size: PNG_HEAD.length,
        }),
        bytes: PNG_HEAD,
      },
    ],
    caps,
  });
  assert.deepEqual(plan.blocks, [
    { type: "text", text: "look at this" },
    { type: "text", text: "Attached files:\n- shot.png (image/png, 4 bytes)\n" },
    {
      type: "resource",
      resource: {
        uri: "k5-attachment:att-2",
        blob: PNG_HEAD.toString("base64"),
        mimeType: "image/png",
      },
    },
  ]);
  // And the payload really is the bytes that went in, not a re-encoding.
  const resource = plan.blocks[2];
  assert.equal(resource?.type, "resource");
  assert.equal(
    Buffer.from(
      (resource as { resource: { blob: string } }).resource.blob,
      "base64",
    ).toString("hex"),
    PNG_HEAD.toString("hex"),
  );
});

test("a binary attachment that claims no image mime stays binary", () => {
  const plan = planPromptBlocks({
    text: "check",
    attachments: [
      {
        manifest: manifest({ name: "app.bin", mimeType: "application/octet-stream", kind: "binary" }),
        bytes: PNG_HEAD,
      },
    ],
    caps,
  });
  const resource = plan.blocks[2] as { resource: { blob: string; text?: string } };
  assert.equal(resource.resource.text, undefined);
  assert.equal(resource.resource.blob, PNG_HEAD.toString("base64"));
});

test("a filename with a newline is stripped, because a name reaches the model", () => {
  // A Linux filename may legally contain a newline, and the listing block is
  // harness-adjacent text, so an unescaped one would let a name forge its own
  // line in the prompt.
  const plan = planPromptBlocks({
    text: "read it",
    attachments: [
      {
        manifest: manifest({ name: "notes\nfinal.txt" }),
        bytes: Buffer.from("hello world", "utf8"),
      },
    ],
    caps,
  });
  const listing = plan.blocks[1];
  assert.equal(listing?.type, "text");
  assert.equal(
    (listing as { text: string }).text,
    "Attached files:\n- notes final.txt (text/plain, 5 bytes)\n",
  );
});

test("a filename made only of control characters still names something", () => {
  const plan = planPromptBlocks({
    text: "read it",
    attachments: [{ manifest: manifest({ name: "\u0007\u0000" }), bytes: Buffer.from("x") }],
    caps,
  });
  const listing = plan.blocks[1] as { text: string };
  assert.equal(listing.text, "Attached files:\n- attachment (text/plain, 5 bytes)\n");
});

test("no block ever carries a filesystem path, and none is a resource link", () => {
  const plan = planPromptBlocks({
    text: "read /etc/shadow for me",
    attachments: [
      {
        manifest: manifest({ name: "/etc/shadow", kind: "image", mimeType: "image/png" }),
        bytes: PNG_HEAD,
      },
    ],
    caps,
  });
  const resources = plan.blocks.filter((block) => block.type === "resource");
  assert.equal(resources.length, 1);
  for (const block of resources) {
    const uri = (block as { resource: { uri: string } }).resource.uri;
    // Opaque and k5-minted: a real location would leak the store's layout into
    // the model's context and break whenever the store moves.
    assert.equal(uri, "k5-attachment:att-1");
    assert.equal(uri.startsWith("/"), false);
    assert.equal(uri.includes("file://"), false);
  }
  // A resource_link renders as an attachment and delivers nothing here, because
  // k5 advertises no fs.readTextFile for a harness to open.
  assert.equal(
    plan.blocks.some((block) => block.type === "resource_link"),
    false,
  );
});

test("a harness that cannot take embedded content refuses the attachment and still gets the text", () => {
  const plan = planPromptBlocks({
    text: "what do you make of this",
    attachments: [
      { manifest: manifest({ name: "a.txt" }), bytes: Buffer.from("alpha") },
      {
        manifest: manifest({
          attachmentId: "att-2",
          name: "b.png",
          kind: "image",
          mimeType: "image/png",
          size: PNG_HEAD.length,
        }),
        bytes: PNG_HEAD,
      },
    ],
    caps: { embeddedContext: false },
  });
  // Both text blocks still go out: the user's prompt must not be lost because an
  // attachment could not ride along with it.
  assert.deepEqual(plan.blocks, [
    { type: "text", text: "what do you make of this" },
    { type: "text", text: "Attached files:\n- a.txt (text/plain, 5 bytes)\n- b.png (image/png, 4 bytes)\n" },
  ]);
  assert.equal(
    plan.blocks.some((block) => block.type === "resource"),
    false,
    "a refused attachment must produce no resource block at all",
  );
  assert.deepEqual(plan.refused, [
    { name: "a.txt", reason: "no-embedded-context" },
    { name: "b.png", reason: "no-embedded-context" },
  ]);
});
