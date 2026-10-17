import { z } from "zod";
import { ComposerAccessLabelSchema } from "./access.js";
import { ResolvedPostureSchema } from "./contracts.js";

export const MAX_XLSX_SHEETS = 10;
export const MAX_XLSX_ROWS = 1000;
export const MAX_XLSX_COLUMNS = 32;
export const MAX_XLSX_CELLS = 10000;
export const MAX_XLSX_SHEET_NAME_CHARS = 31;
export const MAX_XLSX_CELL_TEXT = 8000;
export const MAX_XLSX_FILENAME_CHARS = 128;

export const XlsxCellValueSchema = z.union([
  z.string().max(MAX_XLSX_CELL_TEXT),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type XlsxCellValue = z.infer<typeof XlsxCellValueSchema>;

export const XlsxCellSchema = z.object({
  value: XlsxCellValueSchema.default(null),
}).strict();
export type XlsxCell = z.infer<typeof XlsxCellSchema>;

export const XlsxSheetSchema = z.object({
  name: z.string().min(1).max(MAX_XLSX_SHEET_NAME_CHARS),
  rows: z.array(z.array(XlsxCellSchema).max(MAX_XLSX_COLUMNS)).max(MAX_XLSX_ROWS),
}).strict();
export type XlsxSheet = z.infer<typeof XlsxSheetSchema>;

export const XlsxWorkbookSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  author: z.string().min(1).max(200).optional(),
  sheets: z.array(XlsxSheetSchema).min(1).max(MAX_XLSX_SHEETS),
}).strict().superRefine((workbook, ctx) => {
  const names = workbook.sheets.map((s) => s.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sheets"], message: "sheet names must be unique" });
  }
  for (const sheet of workbook.sheets) {
    if (/[\\/?*[\]:]/.test(sheet.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sheets"], message: `sheet name "${sheet.name}" contains an invalid character` });
    }
  }
  const total = workbook.sheets.reduce((sum, sheet) => sum + sheet.rows.reduce((r, row) => r + row.length, 0), 0);
  if (total > MAX_XLSX_CELLS) {
    ctx.addIssue({ code: z.ZodIssueCode.too_big, maximum: MAX_XLSX_CELLS, type: "array", inclusive: true, path: ["sheets"], message: `this workbook emits ${String(total)} cells, over the budget of ${String(MAX_XLSX_CELLS)}` });
  }
});
export type XlsxWorkbook = z.infer<typeof XlsxWorkbookSchema>;

export function workbookCellCount(workbook: XlsxWorkbook): number {
  return workbook.sheets.reduce((sum, sheet) => sum + sheet.rows.reduce((r, row) => r + row.length, 0), 0);
}

export const CREATE_XLSX_TOOL = "create_xlsx";

export const XLSX_TOOL_ENV = {
  projectRoot: "K5_XLSX_PROJECT_ROOT",
  profile: "K5_XLSX_PROFILE",
  posture: "K5_XLSX_POSTURE",
} as const;

export const XLSX_TOOL_RATE_LIMIT = 20;
export const XLSX_TOOL_RATE_WINDOW_MS = 10000;

export const CreateXlsxArgsSchema = z.object({
  filename: z.string().min(1).max(MAX_XLSX_FILENAME_CHARS).regex(/\.xlsx$/i, "the filename must end in .xlsx"),
  workbook: XlsxWorkbookSchema,
}).strict();
export type CreateXlsxArgs = z.infer<typeof CreateXlsxArgsSchema>;

export const CreateXlsxResultSchema = z.object({
  path: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  reused: z.boolean(),
}).strict();
export type CreateXlsxResult = z.infer<typeof CreateXlsxResultSchema>;

export const XlsxToolRuntimeSchema = z.object({
  projectRoot: z.string().min(1),
  profile: ComposerAccessLabelSchema,
  posture: ResolvedPostureSchema,
}).strict();
export type XlsxToolRuntime = z.infer<typeof XlsxToolRuntimeSchema>;

export const XLSX_WRITE_PERMISSIONS = ["edit", "write"] as const;

export function xlsxPosturePermitsWrites(posture: XlsxToolRuntime["posture"]): boolean {
  if (posture.wildcardAllow) return true;
  return posture.allowedTools.some((tool) => (XLSX_WRITE_PERMISSIONS as readonly string[]).includes(tool));
}