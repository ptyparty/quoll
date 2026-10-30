Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`

## Layout

- `src/document.ts`: parses a page (markdown with Obsidian links, embeds, and comments) into blocks, headings, and links.
- `src/notebook.ts`: finds the notebook folder, lists pages, and resolves link and image targets.
- `src/viewer/`: the OpenTUI viewer, its history, and the picker.
- `src/socket.ts`: the unix socket `quoll show` uses to reach running viewers.
- `src/render/`: markdown style and kitty image placeholders, copied from qmux's forms until they move into a shared package.
- `src/watch.ts`: the notebook watcher behind follow mode and `quoll watch`.
- `skills/quoll/`: the agent skill.

## Testing

- View tests use `createTestRenderer` from `@opentui/core/testing`. Markdown renders a few frames late, so wait for the frame to settle.
- `@opentui/core` is pinned to the same exact version as qmux. Check its `.d.ts` files in `node_modules` rather than trusting memory of its API.
