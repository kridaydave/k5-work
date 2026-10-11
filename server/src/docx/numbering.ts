// word/numbering.xml. A real list, not a literal bullet character typed into
// a run: the standard for this is a strict sequence, and it is exactly the
// sequence no reader in this repo can check for us, so the fixtures carry it.
//
// A paragraph joins a list through w:numPr, which names a w:num. The w:num
// points at a w:abstractNum that defines the levels. Restarting a list is a
// fresh w:num, because a fresh numId is a fresh counter, so nothing here needs
// a w:lvlOverride to make the second list in a document start at one again.
//
// Every definition declares all nine levels, because that is the number the
// model allows and Word writes. A definition may legally declare fewer, but
// then an item at a level the definition does not have points at a w:lvl that
// does not exist, and the reader drops it silently: the text still reads
// correctly and nothing complains.
import type { Block, ListBlock } from "@k5-work/shared";
import { MAX_LIST_LEVELS } from "@k5-work/shared";
import { doc, el } from "../ooxml-core/xml.js";
import { W_NS } from "./names.js";

// Fixed so the same JSON gives the same bytes. ST_LongHexNumber is exactly
// eight hex digits, and nsid only has to be stable, not unique.
const NSID = "4B5D0900";

/**
 * One abstract definition per format, emitted only when the document uses it.
 * The ids are fixed so the output is deterministic and so the vocabulary layer
 * can compute the pairing without being handed a plan.
 */
const ABSTRACT_ID = { bullet: 0, ordered: 1 } as const;
type ListFormat = keyof typeof ABSTRACT_ID;

/**
 * The w:numId for the list at this block index. Derived from the index rather
 * than allocated, so the numbering part and the document body agree without
 * threading state between them, and two lists never collide.
 */
export function numIdForListBlock(index: number): string {
  return String(index + 1);
}

function formatOf(block: ListBlock): ListFormat {
  return block.ordered ? "ordered" : "bullet";
}

interface Level {
  readonly fmt: string;
  readonly text: string;
}

/**
 * Plain Unicode rather than the Symbol and Wingdings glyphs Word uses, because
 * those only render when the font they name happens to be installed. Each
 * level indents one step further, in twips.
 */
const INDENT_STEP = 720;
const HANGING = 360;

const BULLET_GLYPHS = ["•", "◦", "▪", "◂", "○", "■", "◇", "☐", "▫"];

function bulletLevels(): Level[] {
  return BULLET_GLYPHS.map((text) => ({ fmt: "bullet", text }));
}

function orderedLevels(): Level[] {
  // A real list ladder: 1. then a. then i. then repeating as the depth grows.
  const formats = [
    "decimal",
    "lowerLetter",
    "lowerRoman",
    "decimal",
    "lowerLetter",
    "lowerRoman",
    "decimal",
    "lowerLetter",
    "lowerRoman",
  ];
  return formats.map((fmt, depth) => ({ fmt, text: `%${String(depth + 1)}.` }));
}

const LEVELS: Readonly<Record<ListFormat, readonly Level[]>> = {
  bullet: bulletLevels(),
  ordered: orderedLevels(),
};

/**
 * CT_Lvl order is start, numFmt, lvlRestart, pStyle, isLgl, suff, lvlText,
 * lvlPicBulletId, legacy, lvlJc, then w:pPr and w:rPr.
 */
function buildLevel(ilvl: number, level: Level): string {
  const indent = INDENT_STEP * (ilvl + 1);
  return el(
    "w:lvl",
    [["w:ilvl", String(ilvl)]],
    el("w:start", [["w:val", "1"]]) +
      el("w:numFmt", [["w:val", level.fmt]]) +
      el("w:lvlText", [["w:val", level.text]]) +
      el("w:lvlJc", [["w:val", "left"]]) +
      el(
        "w:pPr",
        [],
        el("w:ind", [["w:left", String(indent)], ["w:hanging", String(HANGING)]]),
      ),
  );
}

/** CT_AbstractNum: nsid, multiLevelType, tmpl, name, styleLink, numStyleLink, then the levels. */
function buildAbstract(format: ListFormat): string {
  const levels = LEVELS[format]
    .map((level, ilvl) => buildLevel(ilvl, level))
    .join("");
  return el(
    "w:abstractNum",
    [["w:abstractNumId", String(ABSTRACT_ID[format])]],
    el("w:nsid", [["w:val", NSID]]) +
      el("w:multiLevelType", [["w:val", "hybridMultilevel"]]) +
      levels,
  );
}

/** CT_Num is abstractNumId then any lvlOverride. A fresh num restarts on its own. */
function buildNum(numId: string, format: ListFormat): string {
  return el(
    "w:num",
    [["w:numId", numId]],
    el("w:abstractNumId", [["w:val", String(ABSTRACT_ID[format])]]),
  );
}

/** The formats this document uses, in a fixed order so the output is stable. */
function usedFormats(blocks: readonly Block[]): ListFormat[] {
  const formats: ListFormat[] = [];
  for (const block of blocks) {
    if (block.type !== "list") continue;
    const format = formatOf(block);
    if (!formats.includes(format)) formats.push(format);
  }
  return formats;
}

/**
 * Null when the document has no list, so the driver leaves the part out rather
 * than ship a numbering definition nothing points at, which the engine now
 * refuses.
 */
export function buildNumberingXml(blocks: readonly Block[]): string | null {
  const formats = usedFormats(blocks);
  if (formats.length === 0) return null;
  if (LEVELS.bullet.length !== MAX_LIST_LEVELS || LEVELS.ordered.length !== MAX_LIST_LEVELS) {
    throw new Error("the numbering definitions must declare every level the model allows");
  }

  const abstracts = formats.map(buildAbstract).join("");
  const nums = blocks
    .map((block, index) =>
      block.type === "list" ? buildNum(numIdForListBlock(index), formatOf(block)) : "",
    )
    .join("");
  // CT_Numbering is numPicBullet entries, then abstractNum entries, then num.
  return doc(el("w:numbering", [["xmlns:w", W_NS]], abstracts + nums));
}