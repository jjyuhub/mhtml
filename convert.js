// Converts every *.mhtml / *.mht in the repo ROOT into /dist/<name>/index.html
import { glob } from "glob";
import fs from "fs-extra";
import path from "path";
import m2h from "fast-mhtml2html";

const OUT = "dist";

await fs.emptyDir(OUT);

// Only root files; switch to "**/*.{mhtml,mht}" to recurse
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
  const buf = await fs.readFile(file);
  // fast-mhtml2html returns a STRING of HTML
  const html = m2h.convert(buf);

  const base = path.basename(file).replace(/\.(mhtml|mht)$/i, "");
  const safe = encodeURIComponent(base);

  const dir = path.join(OUT, base);
  await fs.mkdirp(dir);
  await fs.writeFile(path.join(dir, "index.html"), html, "utf8");

  links.push(`<li><a href="./${safe}/">${base}</a></li>`);
  console.log(`✓ ${file} → dist/${base}/index.html`);
}

const indexHtml = `<!doctype html>
<meta charset="utf-8">
<title>MHTML builds</title>
<h1>MHTML builds</h1>
<ul>
${links.join("\n")}
</ul>`;
await fs.writeFile(path.join(OUT, "index.html"), indexHtml, "utf8");
