# Keeping the notebook

## Where it lives

Run `quoll path`; it prints the notebook folder, which is usually outside the story directory (a folder under the user's notebook root). Inside komux it prints the notebook the quoll in your tab is showing, so it works from anywhere in the tab, including inside one of the story's repos. Outside komux, or with no quoll open in the tab, run `quoll path`, `quoll show` and `quoll watch` from the story directory with `--focus`, which names the notebook after the current directory; without it they use the whole notebook root. If it fails because no notebook root is picked for the directory, don't pick one yourself: ask the user to open quoll in the tab, which asks them which root to use. Create the folder if it is missing. A notebook can sit inside a git repo of notes with its own rules; before you first write to one, read any `AGENTS.md` in the notebook folder or the folders above it, up to the repo's root, and follow it. Keep `index.md` as the entry page: a short summary of the work and links to every other page, since quoll opens it first.

## What goes in

- `plan.md`: the implementation plan. Update it as the plan changes rather than appending a history.
- Mockups and screenshots as images, embedded in the page that discusses them.
- Diagrams as mermaid blocks, wherever a picture explains it faster than prose: flows, state machines, sequences between processes, how components fit together. quoll draws them, so reach for them instead of ASCII art.
- `decisions.md`: each decision with its reason and the alternatives considered.
- Open questions you need the user to settle.

Job logs and diffs do not belong here; the user reads those in job panes and in their review tool.
