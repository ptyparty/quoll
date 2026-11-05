import { BorderChars, BoxRenderable, SyntaxStyle, TextRenderable, type CliRenderer, type MarkdownOptions, type MarkdownTableOptions } from "@opentui/core";
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

export function markdownStyle(renderer: CliRenderer, marking = false): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      default: { fg: theme.text },
      conceal: { fg: theme.faint },
      "markup.heading": { fg: theme.muted, bold: true },
      "markup.heading.1": { fg: theme.quoll, bold: true },
      "markup.heading.2": { fg: theme.quoll, bold: true },
      "markup.heading.3": { fg: theme.quoll, bold: true },
      "markup.heading.4": { fg: theme.quoll },
      "markup.heading.5": { fg: theme.muted, bold: true },
      "markup.heading.6": { fg: theme.muted },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.strikethrough": marking ? { fg: theme.text, bg: theme.selection, bold: true } : { dim: true },
      "markup.raw": { fg: theme.syntax.function, bg: theme.surface2 },
      "markup.link": { fg: theme.quoll, underline: true },
      "markup.link.label": { fg: theme.quoll, underline: true },
      "markup.link.url": { fg: theme.muted, underline: true },
      "markup.list": { fg: theme.muted },
      "markup.quote": { fg: theme.muted, italic: true },
      keyword: { fg: theme.syntax.keyword },
      "keyword.operator": { fg: theme.syntax.operator },
      operator: { fg: theme.syntax.operator },
      string: { fg: theme.syntax.string },
      comment: { fg: theme.syntax.comment, italic: true },
      number: { fg: theme.syntax.number },
      constant: { fg: theme.syntax.number },
      boolean: { fg: theme.syntax.number },
      function: { fg: theme.syntax.function },
      "function.method": { fg: theme.syntax.function },
      type: { fg: theme.syntax.type },
      punctuation: { fg: theme.syntax.punctuation },
      variable: { fg: theme.text },
    },
    renderer.nativeScene,
  );
}

export const tableOptions: MarkdownTableOptions = { widthMode: "content", cellPaddingX: 1, borderStyle: "rounded", borderColor: theme.line };

const quoteBar = { ...BorderChars.single, vertical: "▎" };

export function markdownNode(renderer: CliRenderer): NonNullable<MarkdownOptions["renderNode"]> {
  return (token, context) => {
    if (token.type === "heading" && token.depth === 1) {
      const box = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", flexShrink: 0 });
      const heading = context.defaultRender();
      if (heading) box.add(heading);
      box.add(new TextRenderable(renderer, { content: "━".repeat(Math.max(Bun.stringWidth(token.text), 1)), fg: theme.quoll, wrapMode: "none", flexShrink: 0 }));
      return box;
    }
    if (token.type === "blockquote") {
      const quote = context.defaultRender();
      if (!(quote instanceof BoxRenderable)) return quote;
      quote.border = false;
      quote.paddingLeft = 0;
      const box = new BoxRenderable(renderer, { width: "100%", flexShrink: 0, border: ["left"], customBorderChars: quoteBar, borderColor: theme.quoll, paddingLeft: 1 });
      box.add(quote);
      return box;
    }
    if (token.type === "code") {
      const code = context.defaultRender();
      if (!code) return code;
      const box = new BoxRenderable(renderer, { width: "100%", flexShrink: 0, backgroundColor: theme.surface, paddingLeft: 2, paddingRight: 2 });
      box.add(code);
      return box;
    }
    return undefined;
  };
}
