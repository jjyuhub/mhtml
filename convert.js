// Full single-file export from *.mhtml/*.mht in REPO ROOT to /dist/<name>/index.html.
// 1) Open the MHTML directly in headless Chromium via SingleFile (handles cid:)
// 2) Hard-inline any remaining external assets (CSS, fonts, images, JS, CSS url(...))
// 3) Remove trackers/ads and preconnect/prefetch hints
// Result: zero network requests at runtime (no CORS, no mixed content)

import { glob } from "glob";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import * as cheerio from "cheerio";
import * as csstree from "css-tree";
import fetch from "node-fetch";
import { lookup as mimeLookup } from "mime-types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT = path.join(__dirname, "dist");
const WORK = await fs.mkdtemp(path.join(os.tmpdir(), "mhtml-work-"));

await fs.emptyDir(OUT);

// Only repo root; switch to "**/*.{mhtml,mht}" if you want recursion
const files = await glob("*.{mhtml,mht}", { nocase: true });
if (files.length === 0) {
  await fs.outputFile(
    path.join(OUT, "index.html"),
    "<!doctype html><meta charset=utf-8><title>MHTML builds</title><h1>No .mhtml/.mht files in repo root</h1>"
  );
  process.exit(0);
}

const links = [];

for (const file of files) {
  const base = path.basename(file).replace(/\.(mhtml|mht)$/i, "");
  const safe = encodeURIComponent(base);

  // 1) Render the MHTML directly with SingleFile (Chromium resolves cid:)
  const singleFileBin = path.join(
    __dirname,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "single-file.cmd" : "single-file"
  );
  const mhtmlUrl = `file://${path.join(__dirname, file).replace(/ /g, "%20")}`;

  // Allow insecure content during *build* so SingleFile can fetch then inline it
  const browserArgs = [
    "--allow-file-access-from-files",
    "--disable-web-security",
    "--allow-running-insecure-content"
  ];

  let html = await runAndCapture(singleFileBin, [
    mhtmlUrl,
    "--dump-content",
    "--browser-args",
    JSON.stringify(browserArgs) // <-- correct JSON array
  ]);

  // Safety: if SingleFile returned nothing, at least show something
  if (!html || !html.trim()) html = await fallbackHtml(file);

  // 2) Hard-inline remaining external assets
  html = await inlineAll(html);

  // 3) Write final page
  const finalDir = path.join(OUT, base);
  await fs.mkdirp(finalDir);
  await fs.writeFile(path.join(finalDir, "index.html"), html, "utf8");

  links.push(`<li><a href="./${safe}/">${base}</a></li>`);
  console.log(`✓ ${file} → dist/${base}/index.html`);
}

// Landing page
const indexHtml = `<!doctype html>
<meta charset="utf-8">
<title>MHTML builds</title>
<h1>MHTML builds</h1>
<ul>
${links.join("\n")}
</ul>`;
await fs.writeFile(path.join(OUT, "index.html"), indexHtml, "utf8");

// Cleanup temp dir
try { await fs.rm(WORK, { recursive: true, force: true }); } catch {}

function runAndCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    let out = Buffer.alloc(0);
    let err = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: false }); // <-- no shell
    p.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve(out.toString("utf8"));
      else reject(new Error(`single-file exited ${code}: ${err || "(no stderr)"}`));
    });
  });
}

async function fallbackHtml(file) {
  return `<!doctype html><meta charset="utf-8"><title>${file}</title><h1>Snapshot failed</h1>`;
}

function httpToHttps(u) {
  try {
    if (u.startsWith("//")) return "https:" + u;
    if (u.startsWith("http://")) return "https://" + u.slice(7);
  } catch {}
  return u;
}

async function fetchAsDataURL(u) {
  const url = httpToHttps(u);
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || mimeLookup(url) || "application/octet-stream";
  const b64 = buf.toString("base64");
  return `data:${ct};base64,${b64}`;
}

async function fetchText(u) {
  const url = httpToHttps(u);
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  return await res.text();
}

async function inlineAll(html) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Remove trackers/ads & hints that cause outbound requests
  $('script[src*="doubleclick"],script[src*="googletag"],script[src*="tr.snapchat"],script[src*="stripe"]').remove();
  $('link[rel="preconnect"],link[rel="dns-prefetch"],link[rel="preload"],link[rel="prefetch"]').remove();

  // <link rel="stylesheet" href="..."> -> <style>...</style>
  for (const el of $('link[rel="stylesheet"][href]').toArray()) {
    const href = $(el).attr("href");
    if (!href) continue;
    const cssData = await fetchText(href);
    if (!cssData) continue;
    const inlinedCss = await inlineCssUrls(cssData, href);
    $(el).replaceWith(`<style>${inlinedCss}</style>`);
  }

  // <img src="..."> -> data:
  for (const el of $("img[src]").toArray()) {
    const src = $(el).attr("src");
    if (!src) continue;
    const data = await fetchAsDataURL(src);
    if (data) $(el).attr("src", data);
  }

  // <script src="..."> -> inline content (skip known trackers already removed)
  for (const el of $('script[src]').toArray()) {
    const src = $(el).attr("src");
    if (!src) continue;
    const js = await fetchText(src);
    if (!js) continue;
    $(el).removeAttr("src").text(js);
  }

  // Inline url(...) inside <style> blocks
  for (const el of $("style").toArray()) {
    const css = $(el).html() || "";
    const inlined = await inlineCssUrls(css);
    $(el).html(inlined);
  }

  // Inline style="" url(...) attrs
  for (const el of $("[style]").toArray()) {
    const css = $(el).attr("style");
    const inlined = await inlineCssUrls(css);
    $(el).attr("style", inlined);
  }

  // Upgrade any remaining absolute http:// links to https:// as a last resort
  $('link[href], img[src], script[src]').each((_, el) => {
    const $el = $(el);
    const attr = $el.is("link") ? "href" : "src";
    const val = $el.attr(attr);
    if (val && /^http:\/\//i.test(val)) $el.attr(attr, httpToHttps(val));
  });

  return $.html({ decodeEntities: false });
}

async function inlineCssUrls(css, baseHref = "") {
  if (!css) return css;

  const ast = csstree.parse(css, { parseValue: true, parseRulePrelude: true });
  const tasks = [];

  csstree.walk(ast, (node) => {
    if (node.type === "Url" && node.value) {
      const raw = String(node.value).replace(/^['"]|['"]$/g, "");
      if (raw.startsWith("data:")) return;

      // resolve relative against base (if given)
      let u = raw;
      try {
        if (baseHref && !/^https?:|^data:|^\/\//i.test(raw)) {
          u = new URL(raw, httpToHttps(baseHref)).toString();
        }
      } catch {}

      tasks.push(
        (async () => {
          const dataURL = await fetchAsDataURL(u);
          if (dataURL) node.value = dataURL;
          else node.value = httpToHttps(u); // upgrade to https at minimum
        })()
      );
    }
  });

  await Promise.all(tasks);
  return csstree.generate(ast);
}
