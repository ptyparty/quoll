# Tags

Tags go in a page's frontmatter, as Obsidian writes them:

```markdown
---
tags: [design, logo]
---
```

quoll shows a page's tags beside its name. Its tag list (`t`) lets the user open every page with a given tag, and its page list matches on tags.

- **Read them first.** Before you search a notebook for pages about something, run `quoll tags`. It prints each tag with the pages that carry it, separated by tabs. `quoll tags logo` prints only the pages tagged `logo` or a tag nested under it, such as `logo/komux`, and exits 1 when there are none. Read the pages under the tags that fit. Like `quoll path` (see [Where it lives](notebook.md#where-it-lives)), it finds the notebook in your komux tab, or takes `--focus`.
- **Tag the pages you write.** Give each new page one to three tags. At least one names its subject: the tool, component or area it's about, such as `komux`, `billing` or `auth`. Add a tag for what kind of page it is, such as `decision`, `mockup` or `plan`, when that helps. Subject tags are how a reader finds every page about one thing, so a page about two subjects gets both. Reuse the notebook's existing tags where one fits rather than coining a near-duplicate, and keep them lowercase (quoll ignores case, as Obsidian does), with hyphens between words and a `/` for nesting (`logo/komux`).
- **Keep them current.** When a page's subject changes, update its tags. Leave the tags the user wrote alone unless they ask.
