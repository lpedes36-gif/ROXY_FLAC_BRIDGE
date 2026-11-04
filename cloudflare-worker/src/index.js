const IA_API = "https://archive.org";

const manifest = {
  id: "id.roxy.flacbridge",
  name: "ROXY FLAC BRIDGE",
  version: "1.0.0",
  description: "Internet Archive FLAC catalogue bridge.",
  resources: ["search", "stream"],
  allowDownloads: 1,
  checkValidLossless: 0,
  settings: [{
    key: "quality",
    type: "select",
    label: "Audio quality",
    default: "hires",
    options: [
      {
        value: "hires",
        label: "Hi-Res FLAC (up to 24-bit; only when available)"
      },
      {
        value: "lossless",
        label: "FLAC Lossless (16-bit/CD or better)"
      }
    ]
  }]
};

const searchCache = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range"
    }
  });
}

function cleanText(value, fallback = "Unknown") {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  try {
    let base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";

    const binary = atob(base64);
    const bytes = Uint8Array.from(
      binary,
      character => character.charCodeAt(0)
    );

    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseTrackId(id) {
  if (
    typeof id !== "string" ||
    id.length > 512 ||
    !/^[a-zA-Z0-9._:-]+$/.test(id)
  ) return null;

  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== "ia") return null;

  const identifier = parts[1];
  const filename = decodeBase64Url(parts[2]);

  if (
    !/^[a-zA-Z0-9._-]+$/.test(identifier) ||
    !filename ||
    filename.startsWith("/") ||
    filename.split("/").includes("..") ||
    !filename.toLowerCase().endsWith(".flac")
  ) return null;

  return { identifier, filename };
}

function parseFlacStreamInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 42) {
    return null;
  }

  if (
    bytes[0] !== 0x66 ||
    bytes[1] !== 0x4c ||
    bytes[2] !== 0x61 ||
    bytes[3] !== 0x43
  ) return null;

  const blockType = bytes[4] & 0x7f;
  const blockLength =
    (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];

  if (blockType !== 0 || blockLength !== 34) return null;

  const b0 = bytes[18];
  const b1 = bytes[19];
  const b2 = bytes[20];
  const b3 = bytes[21];

  const sampleRate = b0 * 4096 + b1 * 16 + (b2 >> 4);
  const channels = ((b2 >> 1) & 7) + 1;
  const bitDepth = (((b2 & 1) << 4) | (b3 >> 4)) + 1;

  if (
    sampleRate < 1 ||
    sampleRate > 655350 ||
    channels < 1 ||
    channels > 8 ||
    bitDepth < 4 ||
    bitDepth > 32
  ) return null;

  return { sampleRate, bitDepth, channels };
}

async function fetchIAJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ROXY-FLAC-BRIDGE/1.0"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(`Internet Archive HTTP ${response.status}`);
  }

  return response.json();
}

function chooseFlacFile(files, quality) {
  const candidates = (files || []).filter(file =>
    typeof file.name === "string" &&
    file.name.toLowerCase().endsWith(".flac") &&
    file.source !== "metadata" &&
    file.private !== "true"
  );

  candidates.sort(
    (a, b) => Number(b.size || 0) - Number(a.size || 0)
  );

  return candidates[0] || null;
}

