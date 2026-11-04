import express from "express";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";
import { safeId, parseFlacStreamInfo } from "./flac-utils.js";

const pipe = promisify(pipeline);
const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 3000);
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || "./music");
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const IA_API = "https://archive.org";
const searchCache = new Map();
const trackCache = new Map();

const manifest = {
  id: "id.roxy.flacbridge",
  name: "ROXY FLAC BRIDGE",
  version: "1.0.0",
  description: "Legal FLAC catalogue bridge: Internet Archive + local FLAC library.",
  resources: ["search", "stream"],
  allowDownloads: 1,
  // Keep 0: users may listen through Bluetooth; this does not promise lossless output.
  checkValidLossless: 0,
  settings: [{
    key: "quality",
    type: "select",
    label: "Audio quality",
    default: "hires",
    options: [
      { value: "hires", label: "Hi-Res FLAC (up to 24-bit; only when available)" },
      { value: "lossless", label: "FLAC Lossless (16-bit/CD or better)" }
    ]
  }]
};

function json(res, data, status = 200) {
  res.status(status).set("Cache-Control", "no-store").json(data);
}
function cleanText(value, fallback = "Unknown") {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function absUrl(req, route) {
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${route}` : `${req.protocol}://${req.get("host")}${route}`;
}
function chooseFlacFile(files, quality) {
  const candidates = (files || []).filter(f =>
    typeof f.name === "string" &&
    f.name.toLowerCase().endsWith(".flac") &&
    f.source !== "metadata" &&
    f.private !== "true"
  );
  if (!candidates.length) return null;
  // IA metadata sometimes includes bit depth/sample rate. Prefer larger FLAC for hires,
  // but never infer bit depth from file size or label it as 24-bit without a probe.
  candidates.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
  return candidates[0];
}
async function fetchIAJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "ROXY-FLAC-BRIDGE/1.0 (BitChord addon)" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Internet Archive HTTP ${response.status}`);
  return response.json();
}
async function archiveSearch(query, quality) {
  const cacheKey = `${query.toLowerCase()}|${quality}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 5 * 60_000) return cached.items;

  const words = query.normalize("NFKC").split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).slice(0, 8);
  if (!words.length) return [];
  const q = `(${words.map(w => `title:${w}`).join(" AND ")}) AND mediatype:audio`;
  const url = new URL(`${IA_API}/advancedsearch.php`);
  url.searchParams.set("q", q);
  url.searchParams.set("fl[]", "identifier,title,creator,album,year");
  url.searchParams.set("rows", "12");
  url.searchParams.set("page", "1");
  url.searchParams.set("output", "json");
  const data = await fetchIAJson(url);
  const docs = data?.response?.docs || [];

  const items = [];
  for (const doc of docs) {
    if (!doc.identifier) continue;
    try {
      const meta = await fetchIAJson(`${IA_API}/metadata/${encodeURIComponent(doc.identifier)}`);
      const file = chooseFlacFile(meta?.files, quality);
      if (!file) continue;
      const identifier = doc.identifier;
      const id = `ia:${identifier}:${Buffer.from(file.name).toString("base64url")}`;
      const track = {
        id,
        source: "ia",
        identifier,
        filename: file.name,
        title: cleanText(doc.title, path.basename(file.name, ".flac")),
        artist: cleanText(doc.creator, "Internet Archive"),
        album: cleanText(doc.album, "Internet Archive"),
        duration: Number(file.length || 0) || undefined,
        artworkURL: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
        format: "flac",
        audioQuality: "FLAC (quality verified when resolved)"
      };
      trackCache.set(id, track);
      items.push(track);
    } catch {
      // Skip an unavailable/broken archive item rather than returning a fake stream.
    }
  }
  searchCache.set(cacheKey, { time: Date.now(), items });
  return items;
}
async function localSearch(query) {
  let names = [];
  try { names = await fs.promises.readdir(MUSIC_DIR, { recursive: true, withFileTypes: true }); }
  catch { return []; }
  const q = query.toLowerCase();
  const results = [];
  for (const entry of names) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".flac")) continue;
    const full = path.resolve(MUSIC_DIR, entry.parentPath || "", entry.name);
    if (!full.startsWith(MUSIC_DIR + path.sep)) continue;
    try {
      const meta = await parseFile(full);
      const common = meta.common || {};
      const title = cleanText(common.title, path.basename(entry.name, ".flac"));
      const artist = cleanText(common.artist, "Unknown artist");
      const album = cleanText(common.album, "Unknown album");
      const haystack = `${title} ${artist} ${album}`.toLowerCase();
      if (!haystack.includes(q)) continue;
      const id = `local:${Buffer.from(path.relative(MUSIC_DIR, full)).toString("base64url")}`;
      const pic = common.picture?.[0];
      const artworkURL = (pic && PUBLIC_BASE_URL) ? `${PUBLIC_BASE_URL}/artwork/${encodeURIComponent(id)}` : undefined;
      const track = {
        id, source: "local", filePath: full, title, artist, album,
        duration: meta.format.duration,
        artworkURL,
        format: "flac",
        audioQuality: `${meta.format.bitsPerSample || "?"}-bit FLAC`
      };
      trackCache.set(id, track);
      results.push(track);
    } catch {}
  }
  return results.slice(0, 12);
}
function publicTrack(track) {
  const { filePath, filename, identifier, source, ...row } = track;
  return row;
}
async function resolveArchive(track) {
  const meta = await fetchIAJson(`${IA_API}/metadata/${encodeURIComponent(track.identifier)}`);
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
function streamInfo(track, resolved) {
  const sampleRate = resolved.sampleRate;
  const bitDepth = resolved.bitDepth;
  const label = `${bitDepth}-bit / ${Math.round(sampleRate / 100) / 10} kHz FLAC`;
  return {
    url: resolved.url,
    format: "flac",
    quality: label,
    codec: "flac",
    container: "flac",
    manifest: "none",
    encrypted: false,
    sampleRate,
    bitDepth
  };
}

app.get("/", (_req, res) => json(res, { addon: manifest.name, version: manifest.version, status: "ok", manifest: "/manifest.json" }));
app.get("/healthz", (_req, res) => json(res, { status: "ok" }));
app.get("/manifest.json", (_req, res) => json(res, manifest));

app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 160);
  if (!q) return json(res, { tracks: [] });
  const quality = String(req.query.quality || "hires").toLowerCase();
  try {
    const [local, archive] = await Promise.all([
      localSearch(q),
      archiveSearch(q, quality)
    ]);
    const tracks = [...local, ...archive].slice(0, 20);
    return json(res, { tracks: tracks.map(publicTrack) });
  } catch (error) {
    console.error("Search error:", error.message);
    // Local results remain useful if the upstream catalogue is down.
    const local = await localSearch(q);
    return json(res, { tracks: local.map(publicTrack), warning: "Internet Archive temporarily unavailable" });
  }
});

