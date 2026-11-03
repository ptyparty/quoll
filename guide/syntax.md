# Syntax

Standard markdown plus the Obsidian forms quoll reads. Notebooks may be published to GitHub, which does not render Obsidian links, so write links and images in standard markdown:

- `[label](page.md)`, `[label](page.md#heading)`, `[label](#heading)` link to other pages and headings, by path relative to the current page. Write the anchor as GitHub does: the heading lowercased, punctuation other than hyphens dropped, spaces turned into hyphens (`## Fix options` is `#fix-options`).
- `![caption](shots/mockup.png)` on its own line shows an image. Keep images inside the notebook folder.
- quoll also reads the Obsidian forms `[[page]]`, `[[page#Heading]]`, `[[page|label]]` and `![[mockup.png]]`, which you may find in pages others wrote. Don't write them yourself.
- A fenced code block tagged `mermaid` is drawn as a diagram, in any type mermaid supports. One that fails to parse shows its source and mermaid's error instead, and readers in a terminal without images see the source, so keep labels short and the source readable.
- `%% hidden %%` is left out of the rendered page.
- Frontmatter is not shown on the page, except for its tags.
