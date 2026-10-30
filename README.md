# quoll

A terminal viewer for a story's design notebook: a folder of markdown pages and images, readable in Obsidian too.

```
quoll [dir] [--no-follow]    view the notebook
quoll show <page>[#heading]  make every open viewer show a page
quoll path                   print the notebook folder for the current directory
quoll watch                  print "changed: <page>" each time a page is saved
```

Set `QUOLL_DIR` to the notebook root, which holds a folder per story: from `~/work/stories/sc-123`, the notebook is `$QUOLL_DIR/sc-123`, and `quoll $QUOLL_DIR` browses them all. `--dir` overrides it for one run. Without it, quoll uses the nearest `notebook/` folder.

Keys: `j`/`k`, `d`/`u`, `g`/`G` scroll · `f` links · `p` pages · `o` outline · `i` index · `H`/`L` back and forward · `e` edit in helix · `w` follow · `r` reload · `q` quit.

Follow mode jumps to whatever page in the notebook changed last, at the changed line. Scrolling, navigating, or `quoll show` turns it off; `w` turns it back on.
