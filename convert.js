// Converts every *.mhtml / *.mht in the REPO ROOT to a fully self-contained page:
// 1) mhtml -> html (resolves cid: parts)
// 2) run SingleFile CLI to inline ALL external assets into data URIs

import { glob } from "glob";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { convert as mhtmlToHtml } from "mhtml-to-html";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT = path.join(__dirname, "dist");
const WORK = await fs.mkdtemp(path.join(os.tmpdir(), "mhtml-work-"));

await fs.emptyDir(OUT);

// Only look in repo root (change to "**/*.{mhtml,mht}" if you need recursion)
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
  const tempHtml = path.join(WORK, `${base}.html`);

  // Step 1: MHTML -> basic HTML (returns { html, ... } in v2)
  const result = await mhtmlToHtml(await fs.readFile(file));
  const html1 = typeof result === "string" ? result : result?.html;
  if (typeof html1 !== "string") {
    throw new Error("mhtml-to-html did not return HTML string");
  }
  await fs.writeFile(tempHtml, html1, "utf8");

  // Step 2: Run SingleFile CLI to inline ALL external assets into data URIs
  // We call the local binary from node_modules/.bin to avoid npx variability.
  const singleFileBin = path.join(__dirname, "node_modules", ".bin", process.platform === "win32" ? "single-file.cmd" : "single-file");
  const finalDir = path.join(OUT, base);
  const finalHtml = path.join(finalDir, "index.html");
  await fs.mkdirp(finalDir);

  const sfArgs = [
    tempHtml,
    // dump to stdout so we can capture and write exact path
    "--dump-content"
  ];

  const html2 = await runAndCapture(singleFileBin, sfArgs);
  await fs.writeFile(finalHtml, html2, "utf8");

  links.push(`<li><a href="./${safe}/">${base}</a></li>`);
  console.log(`✓ ${file} → ${path.relative(__dirname, finalHtml)}`);
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

// Cleanup temp work dir (best-effort)
try { await fs.rm(WORK, { recursive: true, force: true }); } catch {}

function runAndCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    let out = Buffer.alloc(0);
    let err = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve(out.toString("utf8"));
      else reject(new Error(`single-file failed (${code}): ${err}`));
    });
  });
}
