# ROXY FLAC BRIDGE

BitChord addon server for **legally accessible FLAC audio** from:
- Internet Archive audio items that expose a `.flac` file.
- A local FLAC folder (useful for testing/self-hosting; cloud free hosts generally do not preserve uploaded local files).

It does **not** convert MP3/AAC/YouTube audio into FLAC, bypass DRM, or claim every result is 24-bit. Bit depth and sample rate are read from the FLAC STREAMINFO block before an Archive stream is returned.

## Requirements
- Node.js 20+
- Internet access for Internet Archive search
- For local library: put FLAC files in `music/` or set `MUSIC_DIR`

## Run on Termux
```sh
pkg update && pkg upgrade -y
pkg install nodejs-lts git -y
mkdir -p ~/projects
cd ~/projects
# Copy/extract this project here as ROXY_FLAC_BRIDGE
cd ROXY_FLAC_BRIDGE
npm install
npm test
npm start
```
Then, on the same phone:
```sh
curl http://127.0.0.1:3000/manifest.json
curl 'http://127.0.0.1:3000/search?q=beethoven&quality=hires'
```
Local testing uses HTTP localhost. BitChord remote addon registration normally requires a publicly reachable HTTPS server.

## Add your own FLAC files
Copy only files you own or are licensed to host:
```sh
mkdir -p music
cp /path/to/your-file.flac music/
```
The local folder is indexed during search. Local streams support HTTP byte ranges for seeking. The server must remain running while you play them. For cloud hosting, set `PUBLIC_BASE_URL` so local artwork URLs can be absolute; for a free ephemeral host, local uploaded files will not persist.

## Free public hosting (Render)
1. Create a GitHub repository and upload this project.
2. Create a free Web Service on Render, connect the repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variable `PUBLIC_BASE_URL=https://YOUR-SERVICE.onrender.com`
6. Deploy. Free instances may sleep when idle and may have cold starts. Local files on ephemeral hosting are not persistent; use Internet Archive results there, or a persistent storage/server you control.
7. Check `https://YOUR-SERVICE.onrender.com/manifest.json`.

Do not place private API keys in source code. Do not host copyrighted files without permission.

## Add to BitChord
BitChord → Settings → Sources → Add addon. Paste:
`https://YOUR-SERVICE.onrender.com/manifest.json`

## Endpoints
- `GET /manifest.json`
- `GET /search?q=...&quality=hires|lossless&atmos=auto`
- `GET /stream/:id?quality=...&atmos=auto`
- `GET /healthz`

## Quality / Dolby notes
- `hires` and `lossless` are preferences. Internet Archive results are returned only if an actual FLAC file is present.
- The stream endpoint probes the FLAC header and reports its actual sample rate and bit depth.
- This first version does not invent Dolby Atmos tracks. It returns stereo FLAC unless a future provider adapter can verify an unencrypted E-AC-3 JOC/DASH Atmos asset. Atmos is not lossless.
- BitChord's Bluetooth output gate is deliberately disabled (`checkValidLossless: 0`), so the addon remains callable with Bluetooth. A Bluetooth codec may still be lossy.

## Test
```sh
npm test
npm start
```
In another Termux session:
```sh
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/manifest.json
curl -fsS 'http://127.0.0.1:3000/search?q=beethoven&quality=hires'
```
A successful local health check does not prove that every upstream item will play; test a returned track's `/stream/<id>` and then test playback in BitChord.
