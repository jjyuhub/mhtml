// convert.js
import { convert } from "mhtml-to-html";
import { glob } from "glob";
import fs from "fs-extra";
import path from "path";

const OUT = "dist";

function pickHtmlFrom(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof result.html === "string") return result.html;
  throw new Error(
    `mhtml-to-html returned unexpected value: ${Object.prototype.toString.call(result)}`
  );
}

await fs.emptyDir(OUT);

// Only root files (no subfolders). Change to "**/*.{mhtml,mht}" to recurse.
const files = await glob("*.{mhtml,mht}", { nocase: true });
if (files.length === 0) {
  console.log("No .mhtml/.mht files found in repo root");
  // still publish an index so Pages stays happy
  await fs.outputFile(
    path.join(OUT, "index.html"),
    "<!doctype html><meta charset=utf-8><title>MHTML builds</title><h1>No files found</h1>"
  );
  process.exit(0);
}

const links = [];

for (const file of files) {
  const buf = await fs.readFile(file);

  // Different versions of mhtml-to-html return different shapes; normalize:
  const raw = await convert(buf);
  const html = pickHtmlFrom(raw);

  const base = path.basename(file).replace(/\.(mhtml|mht)$/i, "");
  const safe = encodeURIComponent(base);

  const dir = path.join(OUT, base);
  await fs.mkdirp(dir);
  await fs.writeFile(path.join(dir, "index.html"), html, "utf8");

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
