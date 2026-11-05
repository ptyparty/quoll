Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`

## Layout

- `src/document.ts`: parses a page (markdown with Obsidian links, embeds, and comments) into blocks, headings, and links, and reads its frontmatter tags.
- `src/notebook.ts`: finds the notebook folder, lists pages, and resolves link and image targets.
- `src/viewer/`: the OpenTUI viewer, its history, the picker, and the atlas (a navigable outline of the whole notebook).
- `src/socket.ts`: the unix socket `quoll show` uses to reach running viewers.
- `src/context.ts`: the socket komux asks for context on Alt shift c and for the keys that work right now (shared with kowari); `src/comment.ts` builds the context for a block.
- `src/viewer/keys.ts`: key bindings. Each state's table sits beside the code it runs, and key handling, the `␣` menu, the `␣ ?` help sheet and the answer to komux all read those tables.
- `src/render/`: markdown style and kitty image placeholders, copied from komux's forms until they move into a shared package, and mermaid diagrams drawn to cached PNGs.
- `src/watch.ts`: the notebook watcher behind follow mode and `quoll watch`.
- `guide/`: the agent's guide, one markdown page per topic, printed by `quoll guide <page>` (`src/guide.ts`, shared with kowari) and starting at `index.md`.
- `skills/quoll/`: the agent skill, which only points at `quoll guide index`.
- `src/setup.ts`: `quoll setup`, which links the skill into Claude Code's config; `src/links.ts` is copied from komux.

## Testing

- View tests use `createTestRenderer` from `@opentui/core/testing`. Markdown renders a few frames late, so wait for the frame to settle.
- `@opentui/core` is pinned to the same exact version as komux. Check its `.d.ts` files in `node_modules` rather than trusting memory of its API.
