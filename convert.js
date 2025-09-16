// Converts every *.mhtml / *.mht in the REPO ROOT to a fully self-contained page:
// Step 1: MHTML -> plain HTML          (fast-mhtml2html)  -> always returns a string
// Step 2: Inline all external assets   (SingleFile CLI)    -> data: URIs, zero network calls

import { glob } from "glob";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import m2h from "fast-mhtml2html";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT = path.join(__dirname, "dist");
const WORK = await fs.mkdtemp(path.join(os.tmpdir(), "mhtml-work-"));

await fs.emptyDir(OUT);

// Only repo root (change to "**/*.{mhtml,mht}" if you want subfolders)
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

  // Step 1: convert MHTML -> HTML (string)
  const buf = await fs.readFile(file);
  const html1 = m2h.convert(buf);
  if (typeof html1 !== "string" || !html1.length) {
    throw new Error("fast-mhtml2html did not return an HTML string");
  }
  const tempHtml = path.join(WORK, `${base}.html`);
  await fs.writeFile(tempHtml, html1, "utf8");

  // Step 2: Inline everything with SingleFile
  const singleFileBin = path.join(
    __dirname,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "single-file.cmd" : "single-file"
  );
  const finalDir = path.join(OUT, base);
  const finalHtml = path.join(finalDir, "index.html");
  await fs.mkdirp(finalDir);

  const html2 = await runAndCapture(singleFileBin, [tempHtml, "--dump-content"]);
  await fs.writeFile(finalHtml, html2, "utf8");

  links.push(`<li><a href="./${safe}/">${base}</a></li>`);
  console.log(`✓ ${file} → ${path.relative(__dirname, finalHtml)}`);
}

// Simple landing page
const indexHtml = `<!doctype html>
<meta charset="utf-8">
<title>MHTML builds</title>
<h1>MHTML builds</h1>
<ul>
${links.join("\n")}
</ul>`;
await fs.writeFile(path.join(OUT, "index.html"), indexHtml, "utf8");

// Cleanup (best-effort)
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
