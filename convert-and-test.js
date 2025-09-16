// Offline-exact MHTML → single-file HTML with layout test.
// - NO external requests allowed.
// - Render .mhtml offline, snapshot to single-file HTML (using the browser itself).
// - Re-render the produced HTML offline and pixel-diff against the MHTML render.
// - Fail the build if any external request is attempted or if the diff is above threshold.

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
const DIFF_THRESHOLD = 0.01; // ≤1% pixels may differ (antialias etc.)
const FILE_GLOB = "*.mhtml"; // root only; change to **/*.mhtml if you like

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

  // block any http(s) requests; record attempts
  const externalAttempts = [];
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (/^https?:\/\//i.test(url)) {
      externalAttempts.push(url);
      return req.abort("blockedbyclient");
    }
    req.continue();
  });

  const result = await fn(page, externalAttempts);

  await page.close();

  if (result?.externalAttempts && result.externalAttempts.length) {
    throw new Error(
      `External requests attempted:\n- ${result.externalAttempts.slice(0, 10).join("\n- ")}${result.externalAttempts.length > 10 ? "\n..." : ""}`
    );
  }
  return result;
}

// Use the browser itself to serialize the currently loaded DOM into a single HTML.
// We avoid any network: all resources in the DOM are already loaded from the MHTML container.
async function snapshotSingleFile(page) {
  // Inline <link rel="stylesheet"> by reading CSSOM; inline <img>, <link icon>, etc. as data URLs.
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

    // Inline stylesheets
    for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
      try {
        // If the sheet is loaded, read CSS rules via CSSOM
        const sheet = Array.from(document.styleSheets).find(s => s.ownerNode === link);
        if (sheet && sheet.cssRules) {
          let css = "";
          for (const r of sheet.cssRules) css += r.cssText + "\n";
          const style = document.createElement("style");
          style.textContent = css;
          link.replaceWith(style);
        }
      } catch {
        // cross-origin or unreadable -> drop the link; we are offline-only
        link.remove();
      }
    }

    // Inline <img> and icons if they’re blob: or other internal URLs
    const inlineSrcAttr = async (el, attr) => {
      const src = el.getAttribute(attr);
      if (!src || src.startsWith("data:")) return;
      // Only try to inline if it’s resolvable by fetch() in this offline page (blob:, file:, etc.)
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

    // Inline CSS url() references for stylesheet tags we created above:
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
          // external-looking; we skip it (offline)
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

    // Serialize
    const doc = document.documentElement.cloneNode(true);
    // Drop preconnect/prefetch/preload hints
    for (const n of Array.from(doc.querySelectorAll('link[rel="preconnect"],link[rel="dns-prefetch"],link[rel="preload"],link[rel="prefetch"]'))) n.remove();
    // Remove iframes (they won’t load offline anyway)
    for (const n of Array.from(doc.querySelectorAll("iframe"))) n.remove();

    // Ensure base href doesn’t point anywhere
    const base = doc.querySelector("base");
    if (base) base.setAttribute("href", ".");

    return "<!DOCTYPE html>\n" + doc.outerHTML;
  });

  return html;
}

async function renderAndScreenshot(page, url, outPngPath) {
  await page.goto(url, { waitUntil: "load" }); // offline; only MHTML-embedded resources render
  const png = await page.screenshot({ type: "png" });
  await fs.writeFile(outPngPath, png);
  return PNG.sync.read(png);
}

function diffPNGs(imgA, imgB, outPath) {
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    // Different sizes -> treat as full diff
    const maxW = Math.max(imgA.width, imgB.width);
    const maxH = Math.max(imgA.height, imgB.height);
    const out = new PNG({ width: maxW, height: maxH });
    // (leave out blank; we just fail)
    fs.writeFileSync(outPath, PNG.sync.write(out));
    return { diffPixels: Math.max(maxW * maxH, 1), total: maxW * maxH };
  }
  const { width, height } = imgA;
  const out = new PNG({ width, height });
  const diffPixels = pixelmatch(imgA.data, imgB.data, out.data, width, height, {
    threshold: 0.1,          // anti-alias tolerance
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
  let externalAttempts = [];

  // 1) Render the MHTML OFFLINE and snapshot a single-file HTML from the live DOM
  let htmlSerialized = "";
  await withOfflinePage(async (page, attempts) => {
    const img = await renderAndScreenshot(page, mhtmlUrl, shotMhtmlPath);
    htmlSerialized = await snapshotSingleFile(page); // DOM → one HTML; uses only already loaded resources
    return { externalAttempts: attempts };
  }).catch(async (e) => {
    await fs.writeFile(path.join(workDir, "__error.txt"), String(e.stack || e));
    throw e;
  });

  // 2) Save the serialized HTML
  await fs.writeFile(singleHtmlPath, htmlSerialized, "utf8");

  // 3) Re-render the produced HTML OFFLINE and screenshot
  const htmlUrl = "file://" + singleHtmlPath.replace(/ /g, "%20");
  let imgA, imgB;
  await withOfflinePage(async (page, attempts) => {
    imgB = await renderAndScreenshot(page, htmlUrl, shotHtmlPath);
    return { externalAttempts: attempts };
  });

  // 4) Diff screenshots
  imgA = PNG.sync.read(fs.readFileSync(shotMhtmlPath));
  const { diffPixels, total } = diffPNGs(imgA, imgB, shotDiffPath);
  const diffRatio = diffPixels / total;

  // 5) Report & fail if not matching
  const passed = diffRatio <= DIFF_THRESHOLD;
  await fs.writeFile(
    path.join(workDir, "__report.txt"),
    `externalAttempts: 0\npixelsDifferent: ${diffPixels}\ntotalPixels: ${total}\ndiffRatio: ${diffRatio}\nstatus: ${passed ? "PASS" : "FAIL"}\n`
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
