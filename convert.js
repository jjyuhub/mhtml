// Fully self-contained export from *.mhtml/*.mht in REPO ROOT to /dist/<name>/index.html.
// Step 1: MHTML -> HTML (string) with fast-mhtml2html
// Step 2: Conservatively inline ONLY external http(s) resources:
//         stylesheets, @import, css url(...), images, scripts, icons
// NOTE: Anything already embedded by the MHTML snapshot (cid:, blob:, data:, mhtml: etc.)
//       is LEFT ALONE to avoid layout breakage.

import { glob } from "glob";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import * as csstree from "css-tree";
import fetch from "node-fetch";
import { lookup as mimeLookup } from "mime-types";
import m2h from "fast-mhtml2html";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT = path.join(__dirname, "dist");
await fs.emptyDir(OUT);

// Only root; change to "**/*.{mhtml,mht}" to recurse
const files = await glob("*.{mhtml,mht}", { nocase: true });

if (files.length === 0) {
  await fs.outputFile(
    path.join(OUT, "index.html"),
    "<!doctype html><meta charset=utf-8><title>MHTML builds</title><h1>No .mhtml/.mht files in repo root</h1>"
  );
  process.exit(0);
}

// Realistic UA; some CDNs block default node UA for fonts/CSS
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function httpToHttps(u) {
  if (!u) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http://")) return "https://" + u.slice(7);
  return u;
}

// Treat these schemes/placeholders as already-embedded (don’t touch)
const isEmbedded = (u) =>
  !u ||
  /^data:|^cid:|^blob:|^mhtml:|^cid!|^about:blank/i.test(u) ||
  /^https?!/i.test(u); // some converters create "https!domain!path" placeholders