app.get("/stream/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!safeId(id)) return json(res, { error: "Invalid track id" }, 400);
  const track = trackCache.get(id);
  if (!track) return json(res, { error: "Track not found; search again" }, 404);

  try {
    if (track.source === "ia") {
      const resolved = await resolveArchive(track);
      if (!resolved) return json(res, { error: "No valid FLAC stream found" }, 404);
      return json(res, streamInfo(track, resolved));
    }
    if (track.source === "local") {
      const meta = await parseFile(track.filePath);
      const stat = await fs.promises.stat(track.filePath);
      const url = absUrl(req, `/media/${encodeURIComponent(id)}`);
      return json(res, {
        url, format: "flac", quality: `${meta.format.bitsPerSample || "?"}-bit / ${meta.format.sampleRate || "?"} Hz FLAC`,
        codec: "flac", container: "flac", manifest: "none", encrypted: false,
        ...(meta.format.sampleRate ? { sampleRate: meta.format.sampleRate } : {}),
        ...(meta.format.bitsPerSample ? { bitDepth: meta.format.bitsPerSample } : {}),
        bitrate: meta.format.bitrate,
        size: stat.size
      });
    }
    return json(res, { error: "Unsupported source" }, 404);
  } catch (error) {
    console.error("Stream resolve error:", error.message);
    return json(res, { error: "Unable to resolve stream" }, 502);
  }
});

async function serveLocalMedia(req, res) {
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

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || stat.size === 0) {
      res.set("Content-Range", `bytes */${stat.size}`);
      return res.status(416).end();
    }

    let start;
    let end;

    if (match[1] === "") {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        res.set("Content-Range", `bytes */${stat.size}`);
        return res.status(416).end();
      }
      start = Math.max(stat.size - suffixLength, 0);
      end = stat.size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === "" ? stat.size - 1 : Number(match[2]);

      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || start >= stat.size || start > end) {
        res.set("Content-Range", `bytes */${stat.size}`);
        return res.status(416).end();
      }
      end = Math.min(end, stat.size - 1);
    }

    const length = end - start + 1;
    res.status(206).set({
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
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

app.get("/artwork/:id", async (req, res) => {
  const track = trackCache.get(String(req.params.id || ""));
  if (!track || track.source !== "local") return res.sendStatus(404);
  try {
    const meta = await parseFile(track.filePath);
    const pic = meta.common.picture?.[0];
    if (!pic) return res.sendStatus(404);
    res.type(pic.format || "application/octet-stream").send(Buffer.from(pic.data));
  } catch { return res.sendStatus(404); }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err.message);
  if (!res.headersSent) json(res, { error: "Internal server error" }, 500);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ROXY FLAC BRIDGE listening on ${PORT}`);
  console.log(`Local FLAC directory: ${MUSIC_DIR}`);
  if (!PUBLIC_BASE_URL) console.log("PUBLIC_BASE_URL not set; local URL is used for local-library streams.");
});
