# Pointing the user at something

```bash
quoll show plan#Rollout
quoll show notebook/decisions.md
```

The target is a page name or path (relative to the notebook, or a file path) with an optional `#Heading`. It finds the same notebook as `quoll path` (see [Where it lives](notebook.md#where-it-lives)). Every quoll open on this notebook, or on a folder that contains it, jumps there. Use it when you want the user to read a particular section, not after every write; follow mode already shows them what you are writing. Showing a page turns follow mode off, so the user stays on it until they turn follow back on.

Exit status 1 with "No quoll is open" means nobody is viewing the notebook. That is not an error to fix; mention the page in your reply instead.
