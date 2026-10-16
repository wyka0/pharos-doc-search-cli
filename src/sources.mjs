/**
 * Source-reference extraction.
 *
 * The Docs MCP returns a Markdown answer whose citations are inline Markdown links, e.g.
 *
 *   **Source:** [Write Your First dApp (Hardhat)](https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-dapp)
 *
 * The service does not return a separate citations array, document ids or a search-result
 * envelope (the `card` stream channel was empty in every observed live reply). The links in
 * the answer ARE the source references, so this module only *extracts* them — it never
 * rewrites, normalises or invents them. A URL printed by the CLI is byte-for-byte the URL
 * the service returned.
 *
 * Images (`![alt](url)`) and links inside fenced code blocks are ignored: they are examples,
 * not citations.
 */

/** @typedef {{ title: string, url: string, host: string, pharosDocs: boolean }} SourceRef */

const MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(\s*<?([^()\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const BARE_URL_RE = /https?:\/\/[^\s<>"'`()\[\]]+/g;
const FENCE_RE = /^(```|~~~)/;

/** @param {string} url */
export function hostOfUrl(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** @param {string} host */
export function isPharosDocsHost(host) {
  return host === "docs.pharos.xyz" || host.endsWith(".docs.pharos.xyz");
}

/**
 * Collect the source references the service itself put in the answer.
 * @param {string} answer
 * @returns {{ sources: SourceRef[], pharosDocs: SourceRef[], external: SourceRef[], urls: string[] }}
 */
export function extractSources(answer) {
  const text = typeof answer === "string" ? answer : "";
  /** @type {SourceRef[]} */
  const sources = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<[number, number]>} */
  const claimed = [];

  /** @param {string} title @param {string} rawUrl */
  function add(title, rawUrl) {
    const url = rawUrl.replace(/[.,;:]+$/, "");
    if (!url) return;
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const host = hostOfUrl(url);
    sources.push({ title: title.trim() || host || url, url, host, pharosDocs: isPharosDocsHost(host) });
  }

  // Code fences describe example URLs (e.g. `git clone https://github.com/...`), not citations.
  const masked = maskCodeFences(text);

  MARKDOWN_LINK_RE.lastIndex = 0;
  let match;
  while ((match = MARKDOWN_LINK_RE.exec(masked))) {
    const [full, bang, title, url] = match;
    claimed.push([match.index, match.index + full.length]);
    if (bang === "!") continue; // image, not a reference
    add(title, url);
  }

  BARE_URL_RE.lastIndex = 0;
  while ((match = BARE_URL_RE.exec(masked))) {
    const start = match.index;
    const end = start + match[0].length;
    if (claimed.some(([s, e]) => start >= s && end <= e)) continue;
    add("", match[0]);
  }

  return {
    sources,
    pharosDocs: sources.filter((s) => s.pharosDocs),
    external: sources.filter((s) => !s.pharosDocs),
    urls: sources.map((s) => s.url),
  };
}

/** Replace the contents of fenced code blocks with spaces, preserving offsets. */
function maskCodeFences(text) {
  const lines = text.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      if (FENCE_RE.test(line.trim())) {
        inFence = !inFence;
        return " ".repeat(line.length);
      }
      return inFence ? " ".repeat(line.length) : line;
    })
    .join("\n");
}

/**
 * Render the source list as human-readable lines (used by the text output mode).
 * @param {SourceRef[]} sources
 * @param {string} [indent]
 */
export function formatSourceLines(sources, indent = "  ") {
  const width = String(sources.length).length;
  return sources.map((s, i) => `${indent}${String(i + 1).padStart(width)}. ${s.title} — ${s.url}`);
}
