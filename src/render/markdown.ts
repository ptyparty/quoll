import { SyntaxStyle, type CliRenderer } from "@opentui/core";
import { fitImage, newImageId, readImage, uploadCommands, type ImageBox, type ImageOutput } from "./image.ts";
import { theme } from "./theme.ts";

export function sendImage(path: string, maxCols: number, maxRows: number, images: ImageOutput): { id: number; box: ImageBox } | { error: string } {
  let image;
  try {
    image = readImage(path);
  } catch (error) {
    return { error: `Could not show ${path}: ${(error as Error).message}` };
  }
  const box = fitImage(image.info.width, image.info.height, maxCols, maxRows);
  const id = newImageId();
  images.write(uploadCommands(id, image, box));
  return { id, box };
}

export function markdownStyle(renderer: CliRenderer): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      default: {},
      conceal: { fg: theme.muted },
      "markup.heading": { fg: theme.accent, bold: true },
      "markup.heading.1": { fg: "#e6c384", bold: true, underline: true },
      "markup.heading.2": { fg: theme.accent, bold: true },
      "markup.heading.3": { fg: "#957fb8", bold: true },
      "markup.heading.4": { fg: "#957fb8" },
      "markup.heading.5": { fg: theme.muted, bold: true },
      "markup.heading.6": { fg: theme.muted },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.strikethrough": { dim: true },
      "markup.raw": { fg: "#e6c384" },
      "markup.link": { fg: theme.accent, underline: true },
      "markup.link.label": { fg: theme.accent },
      "markup.link.url": { fg: theme.muted, underline: true },
      "markup.list": { fg: theme.selected },
      "markup.quote": { fg: theme.muted, italic: true },
      keyword: { fg: "#957fb8" },
      string: { fg: "#98bb6c" },
      comment: { fg: theme.muted, italic: true },
      number: { fg: "#d27e99" },
      function: { fg: "#7e9cd8" },
      type: { fg: "#7aa89f" },
    },
    renderer.nativeScene,
  );
}
