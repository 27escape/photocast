#!/usr/bin/env deno run --allow-net --allow-read --allow-write --allow-sys --allow-run --allow-env
/**
 * PHOTOCAST PRO - GOLD VERSION 71.00
 * ==================================
 * CORE FEATURES:
 * - RAW+JPG Deduplication: Prefers native JPGs to avoid redundant RAW conversions.
 * - Anti-Bounce Scrubber: Instant JUMP handling via WebSockets.
 * - Shared State: Pause, Settings (IP/Timeout), and Index synced across all clients.
 * - EXIF: Fractional shutter and clean aperture values.
 * - Stability: Suppresses Deno/Oak 'request closed' noise; preserves all debug telemetry.
 */

import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import castv2 from "npm:castv2-client";
import { Command } from "npm:commander";
import { parse as parseYaml } from "https://deno.land/std@0.208.0/yaml/mod.ts";
import {
  basename,
  extname,
  join,
  parse as parsePath,
} from "https://deno.land/std@0.208.0/path/mod.ts";
import process from "node:process";

const { Client, DefaultMediaReceiver } = castv2;
const USER = Deno.env.get("USER") || "default";
const BASE_CACHE_DIR = `/tmp/photocast_${USER}`;
const STATE_FILE = join(BASE_CACHE_DIR, "state.json");
const SETTINGS_FILE = join(BASE_CACHE_DIR, "settings.json");
const GEO_CACHE_FILE = join(BASE_CACHE_DIR, "geo_cache.json");
const FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf";
const DEFAULT_SETTINGS = { ip: "192.168.0.216", timeout: 30 };

async function purgeCacheKeepSettings() {
  console.log(`[Cleaner] Purging cache while preserving settings...`);
  try {
    let settingsText: string | null = null;
    try {
      settingsText = Deno.readTextFileSync(SETTINGS_FILE);
    } catch (e: any) {
      settingsText = null;
    }
    try {
      await Deno.remove(BASE_CACHE_DIR, { recursive: true });
    } catch (e: any) {
      console.log(`Cache purge error (non-fatal): ${e.message}`);
    }
    try {
      await Deno.mkdir(BASE_CACHE_DIR, { recursive: true });
    } catch (e: any) {
      console.log(`Cache directory creation error (non-fatal): ${e.message}`);
    }
    if (settingsText) {
      try {
        await Deno.writeTextFile(SETTINGS_FILE, settingsText);
      } catch (e: any) {
        console.log(`Settings restore error (non-fatal): ${e.message}`);
      }
    }
  } catch (e: any) {
    // swallow - caller may log
    console.log(`PurgeCacheKeepSettings error: ${e.message}`);
  }
}

function formatShutter(ss: string): string {
  const val = parseFloat(ss);
  if (isNaN(val)) return ss;
  if (val >= 0.4) return val.toFixed(1) + "s";
  return "1/" + Math.round(1 / val);
}

class Logger {
  constructor(private verbose: boolean) {}
  private ts() {
    return new Date().toISOString().replace("T", " ").split(".")[0];
  }
  info(msg: string) {
    if (this.verbose) {
      console.log(`%c[${this.ts()}] [Info] ${msg}`, "color: blue");
    }
  }
  success(msg: string) {
    console.log(`%c[${this.ts()}] [OK] ${msg}`, "color: green");
  }
  error(msg: string) {
    console.error(`%c[${this.ts()}] [Error] ${msg}`, "color: red");
  }
  debug(msg: string) {
    if (this.verbose) {
      console.log(`%c[${this.ts()}] [Debug] ${msg}`, "color: gray");
    }
  }
}

class CastManager {
  private client: any = null;
  private player: any = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastActionTime = 0;
  public status: "OFF" | "AVAILABLE" | "ACTIVE" = "OFF";
  public ip: string | null = null;
  public connected = false;
  public lastError: string | null = null;
  public lastStatusEvent: any = null;

  constructor(
    ip: string | null,
    private isHeadless: boolean,
    private logger: Logger,
    private onStatusChange: () => void,
  ) {
    this.ip = ip;
    if (!this.isHeadless && this.ip) this.startHeartbeat();
  }

  updateIp(newIp: string) {
    this.ip = newIp;
    this.dispose();
  }

