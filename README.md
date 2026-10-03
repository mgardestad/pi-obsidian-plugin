# Obsidian wikilinks for pi

Adds `[[...` autocomplete to pi's editor. Suggestions are searched through the configured Obsidian MCP server and selecting one inserts `[[Note path]]`.

## Install locally

```sh
pi install /path/to/pi-obsidian-plugin
```

Or test without installing:

```sh
pi -e ./extensions/obsidian-wikilinks.ts
```

## Configuration

The extension is only active when pi is started in an Obsidian vault root, a folder that holds `.obsidian`. That folder is the vault. Started anywhere else, the editor is left as it is.

Searches go through the Obsidian MCP server configured in the vault's own `.mcp.json`. When the file lists several servers, pick one by name:

```sh
export OBSIDIAN_MCP_SERVER=obsidian
```

Without a `.mcp.json`, or when the server can't be reached, the extension searches the vault's files directly.

Bearer tokens such as `${OBSIDIAN_API_TOKEN}` are expanded from the environment. The configured MCP server must expose a tool whose name contains `search`, `query`, or `find`; its first query-like argument is used.

Type `[[` followed by at least one search character. Use the normal autocomplete keys (arrow keys and Enter) to select a note; Escape closes the suggestions.

To link a section, add `#` after the note: `[[Untitled 4#con` lists the headings of `Untitled 4` (or the best-matching note) that fuzzy-match `con`, and selecting one inserts `[[Untitled 4#Concept Graph]]`. This also works when you move the cursor back into a finished link and type `#` before the `]]`. Headings are read from the vault's files, skipping frontmatter and fenced code blocks.
