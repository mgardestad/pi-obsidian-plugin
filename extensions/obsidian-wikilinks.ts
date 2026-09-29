import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

interface McpServerConfig {
  type?: string;
  url: string;
  headers?: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

const DEFAULT_CONFIG = join(homedir(), "Documents/notes/.mcp.json");
const FALLBACK_CONFIG = join(homedir(), "code/workbench/.mcp.json");
const VAULT_ROOT = join(homedir(), "Documents/notes");

function expand(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
}

async function loadServer(): Promise<McpServerConfig> {
  const configPath = process.env.OBSIDIAN_MCP_CONFIG ?? DEFAULT_CONFIG;
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    raw = await readFile(FALLBACK_CONFIG, "utf8");
  }
  const config = JSON.parse(raw) as McpConfig;
  const name = process.env.OBSIDIAN_MCP_SERVER ?? Object.keys(config.mcpServers ?? {})[0];
  const server = name ? config.mcpServers?.[name] : undefined;
  if (!server?.url) throw new Error(`No Obsidian MCP server found in ${configPath}`);
  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([k, v]) => [k, expand(v)]));

  // The example MCP config uses an environment variable. When pi is launched
  // from a desktop shell that variable may not be inherited, so use the key
  // from this vault's Local REST API plugin as a local-only fallback.
  if ((!headers.Authorization || /^Bearer\s*$/.test(headers.Authorization)) && /127\.0\.0\.1|localhost/.test(server.url)) {
    try {
      const data = JSON.parse(await readFile(join(homedir(), "Documents/notes/.obsidian/plugins/obsidian-local-rest-api/data.json"), "utf8")) as { apiKey?: string };
      if (data.apiKey) headers.Authorization = `Bearer ${data.apiKey}`;
    } catch { /* explicit MCP auth remains required for other setups */ }
  }
  return { ...server, headers };
}

/** Small MCP Streamable HTTP client. It intentionally discovers the search tool so
 * this extension works with different Obsidian MCP implementations. */
class ObsidianMcp {
  private server?: McpServerConfig;
  private sessionId?: string;
  private nextId = 1;
  private searchTool?: { name: string; input: Record<string, unknown> };

  private async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    this.server ??= await loadServer();
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-03-26",
      ...this.server.headers,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const response = await fetch(this.server.url, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    if (!response.ok) throw new Error(`Obsidian MCP returned HTTP ${response.status}`);
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    // Streamable HTTP servers may keep the SSE response open. Read the first
    // complete JSON-RPC event rather than waiting for the stream to close.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) return response.json();
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Obsidian MCP returned an empty response");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const dataLine = buffer.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (dataLine) {
        await reader.cancel();
        return JSON.parse(dataLine.slice(5).trim());
      }
      if (chunk.done) break;
    }
    throw new Error("Obsidian MCP returned no JSON-RPC event");
  }

  private async discover(signal: AbortSignal): Promise<void> {
    if (this.searchTool) return;
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "pi-obsidian-plugin", version: "0.1.0" },
    }, signal);
    // Notification is required by MCP, but does not need a response.
    try { await this.request("notifications/initialized", {}, signal); } catch { /* older servers */ }
    const result = await this.request("tools/list", {}, signal) as { result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> } };
    const tools = result.result?.tools ?? [];
    const tool = tools.find((item) => /^(search_simple|search|find_notes?)$/i.test(item.name))
      ?? tools.find((item) => /search_simple/i.test(item.name))
      ?? tools.find((item) => /search|query|find/i.test(item.name));
    if (!tool) throw new Error("The configured Obsidian MCP server has no search tool");
    this.searchTool = { name: tool.name, input: tool.inputSchema?.properties ?? {} };
  }

  async search(query: string, signal: AbortSignal): Promise<AutocompleteItem[]> {
    await this.discover(signal);
    const tool = this.searchTool!;
    const properties = Object.keys(tool.input);
    const key = properties.find((name) => /query|search|keyword|pattern|text/i.test(name)) ?? properties[0] ?? "query";
    const result = await this.request("tools/call", { name: tool.name, arguments: { [key]: query } }, signal) as { result?: { content?: Array<{ type?: string; text?: string }> } };
    const text = (result.result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
    return parseResults(text, query);
  }
}

function fuzzyScore(query: string, title: string): number | null {
  const needle = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  const haystack = title.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!needle) return 0;
  let position = 0;
  let gaps = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found < 0) return null;
    gaps += found - position;
    position = found + 1;
  }
  // Lower is better: reward title prefixes and contiguous matches.
  const prefixPenalty = haystack.startsWith(needle) ? 0 : 10;
  return prefixPenalty + gaps + (haystack.length - needle.length) / 1000;
}

function isInAttachmentsFolder(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((part) => part.toLowerCase() === "attachments");
}

async function searchLocalVault(query: string): Promise<AutocompleteItem[]> {
  const results: Array<{ item: AutocompleteItem; score: number }> = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const relative = path.slice(VAULT_ROOT.length + 1);
        if (isInAttachmentsFolder(relative)) continue;
        // Keep extensions for non-Markdown files so Obsidian can resolve them.
        const title = relative.replace(/\.md$/i, "");
        const score = fuzzyScore(query, title);
        if (score !== null) results.push({ item: { value: title, label: relative }, score });
      }
    }
  }
  await walk(VAULT_ROOT);
  return results.sort((a, b) => a.score - b.score).slice(0, 20).map((result) => result.item);
}

