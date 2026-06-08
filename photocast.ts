#!/usr/bin/env deno run -A
/**
 * PHOTOCAST - send local photo albums to a chromecast
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

// --- GLOBAL DENO NOISE FILTER ---
const networkErrors = [
  "request closed",
  "Connection reset by peer",
  "Cannot read headers",
  "Broken pipe",
  "connection closed before message completed"
];

function isNoisy(msg: string) { return networkErrors.some(err => msg?.includes(err)); }

let silencingOak = false;
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  const msgStr = typeof args[0] === "string" ? args[0] : "";
  const isErrorObj = args[0] instanceof Error;
  const directErrorMsg = isErrorObj ? args[0].message : "";
  const errStr = args[1] instanceof Error ? args[1].message : "";

  if (msgStr.includes("[uncaught application error]")) {
    if (isNoisy(msgStr) || isNoisy(errStr)) { silencingOak = true; return; }
  }
  if (silencingOak) {
    if (msgStr.includes("\nrequest:") || msgStr.includes("response:") || msgStr.includes("request:")) return;
    if (isErrorObj) { silencingOak = false; return; }
    if (isNoisy(msgStr)) return;
  }
  if (isErrorObj && isNoisy(directErrorMsg)) return;
  originalConsoleError(...args);
};

globalThis.addEventListener("unhandledrejection", (e) => { if (isNoisy(e.reason?.message || String(e.reason))) e.preventDefault(); });
globalThis.addEventListener("error", (e) => { if (isNoisy(e.error?.message || e.message)) e.preventDefault(); });
// --------------------------------

const { Client, DefaultMediaReceiver } = castv2;
const USER = Deno.env.get("USER") || "default";
const BASE_CACHE_DIR = `/tmp/${USER}/photocast`;
const STATE_FILE = join(BASE_CACHE_DIR, "state.json");
const SETTINGS_FILE = join(BASE_CACHE_DIR, "settings.json");
const GEO_CACHE_FILE = join(BASE_CACHE_DIR, "geo_cache.json");
const FONT_PATH = "/System/Library/Fonts/Supplemental/Arial.ttf";
const DEFAULT_SETTINGS = { ip: "192.168.0.216", timeout: 30, port: 8080 };
const LOCAL_IP = Deno.networkInterfaces().find((i) => i.family === "IPv4" && !i.address.startsWith("127."))?.address || "localhost";

async function purgeCacheKeepSettings() {
  try {
    let settingsText = null;
    try { settingsText = Deno.readTextFileSync(SETTINGS_FILE); } catch {}
    await Deno.remove(BASE_CACHE_DIR, { recursive: true }).catch(() => {});
    await Deno.mkdir(BASE_CACHE_DIR, { recursive: true }).catch(() => {});
    if (settingsText) await Deno.writeTextFile(SETTINGS_FILE, settingsText);
  } catch (e: any) { console.log(`Purge error: ${e.message}`); }
}

function formatShutter(ss: string): string {
  const val = parseFloat(ss);
  if (isNaN(val)) return ss;
  if (val >= 0.4) return val.toFixed(1) + "s";
  return "1/" + Math.round(1 / val);
}

class Logger {
  private logFile: string;
  constructor(private verbose: boolean, private headless: boolean) {
    this.logFile = join(BASE_CACHE_DIR, "photocast.log");
    if (headless) {
      try { Deno.mkdirSync(BASE_CACHE_DIR, { recursive: true }); } catch {}
    }
  }
  
  private ts() { return new Date().toISOString(); } 
  
  private write(level: string, msg: string, color: string) {
    const line = `[${this.ts()}] [${level}] ${msg}`;
    if (this.headless) {
      try { Deno.writeTextFileSync(this.logFile, line + "\n", { append: true }); } catch {}
    } else {
      if (level === "Error") {
        console.error(`%c${line}`, `color: ${color}; font-weight: bold;`);
      } else {
        console.log(`%c${line}`, `color: ${color}; font-weight: bold;`);
      }
    }
  }

  info(msg: string) { this.write("Info", msg, "dodgerblue"); }
  success(msg: string) { this.write("OK", msg, "limegreen"); }
  warn(msg: string) { this.write("Warn", msg, "gold"); }
  error(msg: string) { this.write("Error", msg, "crimson"); }
  debug(msg: string) { if (this.verbose) this.write("Debug", msg, "gray"); }
}

class CastManager {
  private client: any = null;
  private player: any = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  public status: "OFF" | "AVAILABLE" | "ACTIVE" | "OFFLINE" = "OFF";
  public ip: string | null = null;
  public connected = false;

  constructor(ip: string | null, private logger: Logger, private onStatusChange: () => void) {
    this.ip = ip;
    this.startHeartbeat();
  }

  updateIp(newIp: string) { 
    this.logger.info(`[Cast] IP updated to ${newIp}`);
    this.ip = newIp; 
    this.dispose(); 
    this.startHeartbeat(); 
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      if (this.status === "ACTIVE") return;
      const up = await this.probe();
      const newStatus = up ? "AVAILABLE" : "OFF";
      if (this.status !== newStatus) { 
        this.logger.info(`[Cast] Heartbeat status change: ${this.status} -> ${newStatus}`);
        this.status = newStatus; 
        this.onStatusChange(); 
      }
    }, 5000);
  }

  private async probe(): Promise<boolean> {
    if (!this.ip) return false;
    try { const conn = await Deno.connect({ hostname: this.ip, port: 8009 }); conn.close(); return true; } catch { return false; }
  }

  async connect(): Promise<boolean> {
    if (!this.ip) return false;
    if (this.player && this.connected && this.status === "ACTIVE") return true;
    
    return new Promise((resolve) => {
      this.logger.info(`[Cast] Attempting manual connection to ${this.ip}...`);
      this.client = new Client();
      
      this.client.on("error", (err: any) => {
        this.logger.error(`[Cast] Client error event: ${err?.message}`);
        this.dispose("OFFLINE");
        resolve(false);
      });
      
      this.client.connect({ host: this.ip, port: 8009 }, () => {
        this.client.launch(DefaultMediaReceiver, (err: any, player: any) => {
          if (err) { 
            this.logger.error(`[Cast] Launch failed: ${err?.message || err}`);
            this.dispose("OFFLINE"); 
            resolve(false); 
          } else { 
            this.player = player; 
            this.connected = true; 
            this.logger.success(`[Cast] Connected successfully. Status: ${this.status} -> ACTIVE`);
            this.status = "ACTIVE"; 
            this.onStatusChange(); 
            resolve(true); 
          }
        });
      });
    });
  }

  load(url: string) { 
    if (this.player) {
      this.logger.debug(`[Cast] Loading image onto receiver: ${url}`);
      this.player.load({ contentId: url, contentType: "image/jpeg" }, { autoplay: true }, (err: any) => {
          if (err) this.logger.error(`[Cast] Player load error: ${err?.message || err}`);
        }); 
    }
  }

  dispose(forceStatus: "OFF" | "OFFLINE" = "OFF") { 
    try { if (this.client) this.client.close(); } catch {} 
    this.client = this.player = null; 
    this.connected = false; 
    
    if (this.status !== forceStatus) {
      this.logger.info(`[Cast] Connection closed. Status: ${this.status} -> ${forceStatus}`);
      this.status = forceStatus;
    }
    this.onStatusChange(); 
  }
}

class GeoProxy {
  private cache: Record<string, string> = {};
  private lastRequestTime = 0;
  constructor() { try { this.cache = JSON.parse(Deno.readTextFileSync(GEO_CACHE_FILE)); } catch {} }
  async getCity(lat: string, lon: string): Promise<string> {
    if (!lat || !lon) return "";
    const key = `${lat},${lon}`;
    if (this.cache[key]) return this.cache[key];
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - this.lastRequestTime));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=14`, { headers: { "User-Agent": "PhotoCastPro/1.0" } });
      const d = await r.json();
      const loc = d.address.city || d.address.town || d.address.village || "";
      this.cache[key] = loc; this.lastRequestTime = Date.now();
      Deno.writeTextFileSync(GEO_CACHE_FILE, JSON.stringify(this.cache));
      return loc;
    } catch { return ""; }
  }
}

class ImageProcessor {
  private currentWorkerId = 0;
  public readyMap = new Set<number>();
  constructor(private tempDir: string, private logger: Logger, private onReady: (idx: number) => void) { try { Deno.mkdirSync(tempDir, { recursive: true }); } catch {} }
  getSafeName(p: string, i: number, trip: string) { return `${trip.replace(/[^a-z0-9]/gi, "_")}_${i}_clean_${basename(p).replace(/[^a-z0-9]/gi, "_").toLowerCase()}.jpg`; }
  setTrip(name: string) { this.currentWorkerId++; this.readyMap.clear(); return this.currentWorkerId; }
  
  private async tryExtract(p: string, v: string, gen: number): Promise<boolean> {
    if (gen !== this.currentWorkerId) return false;
    const tags = ["-JpgFromRaw", "-PreviewImage", "-ThumbnailImage"];
    for (const tag of tags) {
      await new Deno.Command("exiftool", { args: ["-quiet", "-m", "-b", tag, "-W", v, p] }).output();
      try {
        const stat = await Deno.stat(v);
        if (stat.isFile && stat.size > 5000) {
          const f = await Deno.open(v, { read: true }); const header = new Uint8Array(2); await f.read(header); f.close();
          if (header[0] === 0xFF && header[1] === 0xD8) {
            
            const { stdout } = await new Deno.Command("magick", { args: ["identify", "-format", "%w", v] }).output();
            const width = parseInt(new TextDecoder().decode(stdout)) || 0;
            
            if (width >= 1000) {
              await new Deno.Command("exiftool", { args: ["-quiet", "-overwrite_original", "-TagsFromFile", p, "-Orientation", v] }).output();
              this.logger.debug(`[Processor] Extracted high-res preview (${width}px) using ${tag}`);
              return true;
            } else {
              this.logger.debug(`[Processor] Preview from ${tag} too small (${width}px). Discarding.`);
              await Deno.remove(v);
            }
          } else { await Deno.remove(v); }
        }
      } catch {}
    }
    return false;
  }

  async process(path: string, index: number, tripName: string, exif: any, gen: number, geo: GeoProxy) {
    if (gen !== this.currentWorkerId) return;
    const outName = this.getSafeName(path, index, tripName);
    const outPath = join(this.tempDir, outName);
    try {
      const stats = await Deno.stat(outPath);
      if (stats.isFile && stats.size > 0) {
        this.logger.debug(`[Cache Hit] Item ${index}: ${outName}`);
        if (gen === this.currentWorkerId) { this.readyMap.add(index); this.onReady(index); }
        return;
      }
    } catch {}
    
    try {
      this.logger.debug(`[Processor] Cache Miss: Generating ${index} (${basename(path)})...`);
      let input = path;
      let scratch = join(this.tempDir, `pre_${index}.jpg`);
      let scratchRaw = join(this.tempDir, `raw_${index}.tiff`);
      let cleanupRaw = false;
      let rawDeveloped = false;
      let shouldProcess = true;
      
      if ([".nef", ".orf", ".dng", ".arw", ".heic"].includes(extname(path).toLowerCase())) {
        if (await this.tryExtract(path, scratch, gen)) {
          input = scratch;
        } else {
            const tools = ["dcraw", "dcraw_emu"];
            for (const tool of tools) {
                if (rawDeveloped) break;
                try {
                this.logger.debug(`[Processor] Attempting RAW decode with ${tool}...`);
                const rawCmd = new Deno.Command(tool, { args: ["-c", "-w", "-T", path] });
                const { code, stdout } = await rawCmd.output();
                if (code === 0 && stdout.length > 5000) {
                    await Deno.writeFile(scratchRaw, stdout);
                    input = scratchRaw;
                    cleanupRaw = true;
                    rawDeveloped = true;
                    this.logger.debug(`[Processor] Successfully decoded RAW with libraw (${tool})`);
                }
                } catch (e) {}
            }
            if (!rawDeveloped && Deno.build.os === "darwin") {
                try {
                this.logger.debug(`[Processor] Attempting RAW decode with macOS native sips...`);
                scratchRaw = join(this.tempDir, `raw_${index}.jpg`);
                const sipsCmd = new Deno.Command("sips", { args: ["-s", "format", "jpeg", "-Z", "1920", path, "--out", scratchRaw] });
                const { code } = await sipsCmd.output();
                if (code === 0) {
                    input = scratchRaw;
                    cleanupRaw = true;
                    rawDeveloped = true;
                    this.logger.debug(`[Processor] Successfully decoded RAW with macOS sips`);
                }
                } catch (e) {}
            }
            if (!rawDeveloped) {
                this.logger.error(`[Processor] Skipping ${basename(path)}: No valid image format could be extracted.`);
                shouldProcess = false;
            }
        }
      }
      
      if (!shouldProcess) return;
      
      const magickArgs = [
        input, 
        "-auto-orient", 
        "-modulate", "100,110",           
        "-contrast-stretch", "0.5%x0.5%",  
        "-unsharp", "0x0.75+0.75+0.008",   
        "-resize", "1920x1080>", 
        "-strip", 
        outPath
      ];
      
      if (!rawDeveloped) magickArgs.unshift("-define", "delegate:disable=darktable");
      
      const cmd = new Deno.Command("magick", { args: magickArgs });
      const out = await cmd.output();
      if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
      
      if (cleanupRaw) try { await Deno.remove(input); } catch {}
      try { await Deno.remove(scratch); } catch {}
      
      this.logger.debug(`[Processor] Magick finished item ${index}`);
      if (exif["GPS Latitude"] && exif["GPS Longitude"]) exif["pc_location"] = await geo.getCity(exif["GPS Latitude"], exif["GPS Longitude"]);
      
      if (gen === this.currentWorkerId) { this.readyMap.add(index); this.onReady(index); }
    } catch (e: any) { this.logger.error(`[Processor] Item ${index} failed: ${e.message}`); }
  }

  async runWorker(photos: any[], tripName: string, geo: GeoProxy) {
    const gen = this.currentWorkerId;
    this.logger.info(`[Worker] Starting background processing for ${tripName} (${photos.length} items)`);
    for (let i = 0; i < photos.length; i++) {
      if (gen !== this.currentWorkerId) return;
      await this.process(photos[i].path, i, tripName, photos[i].exif, gen, geo);
    }
    this.onReady(-1);
  }
  
  async generateStatusImg(text: string): Promise<Uint8Array | null> {
    const out = join(this.tempDir, "status_frame.jpg");
    await new Deno.Command("magick", {
      args: ["-size", "1920x1080", "canvas:black", "-font", FONT_PATH, "-fill", "white", "-pointsize", "60", "-gravity", "north", "-annotate", "+0+360", text, out],
    }).output();
    try { return await Deno.readFile(out); } catch { return null; }
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

  constructor(private configPath: string, private port: number, private verbose: boolean, private headless: boolean, private htmlFile: string) {
    this.logger = new Logger(verbose, headless);
    this.geo = new GeoProxy();
    try { this.settings = JSON.parse(Deno.readTextFileSync(SETTINGS_FILE)); } catch {}
    
    this.processor = new ImageProcessor(BASE_CACHE_DIR, this.logger, (idx) => {
        if (idx === -1) {
            this.isScanning = false;
            this.broadcastState(true);
        } else if (this.photoEntries[idx]) {
            this.broadcast({ type: "READY", index: idx, file: basename(this.photoEntries[idx].path), exif: this.photoEntries[idx].exif });
            this.saveState();
        }
    });

    this.cast = new CastManager(this.settings.ip, this.logger, () => this.broadcastState());
    this.timeRemaining = this.settings.timeout;

    this.setupRoutes();
    this.watchHtmlFile();
    
    setInterval(() => {
      if (this.isScanning || this.photoEntries.length === 0 || this.processor.readyMap.size === 0) return;

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

  private watchHtmlFile() {
    try {
      const watcher = Deno.watchFs(this.htmlFile);
      this.logger.info(`[Watcher] Watching HTML file: ${this.htmlFile}`);
      
      let debounceTimer: number | null = null;
      (async () => {
        for await (const event of watcher) {
          if (event.kind === "modify") {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              this.logger.info("[Watcher] HTML file modified. Reloading clients.");
              this.broadcast({ type: "RELOAD" });
            }, 500) as unknown as number;
          }
        }
      })();
    } catch (e: any) {
      this.logger.error(`[Watcher] Could not watch HTML: ${e.message}`);
    }
  }

  private async saveState() {
    const data = { tripName: this.tripName, currentIndex: this.currentIndex, photoEntries: this.photoEntries, readyList: Array.from(this.processor.readyMap) };
    try { await Deno.writeTextFile(STATE_FILE, JSON.stringify(data)); } catch {}
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
    if (force || (this.currentIndex !== this.lastSentIndex && this.photoEntries.length > 0)) {
      msg.files = Object.fromEntries(Array.from(this.processor.readyMap).filter((idx) => this.photoEntries[idx]).map((idx) => [idx, basename(this.photoEntries[idx].path)]));
      msg.exifs = Object.fromEntries(Array.from(this.processor.readyMap).filter((idx) => this.photoEntries[idx]).map((idx) => [idx, this.photoEntries[idx].exif]));
      msg.ready = Array.from(this.processor.readyMap);
      this.lastSentIndex = this.currentIndex;
    }
    this.broadcast(msg);
  }

  private broadcast(msg: any) {
    const json = JSON.stringify(msg);
    for (const s of this.sockets) { if (s.readyState === WebSocket.OPEN) s.send(json); }
  }

  private setupRoutes() {
    const app = new Application();
    const router = new Router();
    
    app.addEventListener("error", (evt) => {
      const err = evt.error;
      const msg = err?.message || String(err) || "";
      if (isNoisy(msg)) { evt.preventDefault(); return; }
      this.logger.debug(`[Server Error] ${msg}`);
    });

    router.get("/ws", (ctx) => {
      if (!ctx.isUpgradable) return;
      const ws = ctx.upgrade();
      this.sockets.add(ws);
      ws.onopen = () => setTimeout(() => this.broadcastState(true), 100);
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
            this.logger.info(`[Playback] Pause toggled: ${this.isPaused}`);
            this.broadcastState();
          }
          if (d.type === "UPDATE_SETTINGS") {
            this.settings = { ...this.settings, ...d.settings };
            Deno.writeTextFileSync(SETTINGS_FILE, JSON.stringify(this.settings));
            this.cast.updateIp(this.settings.ip);
            this.timeRemaining = this.settings.timeout;
            this.broadcastState();
          }
        } catch {}
      };
      ws.onclose = () => this.sockets.delete(ws);
    });

    router.get("/img/:trip/:filename", async (ctx) => {
      const { trip, filename } = ctx.params;
      if (filename === "status") {
        try { ctx.response.body = await Deno.readFile(join(BASE_CACHE_DIR, "status_frame.jpg")); ctx.response.type = "image/jpeg"; } catch { ctx.response.status = 404; }
        return;
      }
      const idx = this.photoEntries.findIndex((e) => basename(e.path) === filename);
      if (idx === -1) return ctx.response.status = 404;
      const safeName = this.processor.getSafeName(this.photoEntries[idx].path, idx, this.tripName);
      try { ctx.response.body = await Deno.readFile(join(BASE_CACHE_DIR, safeName)); ctx.response.type = "image/jpeg"; } catch { ctx.response.status = 404; }
    });

    router.get("/trips-list", async (ctx) => {
      const config = parseYaml(await Deno.readTextFile(this.configPath)) as any;
      const validTrips = [];
      for (const t of config.trips) {
        const tripPath = join(config.target, new Date(t.start).getFullYear().toString(), t.name);
        try {
          let hasFiles = false;
          for (const entry of Deno.readDirSync(tripPath)) {
            if ((entry.isFile || entry.isSymlink) && [".jpg", ".jpeg", ".png", ".dng", ".orf", ".nef", ".arw", ".heic"].includes(extname(entry.name).toLowerCase())) {
              hasFiles = true;
              break;
            }
          }
          if (hasFiles) validTrips.push(t);
        } catch {}
      }
      ctx.response.body = validTrips.sort((a: any, b: any) => new Date(b.start).getTime() - new Date(a.start).getTime()).map((t: any) => t.name);
    });

    router.get("/search", async (ctx) => {
      await this.selectTrip(undefined, ctx.request.url.searchParams.get("q") || "");
      ctx.response.status = 200;
    });
    // router.get("/random", async (ctx) => { await this.selectTrip(); ctx.response.status = 200; });
    
    router.get("/toggle-cast", async (ctx) => {
      this.isCasting = !this.isCasting;
      this.logger.info(`[Cast] Toggle isCasting=${this.isCasting}`);
      try {
        if (this.isCasting) { await this.refresh(); } else { this.cast.dispose("OFF"); }
        ctx.response.status = 200;
        ctx.response.body = { status: "ok", isCasting: this.isCasting, castStatus: this.cast.status, ip: this.settings.ip, connected: this.cast.connected };
      } catch (e: any) {
        this.logger.error(`[Cast] Toggle refresh failed: ${e?.message || e}`);
        ctx.response.status = 500;
        ctx.response.body = { status: "error", message: e?.message || "Refresh failed" };
      }
    });

    router.get("/cast-status", (ctx) => {
      ctx.response.status = 200;
      ctx.response.body = { status: "ok", isCasting: this.isCasting, castStatus: this.cast.status, castIp: this.cast.ip, connected: this.cast.connected };
    });

    router.post("/update-settings", async (ctx) => {
      try {
        const body = await ctx.request.body({ type: "json" }).value;
        this.settings = { ...this.settings, ...body };
        try {
          try { Deno.mkdirSync(BASE_CACHE_DIR, { recursive: true }); } catch {}
          Deno.writeTextFileSync(SETTINGS_FILE, JSON.stringify(this.settings));
        } catch (e: any) { this.logger.error(`[Settings] Write error: ${e?.message || e}`); }
        this.cast.updateIp(this.settings.ip);
        this.timeRemaining = this.settings.timeout;
        this.broadcastState(true);
        ctx.response.status = 200;
        ctx.response.body = { status: "ok", settings: this.settings };
      } catch (e: any) {
        this.logger.error(`[Settings] Update failed: ${e?.message || e}`);
        ctx.response.status = 400;
        ctx.response.body = { status: "error", message: "bad request" };
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
    this.currentIndex = (this.currentIndex + step + this.photoEntries.length) % this.photoEntries.length;
    this.timeRemaining = this.settings.timeout;
    this.saveState();
    this.refresh();
    this.broadcastState();
  }

  private async refresh() {
    try {
      if (!this.isCasting) return;
      
      if (await this.cast.connect()) {
        const tripSafe = this.tripName.replace(/[^a-z0-9]/gi, "_");
        const url = (this.isScanning || this.photoEntries.length === 0)
          ? `http://${LOCAL_IP}:${this.port}/img/${tripSafe}/status?t=${Date.now()}`
          : `http://${LOCAL_IP}:${this.port}/img/${tripSafe}/${basename(this.photoEntries[this.currentIndex].path)}?t=${Date.now()}`;
        this.cast.load(url);
        this.lastCastTime = Date.now();
      }
    } catch (e: any) { this.logger.error(`[Cast] Refresh exception: ${e?.message || e}`); }
  }

  public async selectTrip(name?: string, query?: string, restored?: any) {
    const q = query || "";
    this.timeRemaining = this.settings.timeout;
    this.lastSentIndex = -1;
  

    // Check if we are restoring from state.json
    if (restored && (!q || restored.tripName.toLowerCase().includes(q.toLowerCase()))) {
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

    // New Trip: Reset Index
    this.currentIndex = 0; 
    
    const config = parseYaml(await Deno.readTextFile(this.configPath)) as any;
    let trips = config.trips;
    if (q) { trips = trips.filter((t: any) => t.name.toLowerCase().includes(q.toLowerCase())); }
    const trip = trips.find((t: any) => t.name === name) || trips[Math.floor(Math.random() * trips.length)];
    if (!trip) { this.isScanning = false; return; }

    if (this.tripName && trip && this.tripName !== trip.name && !restored) { await purgeCacheKeepSettings(); }

    this.isScanning = true;
    this.scanPercent = 0;
    this.photoEntries = [];
    this.tripName = trip.name;
    // always clear state and cache on new selection to prevent stale data issues
    this.broadcast({ type: "CLEAR" });
    const currentGen = this.processor.setTrip(this.tripName);
    
    try {
        const out = join(BASE_CACHE_DIR, "status_frame.jpg");
        await new Deno.Command("magick", {
          args: ["-size", "1920x1080", "canvas:black", "-font", FONT_PATH, "-fill", "white", "-pointsize", "60", "-gravity", "north", 
            "-annotate", "+0+300", `Preparing Trip...\n${this.tripName}`, out],
        }).output();
    } catch (e) {}

    this.refresh();
    this.broadcastState();

    const tripPath = join(config.target, new Date(trip.start).getFullYear().toString(), trip.name);
    this.logger.info(`[Scanner] Folder: ${tripPath}`);

    const rawFiles: Record<string, string> = {};
    try {
      for (const e of Deno.readDirSync(tripPath)) {
        const ext = extname(e.name).toLowerCase();
        if (![".jpg", ".jpeg", ".png", ".dng", ".orf", ".nef", ".arw", ".heic"].includes(ext)) continue;
        const base = parsePath(e.name).name;
        const existingExt = rawFiles[base] ? extname(rawFiles[base]).toLowerCase() : null;
        if (!existingExt || (ext === ".jpg" || ext === ".jpeg")) { rawFiles[base] = join(tripPath, e.name); }
      }
    } catch {}

    const files = Object.values(rawFiles);
    // if (files.length === 0) {
    //   this.isScanning = false;
    //   try {
    //     const out = join(BASE_CACHE_DIR, "status_frame.jpg");
    //     await new Deno.Command("magick", {
    //       args: ["-size", "1920x1080", "canvas:black", "-font", FONT_PATH, "-fill", "white", "-pointsize", "60", "-gravity", "north", "-annotate", "+0+360", `Album Empty:\n${this.tripName}`, out],
    //     }).output();
    //   } catch (e) {}
    //   this.refresh();
    //   this.broadcastState();
    //   return;
    // }

    const metadata: any[] = [];
    for (let i = 0; i < files.length; i += 50) {
      if (currentGen !== this.processor["currentWorkerId"]) return;
      this.scanPercent = Math.round((i / files.length) * 100);
      this.broadcastState();
      const batch = files.slice(i, i + 50);
      const { stdout } = await new Deno.Command("exiftool", { args: ["-n", ...batch] }).output();
      const chunks = new TextDecoder().decode(stdout).trim().split(/={8}\s/);
      batch.forEach((p) => {
        const chunk = chunks.find((c) => c.includes(basename(p)));
        const rawExif: Record<string, string> = {};
        if (chunk) {
          chunk.split("\n").forEach((line) => {
            const colonIdx = line.indexOf(":");
            if (colonIdx !== -1) { rawExif[line.substring(0, colonIdx).trim()] = line.substring(colonIdx + 1).trim(); }
          });
        }
        const exif: Record<string, string> = {};
        const keepKeys = ["Date/Time Original", "Create Date", "Modify Date", "Focal Length In 35mm Format", "Focal Length 35mm Equiv"];
        keepKeys.forEach(k => { if (rawExif[k]) exif[k] = rawExif[k]; });

        const apKey = Object.keys(rawExif).find((k) => k.toLowerCase().includes("aperture") && !k.toLowerCase().includes("max"));
        exif["pc_aperture"] = apKey ? parseFloat(rawExif[apKey]).toFixed(1) : (rawExif["FNumber"] || "");
        const ssKey = Object.keys(rawExif).find((k) => k.toLowerCase().includes("shutter") && k.toLowerCase().includes("speed"));
        exif["pc_shutter"] = ssKey ? formatShutter(rawExif[ssKey]) : (rawExif["ExposureTime"] || "");
        exif["pc_iso"] = (rawExif["ISO"] || "").toString();

        const latVal = rawExif["GPS Latitude"] ? parseFloat(rawExif["GPS Latitude"]) : null;
        const lonVal = rawExif["GPS Longitude"] ? parseFloat(rawExif["GPS Longitude"]) : null;
        if (latVal !== null && lonVal !== null) {
          const latRef = rawExif["GPS Latitude Ref"] || (String(rawExif["GPS Latitude"]).includes("S") ? "S" : "N");
          const lonRef = rawExif["GPS Longitude Ref"] || (String(rawExif["GPS Longitude"]).includes("W") ? "W" : "E");
          exif["GPS Latitude"] = (latRef === "S" ? -Math.abs(latVal) : Math.abs(latVal)).toString();
          exif["GPS Longitude"] = (lonRef === "W" ? -Math.abs(lonVal) : Math.abs(lonVal)).toString();
        }
        metadata.push({ path: p, TS: (exif["Date/Time Original"] || exif["Create Date"] || "").toString(), exif });
      });
    }
    this.photoEntries = metadata.sort((a, b) => a.TS.localeCompare(b.TS));
    this.scanPercent = 100;
    this.isScanning = false;
    this.saveState();
    this.refresh();
    this.processor.runWorker(this.photoEntries, this.tripName, this.geo);
  }
  public async start(initialSearch?: string) {
    let restored = null;
    try { restored = JSON.parse(await Deno.readTextFile(STATE_FILE)); } catch {}
    await this.selectTrip(undefined, initialSearch, restored);
  }
}

const p = new Command();
p.option("-i, --ip <string>", "Cast IP", DEFAULT_SETTINGS.ip)
  .option("-p, --port <number>", "Local port", DEFAULT_SETTINGS.port.toString())
  .option("-y, --yaml <string>", "YAML", "./trips.yml")
  .option("-v, --verbose", "Debug", false)
  .option("-s, --search <string>", "Search")
  .option("--headless", "Headless background mode", false)
  .option("-c, --clear-cache", "Wipe Cache", false)
  .option("--html <string>", "HTML", "./photocast.html");

p.parse(process.argv);
const o = p.opts();

// --- BACKGROUND DAEMONIZER ---
if (o.headless && !Deno.env.get("PHOTOCAST_BACKGROUND")) {
  console.log("🚀 Spawning PhotoCast Pro in the background...");
  
  const execName = basename(Deno.execPath()).toLowerCase();
  const isCompiled = execName !== "deno" && execName !== "deno.exe";
  
  const args = isCompiled 
    ? [...Deno.args] 
    : ["run", "-A", import.meta.url, ...Deno.args];

  const child = new Deno.Command(Deno.execPath(), {
    args: args,
    stdin: "null",
    stdout: "null",
    stderr: "null",
    env: { PHOTOCAST_BACKGROUND: "1" }
  }).spawn();
  
  child.unref(); 
  console.log(`✅ Background process spawned (PID: ${child.pid}). You can close this terminal.`);
  console.log(`📝 Logs are being written to: /tmp/${USER}/photocast/photocast.log`);
  Deno.exit(0);
}
// -----------------------------

if (o.clearCache) {
  try { await purgeCacheKeepSettings(); console.log("Cache Wiped."); } catch {}
}
if (o.html) {
  try { await Deno.readTextFile(o.html); } catch (e: any) { console.error(`HTML file error: ${e.message}`); Deno.exit(1); }
}

const isRunningAsDaemon = !!Deno.env.get("PHOTOCAST_BACKGROUND");

new PhotoCastSystem(o.yaml, parseInt(o.port), o.verbose, isRunningAsDaemon, o.html).start(o.search);