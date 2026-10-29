# quoll

A terminal viewer for a story's design notebook: a folder of markdown pages and images, readable in Obsidian too.

```
quoll [dir] [--no-follow]    view the notebook
quoll show <page>[#heading]  make every open viewer show a page
```

Keys: `j`/`k`, `d`/`u`, `g`/`G` scroll · `f` links · `p` pages · `o` outline · `i` index · `H`/`L` back and forward · `e` edit in helix · `w` follow · `r` reload · `q` quit.

Follow mode jumps to whatever page in the notebook changed last, at the changed line. Scrolling, navigating, or `quoll show` turns it off; `w` turns it back on.
