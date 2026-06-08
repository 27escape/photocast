# PhotoCast

PhotoCast serves local photo albums over HTTP and streams them to a Chromecast. It also provides a small web UI and can serve a Progressive Web App (PWA) website (manifest, service worker, icons) from a website folder.

**What it does**

- Serves a web UI that lists photo albums defined in a YAML file and lets you view/step through photos.
- Processes raw or camera files into web-friendly JPEGs and caches them under `/tmp/<USER>/photocast`.
- Streams images to Chromecast devices using `castv2` protocol.
- Can serve a PWA website (manifest.webmanifest, `sw.js`, `icons/`) from a website folder so you can "Add to Home Screen" on Android/iOS/desktop.

**Prerequisites**

- Deno (tested with latest stable) — run commands with `deno run -A`.
- Image processing tools used by the project (on macOS/Linux): `magick` (ImageMagick), `exiftool`. Optional helpers: `dcraw`/`dcraw_emu`, `sips` on macOS.
- Network access to your Chromecast on port `8009`.

**Quick start**

1. Put your website files in a `website/` folder alongside the repo (or point `--website` to another folder). The site should contain an HTML entry (e.g. `index.html` or `photocast.html`), `manifest.webmanifest`, `sw.js`, and an `icons/` folder.
2. Run:

```bash
deno run -A photocast.ts --website ./website --port 8080
```

3. Open `http://localhost:8080` in your browser (or `http://<host>:8080`).

**CLI options**

- `-i, --ip <string>`: Cast IP (default: `192.168.0.216`). Used as default target for manual cast connection.
- `-p, --port <number>`: Local server port (default: `8080`).
- `-y, --yaml <string>`: Path to trips YAML (default: `./trips.yml`). See YAML example below.
- `-v, --verbose`: Enable debug logging.
- `-s, --search <string>`: Initial search for a trip name on startup.
- `--headless`: Run in background/daemon mode.
- `-c, --clear-cache`: Wipe the generated cache (keeps saved settings if possible).
- `--website <string>`: Path to website folder or HTML entry file (default: `./website`). The server will serve `manifest.webmanifest`, `sw.js`, `icons/*` and the HTML entry from this path.

**Website folder layout**

Place the PWA assets in a folder such as `website/`:

```
website/
  index.html             # or photocast.html (entry page)
  manifest.webmanifest
  sw.js
  icons/
    icon-192.png
    icon-512.png
    apple-touch-icon.png
```

Notes:
- The server will look for `index.html`, then `photocast.html`, then any `.html` file when `--website` points at a directory. If `--website` is a file, that file is used as the entry.
- `manifest.webmanifest` should reference icons with paths relative to the site root (for example `/icons/icon-192.png`).

**YAML trips file (trips.yml) example**

```yaml
target: /path/to/photo/root
trips:
  - name: Holiday2024
    start: 2024-03-01
  - name: FamilyTrip
    start: 2023-11-01
```

- `target` should be the root folder containing per-year/per-trip subfolders.

**Runtime & cache**

- Generated cached JPEGs and status image are stored under `/tmp/<USER>/photocast` (where `<USER>` is your environment user). Settings are kept in `settings.json` in that folder.
- The server watches the website entry HTML file and broadcasts a `RELOAD` message to connected clients when the HTML file changes.

**PWA / Install notes**

- For Android/Chrome/desktop: ensure `manifest.webmanifest` and `sw.js` are served over HTTP(S). Browsers require HTTPS for service workers and proper installability (localhost is allowed for local dev).
- For iOS/Safari: iOS ignores the manifest for splash screens; include `apple-touch-icon` and meta tags in your HTML head.

**Examples**

Start server with a specific website folder and port:

```bash
deno run -A photocast.ts --website ./website -p 8080
```

Run headless (background) mode:

```bash
deno run -A photocast.ts --website ./website --headless
```

Clear generated cache then start:

```bash
deno run -A photocast.ts --clear-cache --website ./website
```

**Troubleshooting**

- If images are missing, ensure `magick`, `libraw` and `exiftool` are installed and in your `PATH`.
- If the PWA install prompt doesn't appear on Android, confirm `manifest.webmanifest` is reachable at `http://<host>:<port>/manifest.webmanifest` and `sw.js` is registered in the page.
- If Chromecast connection fails, confirm the cast device IP is reachable and not blocked by a firewall.

**Files of interest**

- [photocast.ts](photocast.ts): main Deno server and CLI.
- [website/index.html](index.html) or the file you place under `website/`: main web UI.
- `trips.yml`: configuration for photo trips.