async function archiveSearch(query, quality) {
  const cacheKey = `${query.toLowerCase()}|${quality}`;
  const cached = searchCache.get(cacheKey);

  if (cached && Date.now() - cached.time < 300000) {
    return cached.items;
  }

  const words = query
    .normalize("NFKC")
    .split(/\s+/)
    .map(word => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .slice(0, 8);

  if (!words.length) return [];

  const searchQuery =
    `(${words.map(word => `title:${word}`).join(" AND ")}) AND mediatype:audio`;

  const url = new URL(`${IA_API}/advancedsearch.php`);
  url.searchParams.set("q", searchQuery);
  url.searchParams.set(
    "fl[]",
    "identifier,title,creator,album,year"
  );
  url.searchParams.set("rows", "12");
  url.searchParams.set("page", "1");
  url.searchParams.set("output", "json");

  const data = await fetchIAJson(url);
  const docs = data?.response?.docs || [];
  const items = [];

  for (const doc of docs) {
    if (
      !doc.identifier ||
      !/^[a-zA-Z0-9._-]+$/.test(doc.identifier)
    ) continue;

    try {
      const metadata = await fetchIAJson(
        `${IA_API}/metadata/${encodeURIComponent(doc.identifier)}`
      );

      const file = chooseFlacFile(metadata?.files, quality);
      if (!file) continue;

      const id =
        `ia:${doc.identifier}:${encodeBase64Url(file.name)}`;

      items.push({
        id,
        title: cleanText(
          doc.title,
          file.name.split("/").pop().replace(/\.flac$/i, "")
        ),
        artist: cleanText(doc.creator, "Internet Archive"),
        album: cleanText(doc.album, "Internet Archive"),
        ...(Number(file.length) > 0
          ? { duration: Number(file.length) }
          : {}),
        artworkURL:
          `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
        format: "flac",
        audioQuality: "FLAC (quality verified when resolved)"
      });
    } catch {
      // Lewati item Archive yang tidak tersedia.
    }
  }

  searchCache.set(cacheKey, {
    time: Date.now(),
    items
  });

  return items;
}

async function resolveArchive(track) {
  const metadata = await fetchIAJson(
    `${IA_API}/metadata/${encodeURIComponent(track.identifier)}`
  );

  const file = (metadata?.files || []).find(
    item => item.name === track.filename
  );

  if (!file) return null;

  const encodedPath = track.filename
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const url =
    `${IA_API}/download/${encodeURIComponent(track.identifier)}/${encodedPath}`;

  const probe = await fetch(url, {
    headers: {
      Range: "bytes=0-41",
      "User-Agent": "ROXY-FLAC-BRIDGE/1.0"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });

  if (!probe.ok || !probe.body) return null;

  const reader = probe.body.getReader();
  const bytes = new Uint8Array(42);
  let total = 0;

  try {
    while (total < 42) {
      const { done, value } = await reader.read();
      if (done) break;

      const amount = Math.min(value.length, 42 - total);
      bytes.set(value.subarray(0, amount), total);
      total += amount;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  if (total < 42) return null;

  const info = parseFlacStreamInfo(bytes);
  if (!info) return null;

  return {
    url: probe.url || url,
    ...info,
    size: Number(file.size || 0)
  };
}

function streamInfo(resolved) {
  const { sampleRate, bitDepth } = resolved;
  const label =
    `${bitDepth}-bit / ${Math.round(sampleRate / 100) / 10} kHz FLAC`;

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

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range"
      }
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (path === "/" || path === "/healthz") {
    return json({
      status: "ok",
      addon: manifest.name,
      version: manifest.version
    });
  }

  if (path === "/manifest.json") {
    return json(manifest);
  }

  if (path === "/search") {
    const query = (url.searchParams.get("q") || "")
      .trim()
      .slice(0, 160);

    if (!query) return json({ tracks: [] });

    const quality = (
      url.searchParams.get("quality") || "hires"
    ).toLowerCase();

    try {
      const tracks = await archiveSearch(query, quality);
      return json({ tracks: tracks.slice(0, 20) });
    } catch (error) {
      return json({
        tracks: [],
        warning: "Internet Archive temporarily unavailable"
      }, 502);
    }
  }

  const streamMatch = path.match(/^\/stream\/([^/]+)$/);

  if (streamMatch) {
    let id;

    try {
      id = decodeURIComponent(streamMatch[1]);
    } catch {
      return json({ error: "Invalid track ID" }, 400);
    }

    const track = parseTrackId(id);
    if (!track) {
      return json({ error: "Invalid track ID" }, 400);
    }

    try {
      const resolved = await resolveArchive(track);

      if (!resolved) {
        return json({
          error: "No valid FLAC stream found"
        }, 404);
      }

      return json(streamInfo(resolved));
    } catch {
      return json({
        error: "Unable to resolve stream"
      }, 502);
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request) {
    try {
      return await handleRequest(request);
    } catch {
      return json({ error: "Internal server error" }, 500);
    }
  }
};
