---
name: quoll
description: Keeps a story's design notebook (implementation plan, mockups, decisions, open questions) as markdown pages in the folder `quoll path` names, and points the user at a page with `quoll show`. Use when planning or designing work in a story directory, when recording a decision, mockup, or plan change, when the user mentions the notebook, quoll, or "show me" a plan or design, when you want the user to look at a specific page or heading, or when the user answers questions or edits plans in the notebook and you should notice.
---

# Design notebook

The user reads the notebook in quoll, a terminal viewer that usually sits beside you. It follows the files you write, so every page you change is something the user may be watching.

## Where it lives

Run `quoll path` from the story directory; it prints the notebook folder, which is usually outside the story directory (a folder per story under the user's notebook root). Create the folder if it is missing. Keep `index.md` as the entry page: a short summary of the work and links to every other page, since quoll opens it first.

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

The target is a page name or path (relative to the notebook, or a file path) with an optional `#Heading`. Run it from the story directory so it finds the same notebook as `quoll path`. Every quoll open on this notebook, or on a folder that contains it, jumps there. Use it when you want the user to read a particular section, not after every write; follow mode already shows them what you are writing. Showing a page turns follow mode off, so the user stays on it until they turn follow back on.

Exit status 1 with "No quoll is open" means nobody is viewing the notebook. That is not an error to fix; mention the page in your reply instead.

## Noticing the user's edits

The user often answers open questions and edits plans in the notebook rather than in chat. Keep a watch running while you work in a story so you see those edits without being told:

```bash
quoll watch
```

It prints `changed: <page>` each time a page is saved and runs until stopped. Start it from the story directory with the Monitor tool, which turns each line into a notification. A background shell command would have to exit to report a change, and in qmux every restart shows up as a new job.

Monitor stops a watch after at most 30 minutes; start it again when it does. Your own writes are reported too, so skip pages you have just written. When the user changes a page, read it, act on what they wrote, and fold answers into the page: move a settled question into `decisions.md`, or update the plan.