function mergeSearchResults(...groups: AutocompleteItem[][]): AutocompleteItem[] {
  const seen = new Set<string>();
  return groups.flat().filter((item) => {
    const path = item.value;
    if (isInAttachmentsFolder(path) || seen.has(path)) return false;
    seen.add(path);
    return true;
  }).slice(0, 20);
}

function parseResults(text: string, query: string): AutocompleteItem[] {
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* plain text result */ }
  const rows: unknown[] = Array.isArray(value) ? value : (value && typeof value === "object" && Array.isArray((value as any).results) ? (value as any).results : [value]);
  const items: AutocompleteItem[] = [];
  for (const row of rows) {
    const path = typeof row === "string" ? row : row && typeof row === "object" ? String((row as any).path ?? (row as any).filename ?? (row as any).file ?? (row as any).name ?? "") : "";
    if (path) {
      items.push({
        value: path.replace(/\.md$/i, ""),
        label: path,
        description: typeof row === "object" ? String((row as any).snippet ?? "") : undefined,
      });
    }
  }
  if (items.length) return items.slice(0, 20);
  return text.split(/\r?\n/).map((line) => line.match(/(?:^|\s)([^\s|]+)(?:\s|$)/)?.[1]).filter((path): path is string => Boolean(path)).slice(0, 20).map((path) => ({ value: path.replace(/\.md$/i, ""), label: path }));
}

function wikilinkPrefix(lines: string[], line: number, col: number): { start: number; prefix: string } | null {
  const before = lines[line]?.slice(0, col) ?? "";
  const match = before.match(/\[\[([^\]]*)$/);
  if (!match || match.index === undefined) return null;
  return { start: match.index, prefix: match[1] ?? "" };
}

export default function (pi: ExtensionAPI) {
  const mcp = new ObsidianMcp();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const provider: AutocompleteProvider = {
        triggerCharacters: ["["],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const match = wikilinkPrefix(lines, cursorLine, cursorCol);
          if (!match || match.prefix.length === 0) return null;
          try {
            // MCP primarily returns notes; merge in local files so every file type
            // outside an attachments folder can be linked as well.
            const [mcpItems, localItems] = await Promise.all([
              mcp.search(match.prefix, options.signal),
              searchLocalVault(match.prefix),
            ]);
            return { prefix: match.prefix, items: mergeSearchResults(mcpItems, localItems) };
          } catch (error) {
            if (options.signal.aborted) return null;
            // Keep autocomplete useful when Obsidian is closed or MCP is unavailable.
            const items = await searchLocalVault(match.prefix);
            if (items.length === 0) ctx.ui.notify(`Obsidian lookup failed; no local matches found`, "warning");
            return { prefix: match.prefix, items };
          }
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          const line = lines[cursorLine] ?? "";
          const start = line.slice(0, cursorCol).lastIndexOf("[[") + 2;
          const replacement = `${item.value}]]`;
          lines[cursorLine] = line.slice(0, start) + replacement + line.slice(cursorCol);
          return { lines, cursorLine, cursorCol: start + replacement.length };
        },
      };
      let lookupId = 0;
      let lookupItems: AutocompleteItem[] = [];
      let selectedIndex = 0;
      const showLookup = (text: string) => {
        const match = text.match(/\[\[([^\]]+)$/);
        if (!match) {
          lookupItems = [];
          selectedIndex = 0;
          ctx.ui.setWidget("obsidian-wikilinks", undefined);
          return;
        }
        const query = match[1] ?? "";
        const id = ++lookupId;
        void searchLocalVault(query).then((items) => {
          if (id !== lookupId) return;
          lookupItems = items.slice(0, 8);
          selectedIndex = Math.min(selectedIndex, Math.max(0, lookupItems.length - 1));
          ctx.ui.setWidget("obsidian-wikilinks", lookupItems.length
            ? lookupItems.map((item, index) => `${index === selectedIndex ? "❯ " : "  " }[[${item.value}]]`)
            : ["No matching note names"]);
        });
      };
      class ObsidianEditor extends CustomEditor {
        override handleInput(data: string): void {
          // Keep selection independent of pi's built-in autocomplete list.
          if (lookupItems.length > 0 && (data === "\x1b[A" || data === "\x1b[B")) {
            selectedIndex = data === "\x1b[A"
              ? (selectedIndex + lookupItems.length - 1) % lookupItems.length
              : (selectedIndex + 1) % lookupItems.length;
            showLookup(this.getText());
            return;
          }
          if (lookupItems.length > 0 && (data === "\r" || data === "\n")) {
            const item = lookupItems[selectedIndex];
            if (item) {
              this.setText(this.getText().replace(/\[\[[^\]]+$/, `[[${item.value}]]`));
              showLookup(this.getText());
              return;
            }
          }
          super.handleInput(data);
          showLookup(this.getText());
        }
      }
      const editor = new ObsidianEditor(tui, theme, keybindings);
      editor.setAutocompleteProvider(provider);
      // The interactive mode may install its default provider immediately after
      // the editor factory returns. Re-apply ours on the next microtask so the
      // wikilink provider remains active.
      queueMicrotask(() => editor.setAutocompleteProvider(provider));
      return editor;
    });
  });
}
