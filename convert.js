// Fully self-contained export from *.mhtml/*.mht in REPO ROOT to /dist/<name>/index.html.
// Step 1: MHTML -> HTML (string) with fast-mhtml2html
// Step 2: Hard-inline EVERYTHING: stylesheets, @import, css url(...), images, fonts, scripts, icons
// Result: zero network requests at runtime (no CORS/mixed-content/404s).

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

// Use a realistic UA; some CDNs block default node UA for fonts/CSS
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function httpToHttps(u) {
  if (!u) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http://")) return "https://" + u.slice(7);
  return u;
}

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

// Inline url(...) inside CSS; resolves relative URLs against baseHref when provided.
async function inlineCssUrls(css, baseHref = "") {
  if (!css) return css;

  const ast = csstree.parse(css, { parseValue: true, parseRulePrelude: true });
  const tasks = [];

  csstree.walk(ast, (node) => {
    if (node.type === "Url" && node.value) {
      const raw0 = String(node.value);
      const raw = raw0.replace(/^['"]|['"]$/g, "");
      if (raw.startsWith("data:")) return;

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
}

// Inline @import rules recursively
async function inlineCssImports(css, baseHref) {
  if (!css) return css;
  const ast = csstree.parse(css, { parseValue: true, parseRulePrelude: true });
  const parts = [];

  for (const node of ast.children.toArray()) {
    if (node.type === "Atrule" && node.name === "import") {
      const prelude = csstree.generate(node.prelude || "");
      const m = /url\(([^)]+)\)|(['"])(.*?)\2/.exec(prelude);
      const importUrlRaw = m ? (m[1] || m[3]) : null;
      if (!importUrlRaw) continue;

      let url = importUrlRaw.replace(/^['"]|['"]$/g, "");
      try {
        if (baseHref && !/^https?:|^data:|^\/\//i.test(url)) {
          url = new URL(url, httpToHttps(baseHref)).toString();
        } else {
          url = httpToHttps(url);
        }
      } catch { /* ignore */ }

      const importedCss = await fetchText(url);
      if (importedCss) {
        // Recursively inline imports and URLs in the imported CSS
        let inlined = await inlineCssImports(importedCss, url);
        inlined = await inlineCssUrls(inlined, url);
        // Replace the @import node with the actual CSS rules
        const importedAst = csstree.parse(inlined, {
          parseValue: true,
          parseRulePrelude: true
        });
        parts.push(...importedAst.children.toArray());
        ast.children.remove(node);
      }
    }
  }

  // Append imported parts (if any)
  for (const n of parts) ast.children.appendData(n);
  return csstree.generate(ast);
}

async function inlineEverything(html, docUrl = "") {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Remove trackers/ads & hints that cause outbound requests
  $('script[src*="doubleclick"],script[src*="googletag"],script[src*="tr.snapchat"],script[src*="stripe"]').remove();
  $('link[rel="preconnect"],link[rel="dns-prefetch"],link[rel="preload"],link[rel="prefetch"]').remove();

  // Icons
  for (const el of $('link[rel="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]').toArray()) {
    const href = $(el).attr("href");
    if (!href) continue;
    let abs = href;
    try {
      if (docUrl && !/^https?:|^data:|^\/\//i.test(href)) abs = new URL(href, httpToHttps(docUrl)).toString();
    } catch { /* ignore */ }
    const data = await fetchAsDataURL(abs);
    if (data) $(el).attr("href", data);
  }

  // Stylesheets -> <style>
  for (const el of $('link[rel="stylesheet"][href]').toArray()) {
    const href = $(el).attr("href");
    if (!href) continue;
    let abs = href;
    try {
      if (docUrl && !/^https?:|^data:|^\/\//i.test(href)) abs = new URL(href, httpToHttps(docUrl)).toString();
    } catch { /* ignore */ }
    let css = await fetchText(abs);
    if (!css) continue;
    css = await inlineCssImports(css, abs);
    css = await inlineCssUrls(css, abs);
    $(el).replaceWith(`<style>${css}</style>`);
  }

  // <style> blocks (inline url(...) and @import if any)
  for (const el of $("style").toArray()) {
    let css = $(el).html() || "";
    css = await inlineCssImports(css, docUrl);
    css = await inlineCssUrls(css, docUrl);
    $(el).html(css);
  }

  // Inline style="" attributes
  for (const el of $("[style]").toArray()) {
    const css = $(el).attr("style");
    if (!css) continue;
    const inlined = await inlineCssUrls(css, docUrl);
    $(el).attr("style", inlined);
  }

  // Images -> data:
  for (const el of $("img[src]").toArray()) {
    const src = $(el).attr("src");
    if (!src || src.startsWith("data:")) continue;
    let abs = src;
    try {
      if (docUrl && !/^https?:|^data:|^\/\//i.test(src)) abs = new URL(src, httpToHttps(docUrl)).toString();
    } catch { /* ignore */ }
    const data = await fetchAsDataURL(abs);
    if (data) $(el).attr("src", data);
  }

  // Scripts -> inline text (skip ones we removed above)
  for (const el of $('script[src]').toArray()) {
    const src = $(el).attr("src");
    if (!src) continue;
    let abs = src;
    try {
      if (docUrl && !/^https?:|^data:|^\/\//i.test(src)) abs = new URL(src, httpToHttps(docUrl)).toString();
    } catch { /* ignore */ }
    const js = await fetchText(abs);
    if (!js) continue;
    $(el).removeAttr("src").text(js);
  }

  // iframes often point to trackers/ads – drop them for single-file output
  $("iframe").remove();

  // Last-resort: upgrade any remaining absolute http:// links to https://
  $('link[href], img[src], script[src]').each((_, el) => {
    const $el = $(el);
    const attr = $el.is("link") ? "href" : "src";
    const val = $el.attr(attr);
    if (val && /^http:\/\//i.test(val)) $el.attr(attr, httpToHttps(val));
  });

  return $.html({ decodeEntities: false });
}

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

  // Step 2: Inline everything
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
<h1>MHTML builds (self-contained)</h1>
<ul>
${links.join("\n")}
</ul>`;
await fs.writeFile(path.join(OUT, "index.html"), indexHtml, "utf8");
