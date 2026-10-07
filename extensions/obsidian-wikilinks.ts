import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
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

// The session's directory when it is an Obsidian vault root (it holds
// `.obsidian`). The extension does nothing anywhere else.
let VAULT_ROOT = "";

function expand(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
}

async function loadServer(): Promise<McpServerConfig> {
  // Only the vault's own config, so searches never reach another vault's server.
  // Without one, lookups fall back to the vault's files.
  const configPath = join(VAULT_ROOT, ".mcp.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as McpConfig;
  const name = process.env.OBSIDIAN_MCP_SERVER ?? Object.keys(config.mcpServers ?? {})[0];
  const server = name ? config.mcpServers?.[name] : undefined;
  if (!server?.url) throw new Error(`No Obsidian MCP server found in ${configPath}`);
  const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([k, v]) => [k, expand(v)]));

  // The example MCP config uses an environment variable. When pi is launched
  // from a desktop shell that variable may not be inherited, so use the key
  // from this vault's Local REST API plugin as a local-only fallback.
  if ((!headers.Authorization || /^Bearer\s*$/.test(headers.Authorization)) && /127\.0\.0\.1|localhost/.test(server.url)) {
    try {
      const data = JSON.parse(await readFile(join(VAULT_ROOT, ".obsidian/plugins/obsidian-local-rest-api/data.json"), "utf8")) as { apiKey?: string };
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
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const titleTerms = title.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;

  // Match each query term independently. This makes matching insensitive to
  // title word order and lets shortened dates match a full date, e.g.
  // `pm-po 10-02` matches `2026-10-02 PM-PO sync ceremony`.
  let score = 0;
  for (const term of terms) {
    const normalizedTerm = term.replace(/[^a-z0-9]/g, "");
    let best: number | null = null;
    for (const titleTerm of titleTerms) {
      const normalizedTitleTerm = titleTerm.replace(/[^a-z0-9]/g, "");
      const position = normalizedTitleTerm.indexOf(normalizedTerm);
      if (position < 0) continue;
      const candidate = position * 2 + (normalizedTitleTerm.length - normalizedTerm.length) / 1000;
      best = best === null ? candidate : Math.min(best, candidate);
    }
    if (best === null) return null;
    score += best;
  }

  return score;
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

// ATX headings outside frontmatter and fenced code blocks.
function parseHeadings(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) start = end + 1;
  }
  const headings: string[] = [];
  let fence: string | null = null;
  for (const line of lines.slice(start)) {
    const [, marker, info] = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/) ?? [];
    if (marker) {
      if (fence === null) fence = marker;
      // A closing fence matches the opener's character and length, with nothing after it.
      else if (marker[0] === fence[0] && marker.length >= fence.length && !info?.trim()) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/)?.[1];
    if (heading) headings.push(heading);
  }
  return headings;
}

const headingCache = new Map<string, { mtimeMs: number; headings: string[] }>();

async function noteHeadings(note: string): Promise<string[]> {
  const path = join(VAULT_ROOT, `${note}.md`);
  try {
    // Re-read only when the note changed since the last lookup.
    const { mtimeMs } = await stat(path);
    const cached = headingCache.get(note);
    if (cached?.mtimeMs === mtimeMs) return cached.headings;
    const headings = parseHeadings(await readFile(path, "utf8"));
    headingCache.set(note, { mtimeMs, headings });
    return headings;
  } catch {
    // Only Markdown notes have sections; other files list none.
    return [];
  }
}

