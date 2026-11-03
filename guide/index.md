# Design notebook

A story's design notebook holds its implementation plan, mockups, decisions and open questions as markdown pages. The user reads it in quoll, a terminal viewer that usually sits beside you. It follows the files you write, so every page you change is something the user may be watching.

This guide is split into pages. Each link below names one: `quoll guide tags` prints `tags.md`. Read the pages the task needs, not all of them.

## Getting started

1. Run `quoll path` to find the notebook folder. When it fails or prints the whole notebook root, read [Where it lives](notebook.md#where-it-lives) before writing anything.
2. Run `quoll tags` before searching the notebook for pages about something, and read the pages under the tags that fit.
3. While you work in a story, keep `quoll watch` running under the Monitor tool so you see the user's edits. [Noticing the user's edits](watch.md) says how.

## Pages

- [Keeping the notebook](notebook.md): where the notebook lives, its `index.md`, and what goes in it (`plan.md`, `decisions.md`, mockups, diagrams, open questions). Read it before you first write to a notebook.
- [Syntax](syntax.md): links, anchors, images, mermaid diagrams, and the Obsidian forms quoll reads but you should not write.
- [Tags](tags.md): reading `quoll tags`, and tagging the pages you write.
- [Pointing the user at something](show.md): `quoll show page#Heading`, and what "No quoll is open" means.
- [Noticing the user's edits](watch.md): `quoll watch` under Monitor, and folding the user's answers back into the pages.
- [Comments from the user](comments.md): the shape of a comment the user sends you from quoll.
