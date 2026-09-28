import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENTS } from "@k5-work/shared";
import { Composer, type PromptSubmission } from "./Composer";
import type { Project } from "@k5-work/shared";

const project: Project = { id: "p-1", name: "k5-work", path: "/tmp/k5-work" };

function renderComposer(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const sent: PromptSubmission[] = [];
  const props: React.ComponentProps<typeof Composer> = {
    activeProject: project,
    projects: [project],
    settings: { model: "", mode: "", permissions: "full" },
    configOptions: null,
    onRequestProject: () => {},
    onSelectProject: () => {},
    onSettingsChange: () => {},
    onSend: async (submission) => {
      sent.push(submission);
      return true;
    },
    ...overrides,
  };
  const view = render(<Composer {...props} />);
  return { ...view, props, sent };
}

function paperclip(): HTMLElement {
  return screen.getByRole("button", { name: "Attach files" });
}

function promptField(): HTMLElement {
  return screen.getByLabelText("Describe what the agent should work on");
}

function notes(): File {
  return new File(["hello"], "notes.md", { type: "text/markdown" });
}

/** Drops files over the composer, which is how a user hands them over. */
function drop(files: File[]): void {
  fireEvent.drop(promptField(), { dataTransfer: { files, types: ["Files"] } });
}

async function send(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  });
}

describe("attaching files", () => {
  it("offers a live paperclip", () => {
    renderComposer();
    // A disabled control with the real name in its label is worse than no
    // control: it looks like the capability exists.
    expect(paperclip().getAttribute("disabled")).toBeNull();
    expect(paperclip().getAttribute("title")).toBe("Attach files");
  });

  it("opens the file chooser when the paperclip is pressed", () => {
    // jsdom has no file chooser, so the input being opened is the whole of what
    // is observable here.
    renderComposer();
    const chooser = screen.getByLabelText<HTMLInputElement>("Files to attach");
    const opened = vi.spyOn(chooser, "click");
    fireEvent.click(paperclip());
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("renders a chip for a picked file, and hands that same file up on send", async () => {
    const { sent } = renderComposer();
    const picked = notes();

    fireEvent.change(screen.getByLabelText<HTMLInputElement>("Files to attach"), {
      target: { files: [picked] },
    });
    // The chip describes the real file, not a placeholder for one.
    expect(screen.getByTitle("notes.md, 5 B")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove notes.md" })).toBeTruthy();

    fireEvent.change(promptField(), { target: { value: "summarise this" } });
    await send();
    expect(sent[0]?.attachments[0]).toBe(picked);
  });

  it("renders a chip for a dropped file", () => {
    renderComposer();
    drop([notes()]);
    expect(screen.getByText("notes.md")).toBeTruthy();
  });

  it("removes a chip when its remove button is pressed", () => {
    renderComposer();
    drop([notes()]);
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(screen.queryByText("notes.md")).toBeNull();
  });

  it("refuses the files that do not fit and says what to do about them", () => {
    renderComposer();
    drop(
      Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, index) =>
        new File(["x"], `f${String(index)}.txt`, { type: "text/plain" }),
      ),
    );
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(MAX_ATTACHMENTS);
    expect(screen.getByRole("alert").textContent).toContain(
      `a prompt can carry ${String(MAX_ATTACHMENTS)} attachments at most`,
    );
    expect(screen.getByRole("alert").textContent).toContain("add them back");
  });

  it("refuses a file over the cap before it becomes a chip", () => {
    renderComposer();
    drop([new File([new Uint8Array(26 * 1024 * 1024)], "huge.bin")]);
    expect(screen.queryByText("huge.bin")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("huge.bin is larger than 25 MB");
  });
});

describe("the reverse state after a send", () => {
  it("keeps the files and the text when the send was refused", async () => {
    // The chips are the only copy of these bytes before the upload, and a file the
    // user cannot re-pick is a file they cannot attach at all.
    renderComposer({ onSend: async () => false });
    drop([notes()]);
    fireEvent.change(promptField(), { target: { value: "summarise this" } });

    await send();

    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(promptField().getAttribute("value")).toBeNull();
    expect((promptField() as HTMLTextAreaElement).value).toBe("summarise this");
  });

  it("clears the files once the send is confirmed", async () => {
    const { sent } = renderComposer();
    drop([notes()]);
    fireEvent.change(promptField(), { target: { value: "summarise this" } });

    await send();

    expect(sent).toHaveLength(1);
    expect(screen.queryByText("notes.md")).toBeNull();
    expect((promptField() as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the files when the parent throws rather than reporting a refusal", async () => {
    renderComposer({
      onSend: async () => {
        throw new Error("the transport is gone");
      },
    });
    drop([notes()]);
    fireEvent.change(promptField(), { target: { value: "summarise this" } });

    await send();

    expect(screen.getByText("notes.md")).toBeTruthy();
  });

  it("puts a submission the parent hands back into the composer", async () => {
    // The deferred case: the seat was still opening, so the refusal arrived after
    // onSend had already resolved true.
    const picked = notes();
    const { rerender, props } = renderComposer();
    fireEvent.change(promptField(), { target: { value: "summarise this" } });
    drop([picked]);
    await send();
    expect(screen.queryByText("notes.md")).toBeNull();

    rerender(
      <Composer
        {...props}
        restore={{ id: 1, text: "summarise this", attachments: [picked] }}
      />,
    );

    expect(screen.getByTitle("notes.md, 5 B")).toBeTruthy();
    expect((promptField() as HTMLTextAreaElement).value).toBe("summarise this");
  });

  it("applies a handed-back submission once, not on every render", () => {
    const restore = { id: 7, text: "summarise this", attachments: [notes()] };
    const { rerender, props } = renderComposer({ restore });
    rerender(<Composer {...props} restore={{ ...restore }} />);
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
  });
});
