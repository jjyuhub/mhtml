// Exact, offline MHTML → single HTML
// - Parse multipart/related .mhtml yourself (no browser, no network)
// - Build a map of parts by Content-Location and Content-ID
// - Rewrite HTML + CSS to inline EVERY referenced asset as data: URI
// - Inline <link rel=stylesheet> and <script src> as inline text
// - Handle Chrome placeholders: cid!…@mhtml.blink and https!domain!path
// - Output: dist/<name>/index.html + dist/index.html (listing)

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import * as cheerio from "cheerio";
import * as csstree from "css-tree";
import iconv from "iconv-lite";
import { lookup as mimeLookup } from "mime-types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT = path.join(__dirname, "dist");
await fs.emptyDir(OUT);

// --------- helpers ---------
function decodeQP(str) {
  // RFC 2045 quoted-printable; keep it simple
  return str
    .replace(/=\r?\n/g, "")               // soft line breaks
    .replace(/=([A-Fa-f0-9]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseHeaders(block) {
  // unfolded header lines
  const lines = block.split(/\r?\n/);
  const out = {};
  let cur = "";
  for (const line of lines) {
    if (/^\s/.test(line) && cur) {
      out[cur.name] += " " + line.trim();
      continue;
    }
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    cur = { name: m[1].toLowerCase(), val: m[2] };
    out[cur.name] = cur.val;
  }
  return out;
}

function getCharset(ct) {
  const m = /charset\s*=\s*("?)([^";]+)\1/i.exec(ct || "");
  return m ? m[2].trim().toLowerCase() : "utf-8";
}

function normalizeWeirdUrl(u) {
  if (!u) return u;
  const m = /^(https?)!([^!]+)(?:!(.*))?$/i.exec(u);
  if (!m) return u;
  const scheme = m[1].toLowerCase();
  const host = m[2];
  const rest = (m[3] || "").replace(/!/g, "/");
  return `${scheme}://${host}/${rest}`;
}
function extractCidFromWeird(u) {
  // cid!xyz@mhtml.blink -> xyz
  const m = /^cid!([^@]+)@/i.exec(u || "");
  return m ? m[1] : null;
}
function normKey(u) {
  return (u || "").trim().replace(/[\r\n]+/g, "").replace(/\\/g, "/");
}

function toDataURI(buf, contentType) {
  const ct = contentType || "application/octet-stream";
  const b64 = Buffer.isBuffer(buf) ? buf.toString("base64") : Buffer.from(buf).toString("base64");
  return `data:${ct};base64,${b64}`;
}

function resolveAgainst(base, href) {
  if (!href) return href;
  try {
    if (/^data:|^cid:|^blob:|^about:|^file:/i.test(href)) return href;
    if (/^(https?|http)!/i.test(href)) return normalizeWeirdUrl(href);
    if (/^https?:\/\//i.test(href)) return href;
    if (base) return new URL(href, base).toString();
  } catch { /* ignore */ }
  return href;
}

// --------- parse MHTML container ---------
function parseMHTML(buffer) {
  // Find the outer boundary
  const text = buffer.toString("binary");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("Invalid MHTML: no header section");
  const headText = text.slice(0, headerEnd);
  const headers = parseHeaders(headText);
  const ctype = headers["content-type"] || "";
  const bmatch = /boundary="?([^"]+)"?/i.exec(ctype);
  if (!bmatch) throw new Error("Invalid MHTML: no boundary");
  const boundary = bmatch[1];

  const delim = "--" + boundary;
  const partsRaw = text.split(delim).slice(1); // skip prologue
  const parts = [];

  for (let raw of partsRaw) {
    // strip CRLF and end marker
    raw = raw.replace(/^\r?\n/, "");
    if (/--\s*$/.test(raw)) raw = raw.replace(/--\s*$/, "");
    if (!raw.trim()) continue;

    const idx = raw.indexOf("\r\n\r\n");
    if (idx < 0) continue;
    const headerBlock = raw.slice(0, idx);
    let bodyBin = raw.slice(idx + 4);

    const ph = parseHeaders(headerBlock);
    const enc = (ph["content-transfer-encoding"] || "").toLowerCase();
    const ct = ph["content-type"] || "application/octet-stream";
    const charset = getCharset(ct);

    let buf;
    if (enc.includes("base64")) {
      // Remove whitespace for base64 decoding
      const clean = bodyBin.replace(/\s+/g, "");
      buf = Buffer.from(clean, "base64");
    } else if (enc.includes("quoted-printable")) {
      buf = Buffer.from(decodeQP(bodyBin), "binary");
    } else {
      buf = Buffer.from(bodyBin, "binary");
    }

    // Try decoding text parts to UTF-8 for HTML/CSS/JS
    let textDecoded = null;
    if (/^text\//i.test(ct)) {
      try {
        if (charset && charset !== "utf-8" && iconv.encodingExists(charset)) {
          textDecoded = iconv.decode(buf, charset);
        } else {
          textDecoded = buf.toString("utf-8");
        }
      } catch { textDecoded = buf.toString("utf-8"); }
    }

    const loc = ph["content-location"];
    let cid = ph["content-id"];
    if (cid) cid = cid.replace(/^<|>$/g, "");

    parts.push({
      headers: ph,
      contentType: ct.split(";")[0].trim().toLowerCase(),
      charset,
      contentLocation: loc ? normKey(loc) : null,
      contentId: cid ? normKey(cid) : null,
      buf,
      text: textDecoded
    });
  }

  return parts;
}

// Build a lookup map from parsed parts
function buildPartMap(parts, docBase) {
  const byKey = new Map();

  function addKey(key, value) {
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, value);
  }

  for (const p of parts) {
    const dataURI = toDataURI(p.buf, p.contentType || mimeLookup(p.contentLocation) || "application/octet-stream");
    const value = { ...p, dataURI };

    // Content-Location (as-is)
    addKey(normKey(p.contentLocation), value);

    // Also index Content-Location relative to docBase path (if applicable)
    if (docBase && p.contentLocation) {
      try {
        const abs = new URL(p.contentLocation, docBase).toString();
        addKey(normKey(abs), value);
      } catch {}
    }

    // Content-ID
    if (p.contentId) {
      addKey("cid:" + normKey(p.contentId), value);
      addKey(normKey(p.contentId), value);
    }

    // Chrome placeholder form for cid: cid!<id>@mhtml.blink
    if (p.contentId) {
      addKey("cid!" + normKey(p.contentId) + "@mhtml.blink", value);
    }

    // Also map guessed mime for missing types
    if (p.contentLocation && !p.contentType) {
      const mt = mimeLookup(p.contentLocation);
      if (mt) value.contentType = mt;
    }
  }

  return byKey;
}

