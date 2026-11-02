---
name: quoll
description: Keeps a story's design notebook (implementation plan, mockups, decisions, open questions) as markdown pages in the folder `quoll path` names, and points the user at a page with `quoll show`. Use when planning or designing work in a story directory, when recording a decision, mockup, or plan change, when the user mentions the notebook, quoll, or "show me" a plan or design, when you want the user to look at a specific page or heading, or when the user answers questions or edits plans in the notebook and you should notice.
---

# Design notebook

The user reads the notebook in quoll, a terminal viewer that usually sits beside you. It follows the files you write, so every page you change is something the user may be watching.

## Where it lives

Run `quoll path`; it prints the notebook folder, which is usually outside the story directory (a folder under the user's notebook root). Inside komux it prints the notebook the quoll in your tab is showing, so it works from anywhere in the tab, including inside one of the story's repos. Outside komux, or with no quoll open in the tab, run `quoll path`, `quoll show` and `quoll watch` from the story directory with `--focus`, which names the notebook after the current directory; without it they use the whole notebook root. If it fails because no notebook root is picked for the directory, don't pick one yourself: ask the user to open quoll in the tab, which asks them which root to use. Create the folder if it is missing. A notebook can sit inside a git repo of notes with its own rules; before you first write to one, read any `AGENTS.md` in the notebook folder or the folders above it, up to the repo's root, and follow it. Keep `index.md` as the entry page: a short summary of the work and links to every other page, since quoll opens it first.

## What goes in

- `plan.md`: the implementation plan. Update it as the plan changes rather than appending a history.
- Mockups and screenshots as images, embedded in the page that discusses them.
- Diagrams as mermaid blocks, wherever a picture explains it faster than prose: flows, state machines, sequences between processes, how components fit together. quoll draws them, so reach for them instead of ASCII art.
- `decisions.md`: each decision with its reason and the alternatives considered.
- Open questions you need the user to settle.

Job logs and diffs do not belong here; the user reads those in job panes and in their review tool.

## Syntax

Standard markdown plus the Obsidian forms quoll reads. Notebooks may be published to GitHub, which does not render Obsidian links, so write links and images in standard markdown:

- `[label](page.md)`, `[label](page.md#heading)`, `[label](#heading)` link to other pages and headings, by path relative to the current page. Write the anchor as GitHub does: the heading lowercased, punctuation other than hyphens dropped, spaces turned into hyphens (`## Fix options` is `#fix-options`).
- `![caption](shots/mockup.png)` on its own line shows an image. Keep images inside the notebook folder.
- quoll also reads the Obsidian forms `[[page]]`, `[[page#Heading]]`, `[[page|label]]` and `![[mockup.png]]`, which you may find in pages others wrote. Don't write them yourself.
- A fenced code block tagged `mermaid` is drawn as a diagram, in any type mermaid supports. One that fails to parse shows its source and mermaid's error instead, and readers in a terminal without images see the source, so keep labels short and the source readable.
- `%% hidden %%` is left out of the rendered page.
- Frontmatter is not shown on the page, except for its tags.

## Tags

Tags go in a page's frontmatter, as Obsidian writes them:

```markdown
---
tags: [design, logo]
---
```

quoll shows a page's tags beside its name. Its tag list (`t`) lets the user open every page with a given tag, and its page list matches on tags.

- **Read them first.** Before you search a notebook for pages about something, run `quoll tags`. It prints each tag with the pages that carry it, separated by tabs. `quoll tags logo` prints only the pages tagged `logo` or a tag nested under it, such as `logo/komux`, and exits 1 when there are none. Read the pages under the tags that fit. Like `quoll path`, it finds the notebook in your komux tab, or takes `--focus`.
- **Tag the pages you write.** Give each new page one to three tags about its subject or what kind of page it is, such as `decision`, `mockup` or `plan`. Reuse the notebook's existing tags where one fits rather than coining a near-duplicate, and keep them lowercase (quoll ignores case, as Obsidian does), with hyphens between words and a `/` for nesting (`logo/komux`).
- **Keep them current.** When a page's subject changes, update its tags. Leave the tags the user wrote alone unless they ask.

## Pointing the user at something

```bash
quoll show plan#Rollout
quoll show notebook/decisions.md
```

The target is a page name or path (relative to the notebook, or a file path) with an optional `#Heading`. It finds the same notebook as `quoll path`. Every quoll open on this notebook, or on a folder that contains it, jumps there. Use it when you want the user to read a particular section, not after every write; follow mode already shows them what you are writing. Showing a page turns follow mode off, so the user stays on it until they turn follow back on.

Exit status 1 with "No quoll is open" means nobody is viewing the notebook. That is not an error to fix; mention the page in your reply instead.

## Noticing the user's edits

The user often answers open questions and edits plans in the notebook rather than in chat. Keep a watch running while you work in a story so you see those edits without being told:

```bash
quoll watch
```

It prints `changed: <page>` each time a page is saved and runs until stopped. Start it with the Monitor tool, which turns each line into a notification. A background shell command would have to exit to report a change, and in komux every restart shows up as a new job.

Monitor stops a watch after at most 30 minutes; start it again when it does. Your own writes are reported too, so skip pages you have just written. When one of those wakes you after your turn has ended and brings nothing else, end the turn at once; inside komux, with a `**KOMUX: NO TOAST**` line, so the user is not toasted about your own edit. When the user changes a page, read it, act on what they wrote, and fold answers into the page: move a settled question into `decisions.md`, or update the plan.

## Comments from the user

The user can comment on a block of a page from quoll. The comment reaches you as a message that starts with the context, then their words:

```
Comment on plan.md, lines 12–14 under "Plan › Rollout":
File: /path/to/notebook/story/plan.md
> - [ ] Ship the migration
> - [ ] Watch the dashboards

Do the dashboards before the migration.
```

The quoted lines are the page's source when they commented, and the line numbers are 1-based. If the page has changed since, find the spot by the quote. Act on the comment, and update the page where it calls for a change.

