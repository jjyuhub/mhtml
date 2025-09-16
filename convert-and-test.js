// Offline-exact MHTML → single-file HTML with layout test.
// - NO external requests are allowed (all http(s) aborted).
// - We DO NOT fail the build just because scripts attempted to request them.
// - We snapshot the rendered MHTML DOM into one HTML, re-render it offline,
//   then pixel-diff. Build fails only on layout mismatch beyond threshold.

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import puppeteer from "puppeteer";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = __dirname;
const OUT = path.join(ROOT, "dist");
await fs.emptyDir(OUT);

// config
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };
const DIFF_THRESHOLD = 0.01; // allow ≤1% pixels (antialias)
const FILE_GLOB = "*.mhtml"; // root; change to **/*.mhtml if desired

const files = await glob(FILE_GLOB, { nocase: true, cwd: ROOT });
if (files.length === 0) {
  await fs.outputFile(
    path.join(OUT, "index.html"),
    "<!doctype html><meta charset=utf-8><title>MHTML builds</title><h1>No .mhtml files in repo root</h1>"
  );
  process.exit(0);
}

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--allow-file-access-from-files",
    "--disable-web-security",
    "--no-sandbox"
  ]
});

function absolute(file) {
  return path.join(ROOT, file);
}

async function withOfflinePage(fn) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.setOfflineMode(true);

  // Block any http(s) request; just abort it silently.
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (/^https?:\/\//i.test(url)) return req.abort("blockedbyclient");
    req.continue();
  });

  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

// Serialize the current page into a single HTML using only already-loaded resources.
async function snapshotSingleFile(page) {
  const html = await page.evaluate(async () => {
    const toDataURL = async (url) => {
      try {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const ct = res.headers.get("content-type") || "application/octet-stream";
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        return `data:${ct};base64,${b64}`;
      } catch {
        return null;
      }
    };

    // Inline stylesheets via CSSOM
    for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
      try {
        const sheet = Array.from(document.styleSheets).find(s => s.ownerNode === link);
        if (sheet && sheet.cssRules) {
          let css = "";
          for (const r of sheet.cssRules) css += r.cssText + "\n";
          const style = document.createElement("style");
          style.textContent = css;
          link.replaceWith(style);
        } else {
          // unreadable/cross-origin → drop; we are offline
          link.remove();
        }
      } catch {
        link.remove();
      }
    }

    // Inline <img> and icons when accessible (blob:/file:/data:)
    const inlineSrcAttr = async (el, attr) => {
      const src = el.getAttribute(attr);
      if (!src || src.startsWith("data:")) return;
      if (/^(blob:|data:|file:|chrome-extension:|chrome:|about:)/i.test(src)) {
        const data = await toDataURL(src);
        if (data) el.setAttribute(attr, data);
      }
    };

    for (const img of Array.from(document.images)) {
      await inlineSrcAttr(img, "src");
      if (img.srcset) img.removeAttribute("srcset");
    }
    for (const link of Array.from(document.querySelectorAll('link[rel="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]'))) {
      await inlineSrcAttr(link, "href");
    }

    // Inline url(...) inside any <style> (try to data-embed blob/file)
    const inlineCssUrls = async (styleEl) => {
      const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
      let css = styleEl.textContent || "";
      const parts = [];
      let last = 0, m;
      while ((m = urlRe.exec(css))) {
        parts.push(css.slice(last, m.index));
        last = urlRe.lastIndex;
        const u = m[2];
        if (/^data:/i.test(u)) { parts.push(m[0]); continue; }
        if (!/^(blob:|data:|file:|chrome-extension:|chrome:|about:)/i.test(u)) {
          // external-looking (would be blocked anyway) → leave as-is
          parts.push(`url(${m[1]}${u}${m[1]})`);
          continue;
        }
        const data = await toDataURL(u);
        parts.push(`url(${m[1]}${(data || u)}${m[1]})`);
      }
      parts.push(css.slice(last));
      styleEl.textContent = parts.join("");
    };
    for (const styleEl of Array.from(document.querySelectorAll("style"))) {
      await inlineCssUrls(styleEl);
    }

    // Remove hints/iframes that would try to load externally
    for (const n of Array.from(document.querySelectorAll('link[rel="preconnect"],link[rel="dns-prefetch"],link[rel="preload"],link[rel="prefetch"]'))) n.remove();
    for (const n of Array.from(document.querySelectorAll("iframe"))) n.remove();

    // Neutral base
    const base = document.querySelector("base");
    if (base) base.setAttribute("href", ".");

    const doc = document.documentElement.cloneNode(true);
    return "<!DOCTYPE html>\n" + doc.outerHTML;
  });

  return html;
}

