export function safeId(value) {
  return typeof value === "string" &&
    /^[a-zA-Z0-9._:-]{1,512}$/.test(value);
}

export function parseFlacStreamInfo(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);

  // 4-byte marker + 4-byte metadata header + 34-byte STREAMINFO
  if (buf.length < 42) return null;
  if (buf.subarray(0, 4).toString() !== "fLaC") return null;

  const blockType = buf[4] & 0x7f;
  const blockLength = buf.readUIntBE(5, 3);

  if (blockType !== 0 || blockLength !== 34) return null;

  const b0 = buf[18];
  const b1 = buf[19];
  const b2 = buf[20];
  const b3 = buf[21];

  const sampleRate =
    (b0 * 4096) + (b1 * 16) + (b2 >> 4);

  const channels = ((b2 >> 1) & 0x07) + 1;

  const bitDepth =
    (((b2 & 0x01) << 4) | (b3 >> 4)) + 1;

  if (sampleRate < 1 || sampleRate > 655350) return null;
  if (channels < 1 || channels > 8) return null;
  if (bitDepth < 4 || bitDepth > 32) return null;

  return { sampleRate, bitDepth, channels };
}