async function fetchBuffer(u) {
  const url = httpToHttps(u);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

async function fetchText(u) {
  const buf = await fetchBuffer(u);
  return buf ? buf.toString("utf8") : null;
}

async function fetchAsDataURL(u) {
  const buf = await fetchBuffer(u);
  if (!buf) return null;
  const ct = mimeLookup(u) || "application/octet-stream";
  return `data:${ct};base64,${buf.toString("base64")}`;
}

/* ---------- SAFE @import INLINER (regex-based, no AST mutation) ---------- */
async function inlineCssImports(css, baseHref) {
  if (!css) return css;

  // Matches: @import url(...);  OR  @import "..."  OR  @import '...'
  const importRe = /@import\s+(?:url\(\s*([^)\s]+)\s*\)|(['"])(.*?)\2)([^;]*);/gi;

  let out = "";
  let lastIndex = 0;
  for (let m; (m = importRe.exec(css)); ) {
    out += css.slice(lastIndex, m.index);
    lastIndex = importRe.lastIndex;

    let importUrl = (m[1] || m[3] || "").replace(/^['"]|['"]$/g, "");
    try {
      if (baseHref && !/^https?:|^data:|^\/\//i.test(importUrl)) {
        importUrl = new URL(importUrl, httpToHttps(baseHref)).toString();
      } else {
        importUrl = httpToHttps(importUrl);
      }
    } catch {
      continue;
    }

    let importedCss = await fetchText(importUrl);
    if (!importedCss) continue;
    importedCss = await inlineCssImports(importedCss, importUrl);
    importedCss = await inlineCssUrls(importedCss, importUrl);
    out += importedCss;
  }
  out += css.slice(lastIndex);
  return out;
}

/* ---------- url(...) INLINER (css-tree with regex fallback) ---------- */
async function inlineCssUrls(css, baseHref = "") {
  if (!css) return css;

  try {
    const ast = csstree.parse(css, { parseValue: true, parseRulePrelude: true });
    const tasks = [];

    csstree.walk(ast, (node) => {
      if (node.type === "Url" && node.value) {
        const raw0 = String(node.value);
        const raw = raw0.replace(/^['"]|['"]$/g, "");
        if (raw.startsWith("data:") || isEmbedded(raw)) return;

        // Resolve relative
        let u = raw;
        try {
          if (baseHref && !/^https?:|^data:|^\/\//i.test(raw)) {
            u = new URL(raw, httpToHttps(baseHref)).toString();
          }
        } catch { /* ignore */ }

        tasks.push(
          (async () => {
            const dataURL = await fetchAsDataURL(u);
            node.value = dataURL || httpToHttps(u); // inline, else at least https
          })()
        );
      }
    });

    await Promise.all(tasks);
    return csstree.generate(ast);
  } catch {
    // Fallback: simple url(...) regex
    const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const parts = [];
    let last = 0, m;
    while ((m = urlRe.exec(css))) {
      parts.push(css.slice(last, m.index));
      last = urlRe.lastIndex;

      let u = m[2];
      if (u.startsWith("data:") || isEmbedded(u)) {
        parts.push(`url(${m[1]}${u}${m[1]})`);
        continue;
      }
      try {
        if (baseHref && !/^https?:|^data:|^\/\//i.test(u)) {
          u = new URL(u, httpToHttps(baseHref)).toString();
        } else {
          u = httpToHttps(u);
        }
      } catch { /* ignore */ }

      const dataURL = await fetchAsDataURL(u);
      parts.push(`url(${m[1]}${dataURL || u}${m[1]})`);
    }
    parts.push(css.slice(last));
    return parts.join("");
  }
}

/* ---------- HTML INLINER (CONSERVATIVE) ---------- */
async function inlineEverything(html, docUrl = "") {
  const $ = cheerio.load(html, { decodeEntities: false });

  // 1) Stylesheets: inline ONLY if clearly external http(s). Leave cid:/blob:/data:/placeholders intact.
  for (const el of $('link[rel="stylesheet"][href]').toArray()) {
    const href = $(el).attr("href");
    if (!href || isEmbedded(href)) continue;
    if (!/^https?:\/\//i.test(href)) continue;

    let css = await fetchText(href);
    if (!css) continue; // keep original if fetch fails
    css = await inlineCssImports(css, href);
    css = await inlineCssUrls(css, href);
    $(el).replaceWith(`<style>${css}</style>`);
  }

  // 2) <style> blocks: only inline url(...) (don’t attempt to resolve @import without a base)
  for (const el of $("style").toArray()) {
    const css = $(el).html() || "";
    const inlined = await inlineCssUrls(css, docUrl);
    $(el).html(inlined);
  }

  // 3) style="" attributes: url(...) only
  for (const el of $("[style]").toArray()) {
    const css = $(el).attr("style");
    if (!css) continue;
    const inlined = await inlineCssUrls(css, docUrl);
    $(el).attr("style", inlined);
  }

  // 4) Images: inline ONLY if external http(s). Leave embedded/relative alone (they came from MHTML).
  for (const el of $("img[src]").toArray()) {
    const src = $(el).attr("src");
    if (!src || isEmbedded(src)) continue;
    if (!/^https?:\/\//i.test(src)) continue;
    const data = await fetchAsDataURL(src);
    if (data) $(el).attr("src", data);
  }

  // 5) Scripts: inline ONLY if external http(s). Leave embedded/relative alone.
  for (const el of $('script[src]').toArray()) {
    const src = $(el).attr("src");
    if (!src || isEmbedded(src)) continue;
    if (!/^https?:\/\//i.test(src)) continue;
    const js = await fetchText(src);
    if (!js) continue;               // keep original if fetch fails
    $(el).removeAttr("src").text(js);
  }

  // 6) Icons: inline ONLY if external http(s).
  for (const el of $('link[rel="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]').toArray()) {
    const href = $(el).attr("href");
    if (!href || isEmbedded(href)) continue;
    if (!/^https?:\/\//i.test(href)) continue;
    const data = await fetchAsDataURL(href);
    if (data) $(el).attr("href", data);
  }

  // 7) Last resort: upgrade any remaining absolute http:// links to https://
  $('link[href], img[src], script[src]').each((_, el) => {
    const $el = $(el);
    const attr = $el.is("link") ? "href" : "src";
    const val = $el.attr(attr);
    if (val && /^http:\/\//i.test(val)) $el.attr(attr, httpToHttps(val));
  });

  return $.html({ decodeEntities: false });
}

/* ---------- MAIN ---------- */
const links = [];

for (const file of files) {
  const base = path.basename(file).replace(/\.(mhtml|mht)$/i, "");
  const safe = encodeURIComponent(base);

  // Step 1: MHTML -> HTML (string)
  const buf = await fs.readFile(file);
  const html1 = m2h.convert(buf); // returns a string
  if (typeof html1 !== "string" || !html1.length) {
    throw new Error("fast-mhtml2html did not return an HTML string");
  }

  // Step 2: Inline external bits, preserve embedded ones
  const finalHtml = await inlineEverything(html1 /* docUrl unknown */);

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
<h1>MHTML builds (self-contained, layout-safe)</h1>
<ul>
${links.join("\n")}
</ul>`;
await fs.writeFile(path.join(OUT, "index.html"), indexHtml, "utf8");
