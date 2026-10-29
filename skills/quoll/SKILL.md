---
name: quoll
description: Keeps a story's design notebook (implementation plan, mockups, decisions, open questions) as markdown pages in its notebook/ folder, and points the user at a page with `quoll show`. Use when planning or designing work in a story directory, when recording a decision, mockup, or plan change, when the user mentions the notebook, quoll, or "show me" a plan or design, or when you want the user to look at a specific page or heading.
---

# Design notebook

The user reads the notebook in quoll, a terminal viewer that usually sits beside you. It follows the files you write, so every page you change is something the user may be watching.

## Where it lives

`notebook/` in the story directory (the nearest folder named `notebook`, or the nearest directory that contains one). Create it if it is missing. Keep `index.md` as the entry page: a short summary of the work and links to every other page, since quoll opens it first.

## What goes in

- `plan.md`: the implementation plan. Update it as the plan changes rather than appending a history.
- Mockups and screenshots as images, embedded in the page that discusses them.
- `decisions.md`: each decision with its reason and the alternatives considered.
- Open questions you need the user to settle.

Job logs and diffs do not belong here; the user reads those in job panes and in their review tool.

## Syntax

Standard markdown plus the Obsidian forms quoll reads:

- `[[page]]`, `[[page#Heading]]`, `[[page|label]]` link to other pages, by name or path.
- `![[mockup.png]]` or `![caption](shots/mockup.png)` on its own line shows an image. Keep images inside the notebook folder.
- `%% hidden %%` is left out of the rendered page.
- Frontmatter is skipped.

## Pointing the user at something

```bash
quoll show plan#Rollout
quoll show notebook/decisions.md
```

The target is a page name or path (relative to the notebook, or a file path from the current directory) with an optional `#Heading`. Every quoll open on this notebook jumps there. Use it when you want the user to read a particular section, not after every write; follow mode already shows them what you are writing. Showing a page turns follow mode off, so the user stays on it until they turn follow back on.

Exit status 1 with "No quoll is open" means nobody is viewing the notebook. That is not an error to fix; mention the page in your reply instead.
