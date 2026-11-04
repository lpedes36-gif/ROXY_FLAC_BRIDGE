import fs from "node:fs";

const file = "server.js";
let s = fs.readFileSync(file, "utf8");

function replaceRegex(regex, replacement, label) {
  const matches = s.match(regex);
  if (!matches || matches.length !== 1) {
    throw new Error(`${label}: blok tidak ditemukan atau tidak unik`);
  }
  s = s.replace(regex, replacement);
  console.log("OK:", label);
}

// 1. Import utilitas FLAC
if (!s.includes('from "./flac-utils.js"')) {
  const anchor = 'import { parseFile } from "music-metadata";';
  if (!s.includes(anchor)) throw new Error("Import music-metadata tidak ditemukan");
  s = s.replace(
    anchor,
    anchor + '\nimport { safeId, parseFlacStreamInfo } from "./flac-utils.js";'
  );
}
console.log("OK: import flac-utils");

// 2. Hapus safeId versi lama
replaceRegex(
  /^function safeId\(value\) \{\s*return \/\^\[a-zA-Z0-9\._:-\]\{1,512\}\$\/\.test\(value\);\s*\}\s*/m,
  "",
  "hapus safeId lama"
);

// 3. Ganti resolver Archive.org dan hapus parser lama
const resolveBlock = `async function resolveArchive(track) {
  const meta = await fetchIAJson(\`\${IA_API}/metadata/\${encodeURIComponent(track.identifier)}\`);
  const file = (meta?.files || []).find(f => f.name === track.filename);
  if (!file) return null;

  const encodedPath = track.filename.split("/").map(encodeURIComponent).join("/");
  const url = "https://archive.org/download/" +
    encodeURIComponent(track.identifier) + "/" + encodedPath;

  const probe = await fetch(url, {
    headers: { Range: "bytes=0-41", "User-Agent": "ROXY-FLAC-BRIDGE/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });

  if (!probe.ok || !probe.body) return null;

  const reader = probe.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < 42) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = 42 - total;
      chunks.push(chunk.subarray(0, remaining));
      total += Math.min(chunk.length, remaining);
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }

  const bytes = Buffer.concat(chunks);
  const info = parseFlacStreamInfo(bytes);
  if (!info) return null;

  return {
    url: probe.url || url,
    ...info,
    size: Number(file.size || 0)
  };
}
`;

replaceRegex(
  /async function resolveArchive\(track\) \{[\s\S]*?\nfunction streamInfo\(track, resolved\) \{/,
  resolveBlock + "function streamInfo(track, resolved) {",
  "resolver Archive.org dan parser lama"
);

// 4. Label kualitas pencarian dibuat netral
replaceRegex(
  /audioQuality: quality === "hires" \? "Hi-Res FLAC \(verified on resolve\)" : "FLAC Lossless \(verified on resolve\)"/,
  'audioQuality: "FLAC (quality verified when resolved)"',
  "label kualitas pencarian"
);

// 5. Ganti route media dengan GET + HEAD dan dukungan suffix Range
const mediaBlock = `async function serveLocalMedia(req, res) {
  const track = trackCache.get(String(req.params.id || ""));
  if (!track || track.source !== "local") return res.sendStatus(404);

  try {
    const stat = await fs.promises.stat(track.filePath);
    if (!stat.isFile()) return res.sendStatus(404);

    res.set("Accept-Ranges", "bytes");
    res.type("audio/flac");

    const range = req.headers.range;
    if (!range) {
      res.set("Content-Length", String(stat.size));
      if (req.method === "HEAD") return res.status(200).end();
      await pipe(fs.createReadStream(track.filePath), res);
      return;
    }

    const match = /^bytes=(\\d*)-(\\d*)$/.exec(range);
    if (!match || stat.size === 0) {
      res.set("Content-Range", \`bytes */\${stat.size}\`);
      return res.status(416).end();
    }

    let start;
    let end;

    if (match[1] === "") {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        res.set("Content-Range", \`bytes */\${stat.size}\`);
        return res.status(416).end();
      }
      start = Math.max(stat.size - suffixLength, 0);
      end = stat.size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === "" ? stat.size - 1 : Number(match[2]);

      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || start >= stat.size || start > end) {
        res.set("Content-Range", \`bytes */\${stat.size}\`);
        return res.status(416).end();
      }
      end = Math.min(end, stat.size - 1);
    }

    const length = end - start + 1;
    res.status(206).set({
      "Content-Range": \`bytes \${start}-\${end}/\${stat.size}\`,
      "Content-Length": String(length)
    });

    if (req.method === "HEAD") return res.end();

    await pipe(
      fs.createReadStream(track.filePath, { start, end }),
      res
    );
  } catch (error) {
    console.error("Local media error:", error.message);
    if (res.headersSent) return res.destroy(error);
    return res.sendStatus(404);
  }
}

app.route("/media/:id")
  .get(serveLocalMedia)
  .head(serveLocalMedia);

`;

replaceRegex(
  /app\.get\("\/media\/:id", async \(req, res\) => \{[\s\S]*?\n\}\);\s*(?=app\.get\("\/artwork\/:id")/,
  mediaBlock,
  "route media GET/HEAD"
);

fs.writeFileSync(file, s);
console.log("\\nPatch selesai ditulis ke server.js");