  private async probe(): Promise<boolean> {
    if (this.isHeadless || !this.ip) return false;
    try {
      const conn = await Deno.connect({ hostname: this.ip, port: 8009 });
      conn.close();
      return true;
    } catch (e: any) {
      return false;
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      if (
        Date.now() - this.lastActionTime < 15000 || this.status === "ACTIVE"
      ) return;
      const up = await this.probe();
      const newStatus = up ? "AVAILABLE" : "OFF";
      if (this.status !== newStatus) {
        this.status = newStatus;
        this.onStatusChange();
      }
    }, 5000);
  }

  async connect(isActive: boolean): Promise<boolean> {
    if (this.isHeadless || !this.ip) return false;
    if (!isActive) {
      this.dispose();
      return false;
    }
    if (this.player) return true;
    return new Promise((resolve) => {
      try {
        this.lastError = null;
        this.client = new Client();
        this.client.on("error", (err: any) => {
          const message = err?.message || err;
          this.lastError = `Client error: ${message}`;
          this.logger.error(`[Cast] ${this.lastError}`);
          this.dispose();
          resolve(false);
        });
        this.client.connect({ host: this.ip, port: 8009 }, () => {
          this.client.launch(DefaultMediaReceiver, (err: any, player: any) => {
            if (err) {
              const message = err?.message || err;
              this.lastError = `Launch error: ${message}`;
              this.logger.error(`[Cast] ${this.lastError}`);
              this.dispose();
              resolve(false);
            } else {
              this.player = player;
              this.connected = true;
              this.status = "ACTIVE";
              this.lastActionTime = Date.now();
              this.onStatusChange();
              this.logger.info("[Cast] Receiver launched successfully.");
              this.player.on("status", (s: any) => {
                this.lastStatusEvent = s;
                if (Date.now() - this.lastActionTime < 5000) return;
                if (
                  s && (s.playerState === "IDLE" || s.playerState === "STOPPED")
                ) {
                  this.status = "AVAILABLE";
                  this.onStatusChange();
                }
              });
              resolve(true);
            }
          });
        });
      } catch (e: any) {
        const message = e?.message || e;
        this.lastError = `Connect exception: ${message}`;
        this.logger.error(`[Cast] ${this.lastError}`);
        this.status = "OFF";
        this.onStatusChange();
        resolve(false);
      }
    });
  }

  load(url: string) {
    if (!this.player) {
      this.lastError = "Load called with no active player instance.";
      this.logger.error(`[Cast] ${this.lastError}`);
      return;
    }
    this.lastError = null;
    this.lastActionTime = Date.now();
    if (this.status !== "ACTIVE") {
      this.status = "ACTIVE";
      this.onStatusChange();
    }
    this.logger.info(`[Cast] Loading URL: ${url}`);
    this.player.load({ contentId: url, contentType: "image/jpeg" }, {
      autoplay: true,
    }, (err: any) => {
      if (err) {
        const message = err?.message || err;
        this.lastError = `Load error: ${message}`;
        this.logger.error(`[Cast] ${this.lastError}`);
        this.dispose();
      }
    });
  }

  dispose() {
    this.lastActionTime = 0;
    try {
      if (this.client) this.client.close();
    } catch (e: any) {
      const message = e?.message || e;
      this.logger.error(`[Cast] Dispose error: ${message}`);
      this.lastError = `Dispose error: ${message}`;
    }
    this.client = this.player = null;
    this.status = "OFF";
    this.connected = false;
    this.onStatusChange();
    this.startHeartbeat();
  }
}

