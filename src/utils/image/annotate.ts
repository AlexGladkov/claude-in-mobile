import { Jimp } from "jimp";
import type { UiElement } from "../../adb/ui-parser.js";
import { compressScreenshot } from "./compress.js";
import type { AnnotateResult, CompressOptions } from "./types.js";
import {
  COLOR_BG,
  COLOR_GREEN,
  COLOR_RED,
  COLOR_WHITE,
  drawNumber,
  drawRect,
  FONT_SCALE,
  LABEL_PADDING,
  RECT_THICKNESS,
} from "./drawing.js";

function getElementLabel(el: UiElement): string {
  if (el.text) return el.text;
  if (el.contentDesc) return el.contentDesc;
  if (el.resourceId) {
    const short = el.resourceId.split(":id/").pop();
    return short ?? el.resourceId;
  }
  const shortClass = el.className.split(".").pop();
  return shortClass ?? el.className;
}

/**
 * Annotate a screenshot with colored bounding boxes and element numbers.
 * Green = clickable, Red = non-clickable.
 * Returns compressed annotated image + element index.
 */
export async function annotateScreenshot(
  pngBuffer: Buffer,
  elements: UiElement[],
  compressOptions?: CompressOptions,
): Promise<AnnotateResult> {
  const image = await Jimp.read(pngBuffer);
  const imgWidth = image.width;
  const imgHeight = image.height;
  const data = image.bitmap.data as Buffer;

  const annotatedElements: AnnotateResult["elements"] = [];
  let annotIndex = 1;

  for (const el of elements) {
    const { x1, y1, x2, y2 } = el.bounds;
    const w = x2 - x1;
    const h = y2 - y1;

    // Skip very small or full-screen elements
    if (w < 10 || h < 10) continue;
    if (w > imgWidth * 0.95 && h > imgHeight * 0.95) continue;

    const color = el.clickable ? COLOR_GREEN : COLOR_RED;

    drawRect(data, imgWidth, imgHeight, x1, y1, x2, y2, color, RECT_THICKNESS);

    const labelY = Math.max(0, y1 - (7 * FONT_SCALE + LABEL_PADDING * 2) - 2);
    drawNumber(data, imgWidth, imgHeight, annotIndex, x1, labelY, COLOR_WHITE, COLOR_BG, FONT_SCALE);

    annotatedElements.push({
      index: annotIndex,
      label: getElementLabel(el),
      clickable: el.clickable,
      center: { x: el.centerX, y: el.centerY },
    });

    annotIndex++;
  }

  const pngOut = await image.getBuffer("image/png");
  const compressed = await compressScreenshot(pngOut, compressOptions);

  return {
    image: compressed,
    elements: annotatedElements,
  };
}
