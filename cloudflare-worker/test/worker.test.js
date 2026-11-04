import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("health endpoint returns ok", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/healthz")
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    addon: "ROXY FLAC BRIDGE",
    version: "1.0.0"
  });
});

test("manifest follows BitChord addon contract", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/manifest.json")
  );

  const manifest = await response.json();

  assert.equal(response.status, 200);
  assert.equal(manifest.id, "id.roxy.flacbridge");
  assert.deepEqual(manifest.resources, ["search", "stream"]);
});

test("empty search returns no tracks", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/search")
  );

  assert.deepEqual(await response.json(), { tracks: [] });
});

test("invalid stream ID is rejected", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/stream/not-valid")
  );

  assert.equal(response.status, 400);
});
