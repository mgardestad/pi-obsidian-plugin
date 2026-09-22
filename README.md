# Obsidian wikilinks for pi

Adds `[[...` autocomplete to pi's editor. Suggestions are searched through the configured Obsidian MCP server and selecting one inserts `[[Note path]]`.

## Install locally

```sh
pi install /Users/martin/code/pi-obsidian-plugin
```

Or test without installing:

```sh
pi -e ./extensions/obsidian-wikilinks.ts
```

## Configuration

The extension reads the MCP configuration from `~/Documents/notes/.mcp.json` (and falls back to `~/code/workbench/.mcp.json`). Override it with:

```sh
export OBSIDIAN_MCP_CONFIG="$HOME/path/to/.mcp.json"
export OBSIDIAN_MCP_SERVER=obsidian-work
```

Bearer tokens such as `${OBSIDIAN_API_TOKEN_WORK}` are expanded from the environment. The configured MCP server must expose a tool whose name contains `search`, `query`, or `find`; its first query-like argument is used.

Type `[[` followed by at least one search character. Use the normal autocomplete keys (arrow keys and Enter) to select a note; Escape closes the suggestions.
