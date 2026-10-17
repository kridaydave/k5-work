import type { PptxPresentation, PptxSlide } from "@k5-work/shared";
import { el, escText } from "../ooxml-core/xml.js";
import { A_NS, P_NS, R_NS } from "./names.js";

function slideTextLines(slide: PptxSlide): string[] {
  const lines: string[] = [];
  const title = slide.title;
  if (title !== undefined) lines.push(title);
  const bodySources = [slide.body, slide.text, slide.content].filter(
    (value): value is string => value !== undefined,
  );
  for (const source of bodySources) {
    for (const line of source.split(/\r?\n/)) {
      if (line.length > 0) lines.push(line);
    }
  }
  for (const key of ["bullets", "items", "lines"] as const) {
    const arr = slide[key];
    if (arr !== undefined) {
      for (const item of arr) lines.push(`- ${item}`);
    }
  }
  return lines;
}

function textShape(id: number, name: string, x: number, y: number, cx: number, cy: number, sz: number, lines: readonly string[]): string {
  const paragraphs = lines
    .map((line) => `<a:p><a:r><a:rPr sz="${String(sz)}"/><a:t>${escText(line)}</a:t></a:r></a:p>`)
    .join("");
  return `<p:sp>
    <p:nvSpPr><p:cNvPr id="${String(id)}" name="${escText(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="${String(x)}" y="${String(y)}"/><a:ext cx="${String(cx)}" cy="${String(cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    <p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>
  </p:sp>`;
}

export function buildSlideXml(slide: PptxSlide): string {
  const shapes: string[] = [
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`,
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`,
  ];
  const allLines = slideTextLines(slide);
  if (allLines.length > 0) {
    shapes.push(textShape(2, "Content", 360000, 360000, 8424000, 5400000, 1800, allLines));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${A_NS}" xmlns:p="${P_NS}" xmlns:r="${R_NS}">
  <p:cSld>
    <p:spTree>${shapes.join("")}</p:spTree>
  </p:cSld>
</p:sld>`;
}

export function buildPresentationXml(presentation: PptxPresentation): string {
  const slides = presentation.slides;
  const slideIds = slides
    .map((_, index) => `<p:sldId id="${String(256 + index)}" r:id="rId${String(3 + index)}"/>`)
    .join("");
  const sldIdLst = slides.length > 0 ? `<p:sldIdLst>${slideIds}</p:sldIdLst>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${A_NS}" xmlns:p="${P_NS}" xmlns:r="${R_NS}">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/></p:sldMasterIdLst>
  ${sldIdLst}
  <p:sldSz cx="9144000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}
