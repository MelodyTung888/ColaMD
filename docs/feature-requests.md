# Feature Requests

This is the holding list for requests that have a clear user need but are not committed roadmap work. Entries stay here until they are accepted into a release plan or explicitly declined.

## Candidates

### Import local images into the current document

**Need:** Pasting or dropping an image should copy it into a predictable folder next to the current Markdown file and insert a portable relative image reference.

**Why it fits:** ColaMD already renders local images and restores portable relative paths on save. This fills the missing creation workflow without changing the editor's content-first layout.

**Constraints:** Use an existing menu command or keyboard shortcut. Do not add a persistent toolbar control. Define collision handling, image naming, clipboard behavior, and the destination folder before implementation.

### Heading outline

**Need:** Let people navigate long documents by headings.

**Why it fits:** This is useful for long-form Markdown, but it must remain secondary to writing.

**Constraints:** Do not add a permanent outline panel. Explore an on-demand, lightweight interaction only after validating that heading navigation cannot be served by existing editor behavior.

## Declined

### Built-in translation

Translation introduces provider, configuration, privacy, and product-scope complexity outside ColaMD's focused Markdown editing role.

### Tabs and persistent multi-document workspace

ColaMD deliberately avoids workspace and tab-system complexity. Existing file opening and lightweight directory browsing remain the primary document navigation model.

### Resizable file panel

The file panel remains a fixed 220px lightweight list. Long names reveal themselves through hover scrolling, avoiding a persisted layout state and drag affordance.
