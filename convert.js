import { convert } from "mhtml-to-html";
import { glob } from "glob";
import fs from "fs-extra";
import path from "path";

const OUT = "dist";

// clean output
await fs.emptyDir(OUT);

// find .mhtml/.mht in the repo root only (not subfolders)
const files = await glob("*.{mhtml,mht}", { nocase: true });
if (files.length === 0) {
  console.log("No .mhtml/.mht files found in repo root");
  process.exit(0);
}

const links = [];
for (const file of files) {
  const buf = await fs.readFile(file);
  const html = await convert(buf); // single-file HTML string

  const base = path.basename(file).replace(/\.(mhtml|mht)$/i, "");
  const dir = path.join(OUT, base);
  await fs.mkdirp(dir);
  await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
  links.push(`<li><a href="./${encodeURIComponent(base)}/">${base}</a></li>`);
  console.log(`✓ ${file} → dist/${base}/index.html`);
}

// optional index page listing all converted files
const indexHtml = `<!doctype html><meta charset="utf-8">
<title>MHTML builds</title><h1>MHTML builds</h1><ul>${links.join("\n")}</ul>`;
await fs.writeFile(path.join(OUT, "index.html"), indexHtml, "utf8");