async function renderAndScreenshot(page, url, outPngPath) {
  await page.goto(url, { waitUntil: "load" }); // offline; only embedded resources render
  const png = await page.screenshot({ type: "png" });
  await fs.writeFile(outPngPath, png);
  return PNG.sync.read(png);
}

function diffPNGs(imgA, imgB, outPath) {
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    const maxW = Math.max(imgA.width, imgB.width);
    const maxH = Math.max(imgA.height, imgB.height);
    const out = new PNG({ width: maxW, height: maxH });
    fs.writeFileSync(outPath, PNG.sync.write(out));
    return { diffPixels: Math.max(maxW * maxH, 1), total: maxW * maxH };
  }
  const { width, height } = imgA;
  const out = new PNG({ width, height });
  const diffPixels = pixelmatch(imgA.data, imgB.data, out.data, width, height, {
    threshold: 0.1,
    includeAA: true
  });
  fs.writeFileSync(outPath, PNG.sync.write(out));
  return { diffPixels, total: width * height };
}

const indexLinks = [];

for (const mhtmlRel of files) {
  const base = path.basename(mhtmlRel).replace(/\.mhtml$/i, "");
  const workDir = path.join(OUT, base);
  await fs.mkdirp(workDir);

  const mhtmlAbs = absolute(mhtmlRel);
  const mhtmlUrl = "file://" + mhtmlAbs.replace(/ /g, "%20");
  const singleHtmlPath = path.join(workDir, "index.html");
  const shotMhtmlPath = path.join(workDir, "__mhtml.png");
  const shotHtmlPath = path.join(workDir, "__html.png");
  const shotDiffPath = path.join(workDir, "__diff.png");

  // 1) Render MHTML OFFLINE and snapshot DOM → single HTML
  let htmlSerialized = "";
  await withOfflinePage(async (page) => {
    await renderAndScreenshot(page, mhtmlUrl, shotMhtmlPath);
    htmlSerialized = await snapshotSingleFile(page);
  }).catch(async (e) => {
    await fs.writeFile(path.join(workDir, "__error.txt"), String(e.stack || e));
    throw e;
  });

  // 2) Save single HTML
  await fs.writeFile(singleHtmlPath, htmlSerialized, "utf8");

  // 3) Re-render single HTML OFFLINE and screenshot
  const htmlUrl = "file://" + singleHtmlPath.replace(/ /g, "%20");
  let imgB;
  await withOfflinePage(async (page) => {
    imgB = await renderAndScreenshot(page, htmlUrl, shotHtmlPath);
  });

  // 4) Diff screenshots
  const imgA = PNG.sync.read(fs.readFileSync(shotMhtmlPath));
  const { diffPixels, total } = diffPNGs(imgA, imgB, shotDiffPath);
  const diffRatio = diffPixels / total;

  // 5) Report; fail only on layout mismatch
  const passed = diffRatio <= DIFF_THRESHOLD;
  await fs.writeFile(
    path.join(workDir, "__report.txt"),
    `pixelsDifferent: ${diffPixels}\ntotalPixels: ${total}\ndiffRatio: ${diffRatio}\nstatus: ${passed ? "PASS" : "FAIL"}\n`
  );
  if (!passed) {
    throw new Error(
      `[${base}] layout changed too much offline: ${(diffRatio * 100).toFixed(2)}% ` +
      `(see ${path.relative(ROOT, shotMhtmlPath)}, ${path.relative(ROOT, shotHtmlPath)}, ${path.relative(ROOT, shotDiffPath)})`
    );
  }

  indexLinks.push(`<li><a href="./${encodeURIComponent(base)}/">✅ ${base}</a></li>`);
  console.log(`✓ ${base} PASS (${(diffRatio * 100).toFixed(2)}% diff)`);
}

// index page
await fs.writeFile(
  path.join(OUT, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>MHTML builds</title><h1>MHTML builds (offline-verified)</h1><ul>${indexLinks.join("\n")}</ul>`,
  "utf8"
);

await browser.close();
console.log("Done.");
