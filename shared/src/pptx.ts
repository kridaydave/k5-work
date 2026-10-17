import { z } from "zod";
import { ComposerAccessLabelSchema } from "./access.js";
import { ResolvedPostureSchema } from "./contracts.js";

export const MAX_PPTX_SLIDES = 50;
export const MAX_PPTX_SLIDE_TITLE_CHARS = 200;
export const MAX_PPTX_TEXT_CHARS = 8000;
export const MAX_PPTX_BULLETS = 100;
export const MAX_PPTX_FILENAME_CHARS = 128;

export const PptxSlideSchema = z
  .object({
    title: z.string().min(1).max(MAX_PPTX_SLIDE_TITLE_CHARS).optional(),
    body: z.string().max(MAX_PPTX_TEXT_CHARS).optional(),
    text: z.string().max(MAX_PPTX_TEXT_CHARS).optional(),
    content: z.string().max(MAX_PPTX_TEXT_CHARS).optional(),
    bullets: z.array(z.string().min(1).max(MAX_PPTX_TEXT_CHARS)).max(MAX_PPTX_BULLETS).optional(),
    items: z.array(z.string().min(1).max(MAX_PPTX_TEXT_CHARS)).max(MAX_PPTX_BULLETS).optional(),
    lines: z.array(z.string().min(1).max(MAX_PPTX_TEXT_CHARS)).max(MAX_PPTX_BULLETS).optional(),
  })
  .strict();
export type PptxSlide = z.infer<typeof PptxSlideSchema>;

export const PptxPresentationSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    subject: z.string().min(1).max(200).optional(),
    author: z.string().min(1).max(200).optional(),
    creator: z.string().min(1).max(200).optional(),
    slides: z.array(PptxSlideSchema).min(1).max(MAX_PPTX_SLIDES),
  })
  .strict();
export type PptxPresentation = z.infer<typeof PptxPresentationSchema>;

export const PptxDeckSchema = PptxPresentationSchema;
export type PptxDeck = PptxPresentation;

export const CREATE_PPTX_TOOL = "create_pptx";

export const PPTX_TOOL_ENV = {
  projectRoot: "K5_PPTX_PROJECT_ROOT",
  profile: "K5_PPTX_PROFILE",
  posture: "K5_PPTX_POSTURE",
} as const;

export const PPTX_TOOL_RATE_LIMIT = 20;
export const PPTX_TOOL_RATE_WINDOW_MS = 10000;

export const CreatePptxArgsSchema = z
  .object({
    filename: z.string().min(1).max(MAX_PPTX_FILENAME_CHARS).regex(/\.pptx$/i, "the filename must end in .pptx"),
    presentation: PptxPresentationSchema,
  })
  .strict();
export type CreatePptxArgs = z.infer<typeof CreatePptxArgsSchema>;

export const CreatePptxResultSchema = z
  .object({
    path: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    reused: z.boolean(),
  })
  .strict();
export type CreatePptxResult = z.infer<typeof CreatePptxResultSchema>;

export const PptxToolRuntimeSchema = z
  .object({
    projectRoot: z.string().min(1),
    profile: ComposerAccessLabelSchema,
    posture: ResolvedPostureSchema,
  })
  .strict();
export type PptxToolRuntime = z.infer<typeof PptxToolRuntimeSchema>;

export const PPTX_WRITE_PERMISSIONS = ["edit", "write"] as const;

export function pptxPosturePermitsWrites(posture: PptxToolRuntime["posture"]): boolean {
  if (posture.wildcardAllow) return true;
  return posture.allowedTools.some((tool) => (PPTX_WRITE_PERMISSIONS as readonly string[]).includes(tool));
}