// Inline url(...) in CSS using map (no network)
async function inlineCssUrlsWithMap(css, baseHref, partMap) {
  if (!css) return css;
  const ast = csstree.parse(css, { parseValue: true, parseRulePrelude: true });
  csstree.walk(ast, (node) => {
    if (node.type === "Url" && node.value) {
      let raw = String(node.value).replace(/^['"]|['"]$/g, "");
      if (raw.startsWith("data:")) return;

      // normalize odd placeholders and resolve relative
      if (/^(https?|http)!/i.test(raw)) raw = normalizeWeirdUrl(raw);
      const normRaw = normKey(resolveAgainst(baseHref, raw));
      // Try map hits: exact, cid patterns, and raw as-is
      let hit =
        partMap.get(normRaw) ||
        partMap.get("cid:" + raw) ||
        partMap.get(raw) ||
        (raw.startsWith("cid:") ? partMap.get(normKey(raw)) : null) ||
        (raw.startsWith("cid!") ? partMap.get(raw) : null);

      if (hit) {
        node.value = hit.dataURI;
      } else {
        // leave as-is (so you can see if something wasn't captured)
      }
    }
  });
  return csstree.generate(ast);
}

// Inline @import in CSS using map (no network)
async function inlineCssImportsWithMap(css, baseHref, partMap) {
  if (!css) return css;

  const importRe = /@import\s+(?:url\(\s*([^)\s]+)\s*\)|(['"])(.*?)\2)\s*([^;]*);/gi;

  let out = "";
  let lastIndex = 0;
  for (let m; (m = importRe.exec(css)); ) {
    out += css.slice(lastIndex, m.index);
    lastIndex = importRe.lastIndex;

    let importUrl = (m[1] || m[3] || "").replace(/^['"]|['"]$/g, "");
    if (/^(https?|http)!/i.test(importUrl)) importUrl = normalizeWeirdUrl(importUrl);
    const target = normKey(resolveAgainst(baseHref, importUrl));
    const hit = partMap.get(target) || partMap.get(importUrl) || partMap.get(normKey(importUrl));
    if (!hit) {
      // couldn't resolve from MHTML; drop the @import to avoid external pulls
      continue;
    }
    let importedCss = hit.text || hit.buf.toString("utf-8");
    importedCss = await inlineCssImportsWithMap(importedCss, hit.contentLocation || baseHref, partMap);
    importedCss = await inlineCssUrlsWithMap(importedCss, hit.contentLocation || baseHref, partMap);
    out += importedCss;
  }
  out += css.slice(lastIndex);
  return out;
}

// Do full HTML rewrite with part map only (no network)
async function rewriteHtmlWithMap(html, docBase, partMap) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Fix <base href> to current dir to avoid accidental external resolution
  const baseEl = $("base[href]").first();
  if (baseEl.length) baseEl.attr("href", ".");

  // Stylesheets -> inline <style>
  for (const el of $('link[rel="stylesheet"][href]').toArray()) {
    let href = $(el).attr("href") || "";
    if (/^(https?|http)!/i.test(href)) href = normalizeWeirdUrl(href);
    const key = normKey(resolveAgainst(docBase, href));
    const hit = partMap.get(key) || partMap.get(href) || partMap.get(normKey(href)) ||
                partMap.get("cid:" + href) || partMap.get(href.replace(/^cid:/, ""));
    if (hit) {
      let css = hit.text || hit.buf.toString("utf-8");
      css = await inlineCssImportsWithMap(css, hit.contentLocation || docBase, partMap);
      css = await inlineCssUrlsWithMap(css, hit.contentLocation || docBase, partMap);
      $(el).replaceWith(`<style>${css}</style>`);
    } else {
      // If it's the Chrome placeholder for cid, remove to prevent 404s:
      if (/^cid!/i.test(href)) $(el).remove();
    }
  }

  // <style> blocks: inline url(...) based on map and inline any @import pointing to parts
  for (const el of $("style").toArray()) {
    let css = $(el).html() || "";
    css = await inlineCssImportsWithMap(css, docBase, partMap);
    css = await inlineCssUrlsWithMap(css, docBase, partMap);
    $(el).html(css);
  }

  // Inline style="" url(...)
  for (const el of $("[style]").toArray()) {
    const css = $(el).attr("style");
    if (!css) continue;
    const inlined = await inlineCssUrlsWithMap(css, docBase, partMap);
    $(el).attr("style", inlined);
  }

  // Images
  for (const el of $("img[src]").toArray()) {
    let src = $(el).attr("src") || "";
    if (/^(https?|http)!/i.test(src)) src = normalizeWeirdUrl(src);
    const key = normKey(resolveAgainst(docBase, src));
    const hit =
      partMap.get(key) || partMap.get(src) || partMap.get(normKey(src)) ||
      partMap.get("cid:" + src) || partMap.get(src.replace(/^cid:/, "")) ||
      (src.startsWith("cid!") ? partMap.get(src) : null) ||
      (extractCidFromWeird(src) ? partMap.get("cid:" + extractCidFromWeird(src)) : null);

    if (hit) $(el).attr("src", hit.dataURI);
  }

  // Scripts: inline content
  for (const el of $('script[src]').toArray()) {
    let src = $(el).attr("src") || "";
    if (/^(https?|http)!/i.test(src)) src = normalizeWeirdUrl(src);
    const key = normKey(resolveAgainst(docBase, src));
    const hit =
      partMap.get(key) || partMap.get(src) || partMap.get(normKey(src)) ||
      partMap.get("cid:" + src) || partMap.get(src.replace(/^cid:/, "")) ||
      (src.startsWith("cid!") ? partMap.get(src) : null) ||
      (extractCidFromWeird(src) ? partMap.get("cid:" + extractCidFromWeird(src)) : null);

    if (hit) {
      const js = hit.text || hit.buf.toString("utf-8");
      $(el).removeAttr("src").text(js);
    }
  }

  // Icons
  for (const el of $('link[rel="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]').toArray()) {
    let href = $(el).attr("href") || "";
    if (/^(https?|http)!/i.test(href)) href = normalizeWeirdUrl(href);
    const key = normKey(resolveAgainst(docBase, href));
    const hit =
      partMap.get(key) || partMap.get(href) || partMap.get(normKey(href)) ||
      partMap.get("cid:" + href) || partMap.get(href.replace(/^cid:/, "")) ||
      (href.startsWith("cid!") ? partMap.get(href) : null) ||
      (extractCidFromWeird(href) ? partMap.get("cid:" + extractCidFromWeird(href)) : null);

    if (hit) $(el).attr("href", hit.dataURI);
  }

  // <a href="cid:..."> turn into blob-ish data URLs so iOS doesn’t try to navigate
  for (const el of $('a[href^="cid:"], a[href^="cid!"]').toArray()) {
    const href = $(el).attr("href") || "";
    const cid = href.startsWith("cid!") ? extractCidFromWeird(href) : href.replace(/^cid:/i, "");
    const hit = partMap.get("cid:" + cid) || partMap.get(cid);
    if (hit) $(el).attr("href", hit.dataURI);
  }

  // Remove prefetch/preconnect/preload/dns-prefetch (avoid hints)
  $('link[rel="preconnect"],link[rel="dns-prefetch"],link[rel="preload"],link[rel="prefetch"]').remove();

  return $.html({ decodeEntities: false });
}

// --------- main build ---------
const files = await glob("*.{mhtml,mht}", { nocase: true });
if (files.length === 0) {
  await fs.outputFile(path.join(OUT, "index.html"),
    "<!doctype html><meta charset=utf-8><title>MHTML builds</title><h1>No .mhtml/.mht files in repo root</h1>");
  process.exit(0);
}

const links = [];

for (const file of files) {
  const base = path.basename(file).replace(/\.(mhtml|mht)$/i, "");
  const safe = encodeURIComponent(base);

  const buf = await fs.readFile(file);

  // Parse all parts
  const parts = parseMHTML(buf);

  // Find the main HTML part (prefer text/html with largest size)
  const htmlParts = parts.filter(p => (p.contentType || "").startsWith("text/html"));
  if (htmlParts.length === 0) throw new Error(`No text/html part found in ${file}`);
  htmlParts.sort((a, b) => (b.buf.length - a.buf.length));
  const rootPart = htmlParts[0];

  // Doc base for resolving relatives
  const docBase = rootPart.contentLocation || null;

  // Build lookup map
  const partMap = buildPartMap(parts, docBase);

  // Rewrite HTML with map (inline everything)
  const html0 = rootPart.text || rootPart.buf.toString("utf-8");
  const finalHtml = await rewriteHtmlWithMap(html0, docBase, partMap);

  // Write output
  const dir = path.join(OUT, base);
  await fs.mkdirp(dir);
  await fs.writeFile(path.join(dir, "index.html"), finalHtml, "utf8");

  links.push(`<li><a href="./${safe}/">${base}</a></li>`);
  console.log(`✓ ${file} → dist/${base}/index.html`);
}

// Landing page
const indexHtml = `<!doctype html>
<meta charset="utf-8">
<title>MHTML builds</title>
<h1>MHTML builds (one-to-one inline, offline)</h1>
<ul>
${links.join("\n")}
</ul>`;
await fs.writeFile(path.join(OUT, "index.html"), indexHtml, "utf8");