class GeoProxy {
  private cache: Record<string, string> = {};
  private lastRequestTime = 0;
  constructor(private logger: Logger) {
    try {
      this.cache = JSON.parse(Deno.readTextFileSync(GEO_CACHE_FILE));
    } catch (e: any) {}
  }
  async getCity(lat: string, lon: string): Promise<string> {
    if (!lat || !lon) return "";
    const key = `${lat},${lon}`;
    if (this.cache[key]) return this.cache[key];
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - this.lastRequestTime));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=14`,
        { headers: { "User-Agent": "PhotoCastPro/1.0" } },
      );
      const d = await r.json();
      const loc = d.address.city || d.address.town || d.address.village ||
        d.address.suburb || "";
      this.cache[key] = loc;
      this.lastRequestTime = Date.now();
      Deno.writeTextFileSync(GEO_CACHE_FILE, JSON.stringify(this.cache));
      return loc;
    } catch (e: any) {
      return "";
    }
  }
}

class ImageProcessor {
  private currentWorkerId = 0;
  public readyMap = new Set<number>();
  public burnHud = false;
  constructor(
    private tempDir: string,
    private logger: Logger,
    private onReady: (idx: number) => void,
  ) {
    try {
      Deno.mkdirSync(tempDir, { recursive: true });
    } catch (e: any) {}
  }
  getSafeName(photoPath: string, index: number, tripName: string) {
    const tripSafe = tripName.replace(/[^a-z0-9]/gi, "_");
    const fileBase = basename(photoPath).replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();
    return `${tripSafe}_${index}_clean_${fileBase}.jpg`;
  }

  setTrip(name: string) {
    this.currentWorkerId++;
    this.readyMap.clear();
    return this.currentWorkerId;
  }
  private async tryExtract(
    p: string,
    v: string,
    gen: number,
  ): Promise<boolean> {
    if (gen !== this.currentWorkerId) return false;
    const tags = ["-JpgFromRaw", "-PreviewImage", "-ThumbnailImage"];
    for (const tag of tags) {
      await new Deno.Command("exiftool", {
        args: ["-quiet", "-m", "-b", tag, "-W", v, p],
      }).output();
      try {
        if ((await Deno.stat(v)).size > 5000) {
          await new Deno.Command("exiftool", {
            args: [
              "-quiet",
              "-overwrite_original",
              "-TagsFromFile",
              p,
              "-Orientation",
              v,
            ],
          }).output();
          return true;
        }
      } catch (e: any) {}
    }
    return false;
  }
  async process(
    photoPath: string,
    index: number,
    tripName: string,
    cachedExif: Record<string, string>,
    gen: number,
    geo: GeoProxy,
  ): Promise<void> {
    if (gen !== this.currentWorkerId) return;
    const outName = this.getSafeName(photoPath, index, tripName);
    const outPath = join(this.tempDir, outName);
    try {
      const stats = await Deno.stat(outPath);
      if (stats.isFile && stats.size > 0) {
        this.logger.debug(`[Cache Hit] Item ${index}: ${outName}`);
        if (gen === this.currentWorkerId) {
          this.readyMap.add(index);
          this.onReady(index);
        }
        return;
      }
    } catch (e: any) {}
    try {
      let input = photoPath;
      let scratchPath: string | null = null;
      if (
        [".nef", ".orf", ".dng", ".arw", ".heic"].includes(
          extname(photoPath).toLowerCase(),
        )
      ) {
        scratchPath = join(this.tempDir, `pre_${index}.jpg`);
        if (await this.tryExtract(photoPath, scratchPath, gen)) {
          input = scratchPath;
        }
        if (gen !== this.currentWorkerId) return;
      }
      this.logger.debug(`[Processor] Magick generating ${index}...`);
      await new Deno.Command("magick", {
        args: [
          input,
          "-auto-orient",
          "-resize",
          "1920x1080>",
          "-strip",
          outPath,
        ],
      }).output();
      if (scratchPath) {
        try {
          await Deno.remove(scratchPath);
        } catch (e: any) {}
      }
      if (gen !== this.currentWorkerId) return;
      const bOut = await new Deno.Command("magick", {
        args: [
          outPath,
          "-gravity",
          "South",
          "-crop",
          "100x15%+0+0",
          "-colorspace",
          "gray",
          "-format",
          "%[fx:mean]",
          "info:",
        ],
      }).output();
      cachedExif["pc_is_dark"] =
        (parseFloat(new TextDecoder().decode(bOut.stdout)) < 0.4).toString();
      if (cachedExif["GPS Latitude"] && cachedExif["GPS Longitude"]) {
        cachedExif["pc_location"] = await geo.getCity(
          cachedExif["GPS Latitude"],
          cachedExif["GPS Longitude"],
        );
      }
      if (this.burnHud) {
        let dateVal =
          (cachedExif["Date/Time Original"] || cachedExif["Create Date"] ||
            cachedExif["Modify Date"] || "0000").split(" ")[0].replace(
              /:/g,
              "-",
            );
        if (dateVal.startsWith("0000")) {
          try {
            dateVal =
              (await Deno.stat(photoPath)).mtime?.toISOString().split("T")[0] ||
              "Unknown";
          } catch (e) {
            dateVal = "Unknown";
          }
        }
        const loc = cachedExif["pc_location"] || "";
        const tag = loc
          ? `${tripName} | ${dateVal} | ${loc}`
          : `${tripName} | ${dateVal}`;
        const isDark = cachedExif["pc_is_dark"] === "true";
        const boxColor = isDark ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.5)";
        const textColor = isDark ? "white" : "black";

        await new Deno.Command("magick", {
          args: [
            outPath,
            "-fill",
            boxColor,
            "-draw",
            "rectangle 0,1000 1920,1080",
            "-font",
            FONT_PATH,
            "-fill",
            textColor,
            "-pointsize",
            "32",
            "-gravity",
            "South",
            "-annotate",
            "+0+25",
            tag,
            outPath,
          ],
        }).output();
      }
      if (gen === this.currentWorkerId) {
        this.readyMap.add(index);
        this.onReady(index);
      }
    } catch (e: any) {
      this.logger.debug(`Processor error: ${e.message}`);
    }
  }
  async runWorker(photos: any[], tripName: string, geo: GeoProxy) {
    const generation = this.currentWorkerId;
    this.logger.info(`[Worker] Starting background processing for ${tripName}`);
    for (let i = 0; i < photos.length; i++) {
      if (generation !== this.currentWorkerId) return;
      await this.process(
        photos[i].path,
        i,
        tripName,
        photos[i].exif,
        generation,
        geo,
      );
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 5));
    }
  }
  async generateStatusImg(text: string): Promise<Uint8Array | null> {
    const out = join(this.tempDir, "status_frame.jpg");
    await new Deno.Command("magick", {
      args: [
        "-size",
        "1920x1080",
        "canvas:black",
        "-font",
        FONT_PATH,
        "-fill",
        "white",
        "-pointsize",
        "60",
        "-gravity",
        "center",
        "-annotate",
        "+0+0",
        text,
        out,
      ],
    }).output();
    try {
      return await Deno.readFile(out);
    } catch (e: any) {
      return null;
    }
  }
}

class PhotoCastSystem {
  private photoEntries: any[] = [];
  private currentIndex = 0;
  private lastSentIndex = -1;
  private tripName = "";
  private isCasting = false;
  private isScanning = false;
  private isPaused = false;
  private scanPercent = 0;
  private sessionId = Date.now().toString();
  private sockets = new Set<WebSocket>();
  private processor: ImageProcessor;
  private cast: CastManager;
  private logger: Logger;
  private geo: GeoProxy;
  private settings = DEFAULT_SETTINGS;
  private timeRemaining = 30;
  private lastCastTime = 0; 

  constructor(
    private configPath: string,
    initialIp: string,
    private port: number,
    private verbose: boolean,
    private headless: boolean,
    private htmlFile: string,
    private burnHud: boolean = false,
  ) {
    this.logger = new Logger(verbose);
    this.geo = new GeoProxy(this.logger);
    try {
      this.settings = JSON.parse(Deno.readTextFileSync(SETTINGS_FILE));
    } catch (e: any) {
      this.settings.ip = initialIp;
    }

    this.processor = new ImageProcessor(BASE_CACHE_DIR, this.logger, (idx) => {
      if (this.photoEntries[idx]) {
        this.broadcast({
          type: "READY",
          index: idx,
          file: basename(this.photoEntries[idx].path),
          exif: this.photoEntries[idx].exif,
        });
        this.saveState();
      }
    });
    this.processor.burnHud = burnHud;

    this.cast = new CastManager(
      this.settings.ip,
      headless,
      this.logger,
      () => this.broadcastState(),
    );
    this.timeRemaining = this.settings.timeout;

    this.setupRoutes();
    this.watchHtmlFile(); // Start the live-reload watcher
    
    setInterval(() => {
      if (
        this.isScanning || this.photoEntries.length === 0 ||
        this.processor.readyMap.size === 0
      ) return;

      if (this.isPaused) {
        if (this.cast.connected && this.cast.status === "ACTIVE") {
          const now = Date.now();
          if (now - this.lastCastTime >= 60000) {
            this.logger.info("[Anti-Screensaver] Paused for 60s, resending image to keep Chromecast active.");
            this.lastCastTime = now;
            this.refresh();
          }
        }
        return; 
      }

      if (--this.timeRemaining <= 0) this.move(1);
      this.broadcastState();
    }, 1000);
  }

  // --- Live Reload Watcher ---
  private watchHtmlFile() {
    try {
      const watcher = Deno.watchFs(this.htmlFile);
      this.logger.info(`[Watcher] Watching HTML file for live reloads: ${this.htmlFile}`);
      
      let debounceTimer: number | null = null;
      
      // watcher is an async iterable that yields events as they happen
      (async () => {
        for await (const event of watcher) {
          if (event.kind === "modify") {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              this.logger.info("[Watcher] HTML file modified. Instructing clients to reload.");
              this.broadcast({ type: "RELOAD" });
            }, 500) as unknown as number; // Wait 500ms before triggering to avoid duplicate OS events
          }
        }
      })();
    } catch (e: any) {
      this.logger.error(`[Watcher] Could not watch HTML file: ${e.message}`);
    }
  }

  private async saveState() {
    const data = {
      tripName: this.tripName,
      currentIndex: this.currentIndex,
      photoEntries: this.photoEntries,
      readyList: Array.from(this.processor.readyMap),
    };
    try {
      await Deno.writeTextFile(STATE_FILE, JSON.stringify(data));
    } catch (e: any) {}
  }

  private broadcastState(force: boolean = false) {
    const msg: any = {
      type: "SYNC",
      sessionId: this.sessionId,
      index: this.currentIndex,
      timeRemaining: this.timeRemaining,
      isScanning: this.isScanning,
      isPaused: this.isPaused,
      trip: this.tripName,
      total: this.photoEntries.length,
      castStatus: this.cast.status,
      settings: this.settings,
      scanPercent: this.scanPercent,
    };
    if (
      force ||
      (this.currentIndex !== this.lastSentIndex && this.photoEntries.length > 0)
    ) {
      msg.files = Object.fromEntries(
        Array.from(this.processor.readyMap).filter((idx) =>
          this.photoEntries[idx]
        ).map((idx) => [idx, basename(this.photoEntries[idx].path)]),
      );
      msg.exifs = Object.fromEntries(
        Array.from(this.processor.readyMap).filter((idx) =>
          this.photoEntries[idx]
        ).map((idx) => [idx, this.photoEntries[idx].exif]),
      );
      msg.ready = Array.from(this.processor.readyMap);
      this.lastSentIndex = this.currentIndex;
    }
    this.broadcast(msg);
  }

  private broadcast(msg: any) {
    const json = JSON.stringify(msg);
    for (const s of this.sockets) {
      if (s.readyState === WebSocket.OPEN) s.send(json);
    }
  }

  private setupRoutes() {
    const app = new Application();
    const router = new Router();
    app.addEventListener("error", (evt) => {
      if (evt.error?.message?.includes("request closed")) return;
      this.logger.debug(`[Server Error] ${evt.error?.message}`);
    });

    router.get("/ws", (ctx) => {
      if (!ctx.isUpgradable) return;
      const ws = ctx.upgrade();
      this.sockets.add(ws);
      setTimeout(() => this.broadcastState(true), 100);
      ws.onmessage = (e: { data: string }) => {
        try {
          const d = JSON.parse(e.data);
          if (d.type === "MOVE") this.move(d.step);
          if (d.type === "JUMP") {
            this.currentIndex = d.index;
            this.timeRemaining = this.settings.timeout;
            this.refresh();
            this.broadcastState();
          }
          if (d.type === "TOGGLE_PAUSE") {
            this.isPaused = !this.isPaused;
            this.broadcastState();
          }
          if (d.type === "UPDATE_SETTINGS") {
            this.settings = { ...this.settings, ...d.settings };
            Deno.writeTextFileSync(
              SETTINGS_FILE,
              JSON.stringify(this.settings),
            );
            this.cast.updateIp(this.settings.ip);
            this.timeRemaining = this.settings.timeout;
            this.broadcastState();
          }
        } catch (e: any) {}
      };
      ws.onclose = () => this.sockets.delete(ws);
    });

    router.get("/img/:trip/:filename", async (ctx) => {
      const { trip, filename } = ctx.params;
      if (filename === "status") {
        try {
          ctx.response.body = await Deno.readFile(
            join(BASE_CACHE_DIR, "status_frame.jpg"),
          );
          ctx.response.type = "image/jpeg";
        } catch (e: any) {
          ctx.response.status = 404;
        }
        return;
      }
      const idx = this.photoEntries.findIndex((e) =>
        basename(e.path) === filename
      );
      if (idx === -1) return ctx.response.status = 404;
      const safeName = this.processor.getSafeName(
        this.photoEntries[idx].path,
        idx,
        this.tripName,
      );
      try {
        ctx.response.body = await Deno.readFile(join(BASE_CACHE_DIR, safeName));
        ctx.response.type = "image/jpeg";
      } catch (e: any) {
        ctx.response.status = 404;
      }
    });

    router.get("/trips-list", async (ctx) => {
      const config = parseYaml(await Deno.readTextFile(this.configPath)) as any;
      ctx.response.body = config.trips.sort((a: any, b: any) =>
        new Date(b.start).getTime() - new Date(a.start).getTime()
      ).map((t: any) => t.name);
    });

    router.get("/search", async (ctx) => {
      await this.selectTrip(
        undefined,
        ctx.request.url.searchParams.get("q") || "",
      );
      ctx.response.status = 200;
    });
    router.get("/random", async (ctx) => {
      await this.selectTrip();
      ctx.response.status = 200;
    });
    router.get("/toggle-cast", async (ctx) => {
      this.isCasting = !this.isCasting;
      this.logger.info(
        `[Cast] Toggle request received. isCasting=${this.isCasting}`,
      );
      try {
        await this.refresh();
        ctx.response.status = 200;
        ctx.response.body = {
          status: "ok",
          isCasting: this.isCasting,
          castStatus: this.cast.status,
          ip: this.settings.ip,
          connected: this.cast.connected,
          lastError: this.cast.lastError,
          lastStatusEvent: this.cast.lastStatusEvent,
        };
      } catch (e: any) {
        this.logger.error(`[Cast] Toggle refresh failed: ${e?.message || e}`);
        ctx.response.status = 500;
        ctx.response.body = {
          status: "error",
          message: e?.message || "Refresh failed",
        };
      }
    });
    router.get("/cast-status", (ctx) => {
      ctx.response.status = 200;
      ctx.response.body = {
        status: "ok",
        isCasting: this.isCasting,
        castStatus: this.cast.status,
        castIp: this.cast.ip,
        connected: this.cast.connected,
        lastError: this.cast.lastError,
        lastStatusEvent: this.cast.lastStatusEvent,
      };
    });
    router.post("/update-settings", async (ctx) => {
      try {
        const body = await ctx.request.body({ type: "json" }).value;
        this.logger.info(`[Settings] Received update: ${JSON.stringify(body)}`);
        this.settings = { ...this.settings, ...body };
        try {
          try {
            Deno.mkdirSync(BASE_CACHE_DIR, { recursive: true });
          } catch (e: any) {}
          Deno.writeTextFileSync(SETTINGS_FILE, JSON.stringify(this.settings));
          this.logger.info(`[Settings] Persisted to ${SETTINGS_FILE}`);
        } catch (e: any) {
          this.logger.error(`[Settings] Write error: ${e?.message || e}`);
        }
        this.cast.updateIp(this.settings.ip);
        this.timeRemaining = this.settings.timeout;
        this.broadcastState(true);
        ctx.response.status = 200;
        ctx.response.body = { status: "ok", settings: this.settings };
      } catch (e: any) {
        this.logger.error(`[Settings] Update failed: ${e?.message || e}`);
        ctx.response.status = 400;
        ctx.response.body = {
          status: "error",
          message: e?.message || "bad request",
        };
      }
    });
    router.get("/", async (ctx) => {
      ctx.response.body = await Deno.readTextFile(this.htmlFile);
      ctx.response.type = "text/html";
    });
    app.use(router.routes());
    app.listen({ port: this.port });
  }

  private move(step: number) {
    if (this.isScanning || this.photoEntries.length === 0) return;
    this.currentIndex = (this.currentIndex + step + this.photoEntries.length) %
      this.photoEntries.length;
    this.timeRemaining = this.settings.timeout;
    this.saveState();
    this.refresh();
    this.broadcastState();
  }

  private async refresh() {
    try {
      if (await this.cast.connect(this.isCasting)) {
        const tripSafe = this.tripName.replace(/[^a-z0-9]/gi, "_");
        const url = (this.isScanning || this.photoEntries.length === 0)
          ? `http://${
            Deno.networkInterfaces().find((i) =>
              i.family === "IPv4" && !i.address.startsWith("127.")
            )?.address || "localhost"
          }:${this.port}/img/${tripSafe}/status?t=${Date.now()}`
          : `http://${
            Deno.networkInterfaces().find((i) =>
              i.family === "IPv4" && !i.address.startsWith("127.")
            )?.address || "localhost"
          }:${this.port}/img/${tripSafe}/${
            basename(this.photoEntries[this.currentIndex].path)
          }?t=${Date.now()}`;
        this.cast.load(url);
        
        // Record the time this image was sent to cast
        this.lastCastTime = Date.now();
      }
    } catch (e: any) {
      this.logger.error(`[Cast] Refresh exception: ${e?.message || e}`);
    }
  }

  public async selectTrip(name?: string, query?: string, restored?: any) {
    const q = query || "";
    this.timeRemaining = this.settings.timeout;
    this.lastSentIndex = -1;
    if (
      restored &&
      (!q || restored.tripName.toLowerCase().includes(q.toLowerCase()))
    ) {
      this.tripName = restored.tripName;
      this.currentIndex = restored.currentIndex;
      this.photoEntries = restored.photoEntries;
      this.processor.setTrip(this.tripName);
      this.processor.readyMap = new Set(restored.readyList);
      this.isScanning = false;
      this.scanPercent = 100;
      this.refresh();
      this.processor.runWorker(this.photoEntries, this.tripName, this.geo);
      return;
    }
    const config = parseYaml(await Deno.readTextFile(this.configPath)) as any;
    let trips = config.trips;
    if (q) {
      trips = trips.filter((t: any) =>
        t.name.toLowerCase().includes(q.toLowerCase())
      );
    }
    const trip = trips.find((t: any) => t.name === name) ||
      trips[Math.floor(Math.random() * trips.length)];
    if (!trip) {
      this.isScanning = false;
      return;
    }

    if (this.tripName && trip && this.tripName !== trip.name && !restored) {
      await purgeCacheKeepSettings();
    }

    this.isScanning = true;
    this.scanPercent = 0;
    this.photoEntries = [];
    this.tripName = trip.name;
    const currentGen = this.processor.setTrip(this.tripName);
    await this.processor.generateStatusImg(
      `Preparing Trip...\n${this.tripName}`,
    );
    this.refresh();
    this.broadcastState();

    const tripPath = join(
      config.target,
      new Date(trip.start).getFullYear().toString(),
      trip.name,
    );
    this.logger.info(`[Scanner] Folder: ${tripPath}`);

    // DEDUPLICATION: Prefer .jpg over RAW
    const rawFiles: Record<string, string> = {};
    try {
      for (const e of Deno.readDirSync(tripPath)) {
        const ext = extname(e.name).toLowerCase();
        if (
          ![".jpg", ".jpeg", ".png", ".dng", ".orf", ".nef", ".arw", ".heic"]
            .includes(ext)
        ) continue;
        const base = parsePath(e.name).name;
        const existingExt = rawFiles[base]
          ? extname(rawFiles[base]).toLowerCase()
          : null;
        if (!existingExt || (ext === ".jpg" || ext === ".jpeg")) {
          rawFiles[base] = join(tripPath, e.name);
        }
      }
    } catch (e: any) {}

    const files = Object.values(rawFiles);
    if (files.length === 0) {
      this.isScanning = false;
      await this.processor.generateStatusImg(`Album Empty:\n${this.tripName}`);
      this.refresh();
      this.broadcastState();
      return;
    }

    const metadata: any[] = [];
    for (let i = 0; i < files.length; i += 50) {
      if (currentGen !== this.processor["currentWorkerId"]) return;
      this.scanPercent = Math.round((i / files.length) * 100);
      this.logger.info(
        `[Scanner] Batch ${Math.ceil(i / 50) + 1} (${this.scanPercent}%)`,
      );
      this.broadcastState();
      const batch = files.slice(i, i + 50);
      const { stdout } = await new Deno.Command("exiftool", {
        args: ["-n", ...batch],
      }).output();
      const chunks = new TextDecoder().decode(stdout).trim().split(/={8}\s/);
      batch.forEach((p) => {
        const chunk = chunks.find((c) => c.includes(basename(p)));
        const rawExif: Record<string, string> = {};
        if (chunk) {
          chunk.split("\n").forEach((line) => {
            const colonIdx = line.indexOf(":");
            if (colonIdx !== -1) {
              rawExif[line.substring(0, colonIdx).trim()] = line.substring(
                colonIdx + 1,
              ).trim();
            }
          });
        }
        const exif: Record<string, string> = { ...rawExif };
        const apKey = Object.keys(rawExif).find((k) =>
          k.toLowerCase().includes("aperture") &&
          !k.toLowerCase().includes("max")
        );
        exif["pc_aperture"] = apKey
          ? parseFloat(rawExif[apKey]).toFixed(1)
          : (rawExif["FNumber"] || "");
        const ssKey = Object.keys(rawExif).find((k) =>
          k.toLowerCase().includes("shutter") &&
          k.toLowerCase().includes("speed")
        );
        exif["pc_shutter"] = ssKey
          ? formatShutter(rawExif[ssKey])
          : (rawExif["ExposureTime"] || "");
        exif["pc_iso"] = (rawExif["ISO"] || "").toString();

        // GPS coordinate negation fix
        const latVal = rawExif["GPS Latitude"]
          ? parseFloat(rawExif["GPS Latitude"])
          : null;
        const lonVal = rawExif["GPS Longitude"]
          ? parseFloat(rawExif["GPS Longitude"])
          : null;
        if (latVal !== null && lonVal !== null) {
          const latRef = rawExif["GPS Latitude Ref"] ||
            (String(rawExif["GPS Latitude"]).includes("S") ? "S" : "N");
          const lonRef = rawExif["GPS Longitude Ref"] ||
            (String(rawExif["GPS Longitude"]).includes("W") ? "W" : "E");
          const finalLat = latRef === "S"
            ? -Math.abs(latVal)
            : Math.abs(latVal);
          const finalLon = lonRef === "W"
            ? -Math.abs(lonVal)
            : Math.abs(lonVal);
          exif["GPS Latitude"] = finalLat.toString();
          exif["GPS Longitude"] = finalLon.toString();
        }

        metadata.push({
          path: p,
          TS: (exif["Date/Time Original"] || exif["Create Date"] || "")
            .toString(),
          exif,
        });
      });
    }
    this.photoEntries = metadata.sort((a, b) => a.TS.localeCompare(b.TS));
    this.scanPercent = 100;
    this.isScanning = false;
    this.currentIndex = 0;
    this.saveState();
    this.refresh();
    this.processor.runWorker(this.photoEntries, this.tripName, this.geo);
  }
  public async start(initialSearch?: string) {
    let restored = null;
    try {
      restored = JSON.parse(await Deno.readTextFile(STATE_FILE));
    } catch (e: any) {}
    await this.selectTrip(undefined, initialSearch, restored);
  }
}

const p = new Command();
p.option("-i, --ip <string>", "Cast IP", DEFAULT_SETTINGS.ip)
  .option("-p, --port <number>", "Port", "8080")
  .option("-y, --yaml <string>", "YAML", "./trips.yml")
  .option("-v, --verbose", "Debug", false)
  .option("-s, --search <string>", "Search")
  .option("--headless", "Headless", false)
  .option("--clear-cache", "Wipe Cache", false)
  .option("--html <string>", "Custom HTML file", "./photocast.html")
  .option("--burn-hud", "Burn metadata directly into cached images", false);

p.parse(process.argv);
const o = p.opts();
if (o.clearCache) {
  try {
    await purgeCacheKeepSettings();
    console.log("Cache Wiped.");
  } catch (e: any) {}
}
// test if html file exists and is readable
if (o.html) {
  try {
    await Deno.readTextFile(o.html);
  } catch (e: any) {
    console.error(`HTML file error: ${e.message}`);
    Deno.exit(1);
  }
}

const LOCAL_IP =
  Deno.networkInterfaces().find((i) =>
    i.family === "IPv4" && !i.address.startsWith("127.")
  )?.address || "localhost";
new PhotoCastSystem(
  o.yaml,
  o.ip,
  parseInt(o.port),
  o.verbose,
  o.headless,
  o.html,
  o.burnHud,
)
  .start(o.search);