// `note#section` lists the headings of the note the part before `#` names:
// the exact path when it exists, otherwise the best fuzzy match.
async function searchSections(query: string): Promise<AutocompleteItem[]> {
  const hash = query.indexOf("#");
  const notePart = query.slice(0, hash).trim();
  const exact = await stat(join(VAULT_ROOT, `${notePart}.md`)).then(() => true, () => false);
  const note = exact ? notePart : (await searchLocalVault(notePart))[0]?.value;
  if (!note) return [];
  const sectionPart = query.slice(hash + 1);
  const headings = await noteHeadings(note);
  const ranked = sectionPart.trim()
    ? headings
      .map((heading) => ({ heading, score: fuzzyScore(sectionPart, heading) }))
      .filter((result): result is { heading: string; score: number } => result.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((result) => result.heading)
    : headings;
  return ranked.slice(0, 20).map((heading) => ({ value: `${note}#${heading}`, label: `${note}#${heading}` }));
}

// The rest of a link after the cursor, up to and including its `]]`, when the
// cursor is inside a link that is already closed.
function closedLinkRest(after: string): string {
  return after.match(/^[^[\]]*\]\]/)?.[0] ?? "";
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
  const match = before.match(/\[\[([^[\]]*)$/);
  if (!match || match.index === undefined) return null;
  return { start: match.index, prefix: match[1] ?? "" };
}

export default function (pi: ExtensionAPI) {
  let mcp = new ObsidianMcp();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!existsSync(join(ctx.cwd, ".obsidian"))) return;
    if (VAULT_ROOT !== ctx.cwd) {
      // A new vault: its MCP config and API key may differ from the last one's.
      VAULT_ROOT = ctx.cwd;
      mcp = new ObsidianMcp();
    }
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const provider: AutocompleteProvider = {
        triggerCharacters: ["[", "#"],
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const match = wikilinkPrefix(lines, cursorLine, cursorCol);
          if (!match || match.prefix.length === 0) return null;
          if (match.prefix.includes("#")) return { prefix: match.prefix, items: await searchSections(match.prefix) };
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
          // Completing inside a closed link (`[[Note#|]]`) replaces it whole.
          const rest = closedLinkRest(line.slice(cursorCol));
          lines[cursorLine] = line.slice(0, start) + replacement + line.slice(cursorCol + rest.length);
          return { lines, cursorLine, cursorCol: start + replacement.length };
        },
      };
      let lookupId = 0;
      let lookupItems: AutocompleteItem[] = [];
      let selectedIndex = 0;
      // The link the cursor is in: an open `[[query` before the cursor, or a
      // closed link being given a section (`[[Note#|]]`).
      const linkAtCursor = (editor: CustomEditor) => {
        const { line, col } = editor.getCursor();
        const text = editor.getLines()[line] ?? "";
        const match = wikilinkPrefix([text], 0, col);
        if (!match || match.prefix.length === 0) return null;
        const rest = closedLinkRest(text.slice(col));
        // Moving the cursor into a finished link shouldn't take over arrows and Enter.
        if (rest && !match.prefix.includes("#")) return null;
        return { line, start: match.start, end: col + rest.length, query: match.prefix };
      };
      const showLookup = (editor: CustomEditor) => {
        const link = linkAtCursor(editor);
        if (!link) {
          lookupItems = [];
          selectedIndex = 0;
          ctx.ui.setWidget("obsidian-wikilinks", undefined);
          return;
        }
        const isSection = link.query.includes("#");
        const id = ++lookupId;
        void (isSection ? searchSections(link.query) : searchLocalVault(link.query)).then((items) => {
          if (id !== lookupId) return;
          lookupItems = items.slice(0, 8);
          selectedIndex = Math.min(selectedIndex, Math.max(0, lookupItems.length - 1));
          ctx.ui.setWidget("obsidian-wikilinks", lookupItems.length
            ? lookupItems.map((item, index) => `${index === selectedIndex ? "❯ " : "  " }[[${item.value}]]`)
            : [isSection ? "No matching sections" : "No matching note names"]);
        });
      };
      class ObsidianEditor extends CustomEditor {
        override handleInput(data: string): void {
          // Keep selection independent of pi's built-in autocomplete list.
          if (lookupItems.length > 0 && (data === "\x1b[A" || data === "\x1b[B")) {
            selectedIndex = data === "\x1b[A"
              ? (selectedIndex + lookupItems.length - 1) % lookupItems.length
              : (selectedIndex + 1) % lookupItems.length;
            showLookup(this);
            return;
          }
          if (lookupItems.length > 0 && (data === "\r" || data === "\n")) {
            const item = lookupItems[selectedIndex];
            const link = linkAtCursor(this);
            if (item && link) {
              const lines = [...this.getLines()];
              const text = lines[link.line] ?? "";
              lines[link.line] = text.slice(0, link.start) + `[[${item.value}]]` + text.slice(link.end);
              this.setText(lines.join("\n"));
              showLookup(this);
              return;
            }
          }
          super.handleInput(data);
          showLookup(this);
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
