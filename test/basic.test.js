import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { safeId, parseFlacStreamInfo } from "../flac-utils.js";

test("manifest follows BitChord addon contract", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../manifest.json", import.meta.url))
  );

  assert.equal(manifest.id, "id.roxy.flacbridge");
  assert.deepEqual(manifest.resources, ["search", "stream"]);
  assert.equal(manifest.checkValidLossless, 0);
  assert.equal(manifest.settings.find(x => x.key === "quality").options.length, 2);
});

test("server keeps required BitChord routes", () => {
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

  for (const route of ['"/manifest.json"', '"/search"', '"/stream/:id"']) {
    assert.ok(source.includes(route), `Missing route ${route}`);
  }

  assert.ok(source.includes('app.route("/media/:id")'));
  assert.ok(source.includes('.head('));
});

test("safeId accepts the 209-character Archive ID", () => {
  const id = "ia:" + "a".repeat(204) + ":x";
  assert.equal(id.length, 209);
  assert.equal(safeId(id), true);
  assert.equal(safeId("ia:" + "a".repeat(510)), false);
  assert.equal(safeId("invalid/id"), false);
});

test("FLAC parser reads complete 24-bit 44.1 kHz STREAMINFO", () => {
  const buf = Buffer.alloc(42);
  buf.write("fLaC", 0);
  buf[4] = 0x80;
  buf.writeUIntBE(34, 5, 3);

  const sampleRate = 44100;
  const channels = 2;
  const bitDepth = 24;
  const bits = bitDepth - 1;

  buf[18] = sampleRate >> 12;
  buf[19] = sampleRate >> 4;
  buf[20] = ((sampleRate & 0x0f) << 4) |
    ((channels - 1) << 1) | (bits >> 4);
  buf[21] = (bits & 0x0f) << 4;

  assert.deepEqual(parseFlacStreamInfo(buf), {
    sampleRate: 44100,
    bitDepth: 24,
    channels: 2
  });
});

test("FLAC parser rejects incomplete or invalid STREAMINFO", () => {
  const short = Buffer.alloc(41);
  short.write("fLaC");
  assert.equal(parseFlacStreamInfo(short), null);

  const invalid = Buffer.alloc(42);
  invalid.write("NOPE");
  assert.equal(parseFlacStreamInfo(invalid), null);
});
