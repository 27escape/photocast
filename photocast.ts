#!/usr/bin/env deno run -A
/**
 * PHOTOCAST - send local photo albums to a chromecast
 */

import { Application, Context, Router, RouterContext } from 'https://deno.land/x/oak@v12.6.1/mod.ts';
import castv2 from 'castv2-client';
import { Command } from 'commander';
import { parse as parseYaml } from 'https://deno.land/std@0.208.0/yaml/mod.ts';
import { basename, dirname, extname, isAbsolute, join, parse as parsePath } from 'https://deno.land/std@0.208.0/path/mod.ts';
import process from 'node:process';
import { logger, setLogFile, getLogFile, setLogLevel } from '../various_tools/lib/logger.ts';


const PROGRAM = 'photocast';
const VERSION = '1.1.0';
const DEFAULT_PORT = 7080 ;
const GOOGLE_CAST_PORT = 8009;

// Determine dynamic logfile path based on program name and system user
const USER = Deno.env.get('USER') || Deno.env.get('USERNAME') || 'unknown_user';

const { Client, DefaultMediaReceiver } = castv2;
// castv2-client's DefaultMediaReceiver normally exposes this as a static APP_ID,
// but that's worth double-checking against the installed version - falling back
// to the well-known literal keeps verifyStartupState() working either way.
const DEFAULT_MEDIA_RECEIVER_APP_ID: string = (DefaultMediaReceiver as unknown as { APP_ID?: string }).APP_ID ??
    'CC1AD845';

// Session/derived state that's small and worth surviving a reboot: resume
// position, settings, the geocode cache, the "Preparing Trip..." placeholder,
// and logs. None of it is expensive to regenerate, but there's no reason to
// lose it just because /tmp got cleared.
const XDG_CACHE_HOME = Deno.env.get('XDG_CACHE_HOME') || join(Deno.env.get('HOME') || `/tmp/${USER}`, '.cache');
const USER_CACHE_DIR = join(XDG_CACHE_HOME, 'photocast');
const STATE_FILE = join(USER_CACHE_DIR, 'state.json');
const SETTINGS_FILE = join(USER_CACHE_DIR, 'settings.json');
const GEO_CACHE_FILE = join(USER_CACHE_DIR, 'geo_cache.json');
const STATUS_FRAME_FILE = join(USER_CACHE_DIR, 'status_frame.jpg');
const LOG_FILE = join(USER_CACHE_DIR, PROGRAM);

// True scratch space: RAW-decode intermediates only (pre_*.jpg, raw_*.tiff),
// each living for the duration of a single process() call. Safe to lose at
// any time - nothing here needs to survive a reboot, so tmpfs speed is the
// right tradeoff. The default (non-persistent) view root also nests here.
const SCRATCH_DIR = `/tmp/${USER}/photocast`;

// Bump this whenever the magick pipeline (resize/sharpen/etc) changes, to force
// existing rendered images to be regenerated without touching the EXIF/scan
// cache or requiring a full directory rescan.
const RENDER_VERSION = 1;
const MANIFEST_SCHEMA_VERSION = 1;
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.dng', '.orf', '.nef', '.arw', '.heic'];
// Some post-processing tools (DxO PureRAW, Topaz Photo AI, and similar) export
// an edited JPG next to the original RAW using the same base name plus a
// suffix, e.g. PXL_20230907_085117282_DXO.jpg alongside
// PXL_20230907_085117282.dng. Stripping a known suffix before matching lets
// the edited JPG still be recognized as "the" photo for that base name, so
// the RAW gets skipped in its favor rather than both being kept as separate
// photos. Add more suffixes here as you run into other tools/exports.
const EDIT_SUFFIX_PATTERN = /[_-](dxo|topaz|edit(ed)?)$/i;

function canonicalPhotoBase(fileNameWithoutExt: string): string {
    return fileNameWithoutExt.replace(EDIT_SUFFIX_PATTERN, '');
}
// How long the background sweeper waits between full passes over all trips.
const SWEEP_IDLE_INTERVAL_MS = 30_000;
// A photo that fails this many times is left alone until a manual re-sweep
// (or a RENDER_VERSION bump) rather than retried every single pass forever.
const MAX_RENDER_ATTEMPTS = 3;
// How often the sweeper checks trips.yml for additions/removals.
const TRIPS_YAML_POLL_MS = 60_000;
// How long after any user-initiated navigation/selection the sweeper stays
// fully paused before resuming background work. Long enough to cover a burst
// of browsing/clicking without the sweeper jumping back in between clicks;
// short enough that it resumes promptly once things go quiet.
const INTERACTION_GRACE_MS = 15_000;
// Falls back to a tmp-backed location if --view-root isn't passed, so nothing
// changes unless the user opts into a persistent, SSD-backed view tree.
const DEFAULT_VIEW_ROOT = join(SCRATCH_DIR, 'view');
const FONT_PATH = '/System/Library/Fonts/Supplemental/Arial.ttf';
const DEFAULT_SETTINGS: Settings = { ip: '192.168.0.216', timeout: 30, port: DEFAULT_PORT };
const LOCAL_IP = Deno.networkInterfaces().find((i) => i.family === 'IPv4' && !i.address.startsWith('127.'))?.address ||
    'localhost';

// --------------------------------------------------------------------------
// type defs

type Settings = {
    ip: string;
    timeout: number;
    port: number;
};

type ExifData = {
    [key: string]: string | undefined;
    pc_aperture?: string;
    pc_shutter?: string;
    pc_iso?: string;
    pc_location?: string;
    'GPS Latitude'?: string;
    'GPS Longitude'?: string;
};

type PhotoEntry = {
    path: string;
    TS: string;
    exif: ExifData;
    viewFile: string; // basename of the rendered jpg inside the trip's manifest dir
    status: 'ready' | 'pending' | 'failed';
};

type TripItem = {
    name: string;
    start: string;
};

type TripConfig = {
    target: string;
    trips: TripItem[];
};

// A single photo's entry in a trip's persistent manifest. This is the
// long-lived, on-disk counterpart of PhotoEntry above; PhotoEntry is the
// in-memory, sorted-for-display view of the same data.
type ManifestPhoto = {
    sourceFile: string;
    sourceMtime: string;
    sourceSize: number;
    viewFile: string;
    ts: string;
    exif: ExifData;
    status: 'ready' | 'pending' | 'failed';
    attempts?: number;
};

type TripManifest = {
    schemaVersion: number;
    trip: { name: string; year: number; sourcePath: string };
    sourceFingerprint: { fileCount: number; maxMtime: string };
    scannedAt: string;
    renderVersion: number;
    photos: ManifestPhoto[];
};

// One entry in the top-level index.json registry - a cheap summary of a
// trip's sweep status, so the sweeper (and anything inspecting the view tree)
// doesn't need to open every trip's manifest just to see what still needs work.
type ViewIndexEntry = {
    tripName: string;
    year: number;
    manifestPath: string;
    photoCount: number;
    readyCount: number;
    status: 'ready' | 'partial' | 'unswept' | 'orphaned';
    lastSwept: string | null;
};

type ViewIndex = {
    schemaVersion: number;
    viewRoot: string;
    trips: Record<string, ViewIndexEntry>; // keyed by "<year>/<tripName>"
};

// Only the truly session-specific bits are restored across restarts now -
// the photo list, EXIF data, and render status all live in the trip's
// manifest and are reloaded from there via selectTrip().
type RestoredState = {
    tripName: string;
    currentIndex: number;
};

type CastStatus = 'OFF' | 'AVAILABLE' | 'ACTIVE' | 'OFFLINE';

type BroadcastMessage = {
    type: string;
    sessionId?: string;
    index?: number;
    timeRemaining?: number;
    isScanning?: boolean;
    isPaused?: boolean;
    trip?: string;
    total?: number;
    castStatus?: CastStatus;
    castForeignSession?: boolean;
    settings?: Settings;
    scanPercent?: number;
    files?: Record<number, string>;
    exifs?: Record<number, ExifData>;
    ready?: number[];
    [key: string]: unknown;
};

type CastPlayer = {
    load: (
        media: { contentId: string; contentType: string },
        options: { autoplay: boolean },
        callback: (err: Error | null) => void,
    ) => void;
};

type CastClient = {
    on: (event: string, listener: (err: Error) => void) => void;
    connect: (opts: { host: string; port: number }, callback: () => void) => void;
    launch: (
        receiver: typeof DefaultMediaReceiver,
        callback: (err: Error | null, player: CastPlayer) => void,
    ) => void;
    close: () => void;
};

// --------------------------------------------------------------------------
// deno oak causes lots of issues, lets catch and work around them
// GLOBAL DENO NOISE FILTER
const networkErrors = [
    'request closed',
    'Connection reset by peer',
    'Cannot read headers',
    'Broken pipe',
    'connection closed before message completed',
];

function isNoisy(msg: string) {
    return networkErrors.some((err) => msg?.includes(err));
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

let silencingOak = false;
const originalConsoleError = console.error;
console.error = (...args: Parameters<typeof console.error>) => {
    const msgStr = typeof args[0] === 'string' ? args[0] : '';
    const isErrorObj = args[0] instanceof Error;
    const directErrorMsg = isErrorObj ? args[0].message : '';
    const errStr = args[1] instanceof Error ? args[1].message : '';

    if (msgStr.includes('[uncaught application error]')) {
        if (isNoisy(msgStr) || isNoisy(errStr)) {
            silencingOak = true;
            return;
        }
    }
    if (silencingOak) {
        if (msgStr.includes('\nrequest:') || msgStr.includes('response:') || msgStr.includes('request:')) return;
        if (isErrorObj) {
            silencingOak = false;
            return;
        }
        if (isNoisy(msgStr)) return;
    }
    if (isErrorObj && isNoisy(directErrorMsg)) return;
    originalConsoleError(...args);
};

globalThis.addEventListener('unhandledrejection', (e) => {
    if (isNoisy(e.reason?.message || String(e.reason))) e.preventDefault();
});
globalThis.addEventListener('error', (e) => {
    if (isNoisy(e.error?.message || e.message)) e.preventDefault();
});

// --------------------------------------------------------------------------
// helpers

async function purgeCacheKeepSettings() {
    try {
        let settingsText = null;
        try {
            settingsText = Deno.readTextFileSync(SETTINGS_FILE);
        } catch {
            logger.warn('No existing settings found to preserve.');
        }
        await Deno.remove(USER_CACHE_DIR, { recursive: true }).catch(() => {
            logger.warn('User cache directory does not exist or could not be removed. Continuing with purge.');
        });
        await Deno.mkdir(USER_CACHE_DIR, { recursive: true }).catch(() => {
            logger.warn('Could not recreate user cache directory after purge. Some features may not work correctly.');
        });
        if (settingsText) await Deno.writeTextFile(SETTINGS_FILE, settingsText);

        // Also clears scratch space - RAW-decode leftovers, and (only if the
        // user hasn't pointed --view-root at a real persistent location) the
        // default ephemeral view tree that nests under here too. A custom
        // --view-root on the SSD lives entirely outside this directory, so
        // this never touches a real persistent view tree.
        await Deno.remove(SCRATCH_DIR, { recursive: true }).catch(() => {
            logger.warn('Scratch directory does not exist or could not be removed. Continuing with purge.');
        });
        await Deno.mkdir(SCRATCH_DIR, { recursive: true }).catch(() => {
            logger.warn('Could not recreate scratch directory after purge.');
        });
    } catch (e) {
        logger.info(`Purge error: ${getErrorMessage(e)}`);
    }
}

// True if this photo has GPS data but the location lookup never successfully
// resolved (either never attempted, or failed and should be retried later).
// An empty string is a genuine answer (geocoder reached, no city for that
// point) and does NOT count as needing another attempt.
function needsGeoLookup(exif: ExifData): boolean {
    return !!exif['GPS Latitude'] && !!exif['GPS Longitude'] && exif['pc_location'] === undefined;
}

// Some cameras/tools report Date/Time-style tags in a non-classic-EXIF form -
// notably Pixel phone DNGs, whose Date/Time Original often comes from
// embedded XMP rather than the classic EXIF block, and shows up as
// "2023-09-07 10:51:17.282491+02:00" (fractional seconds + timezone offset)
// instead of the standard EXIF "2023:09:07 10:51:17". Both are normalized
// down to the classic EXIF form - no fractional seconds, no timezone suffix -
// so display and sort order are consistent no matter which camera wrote the
// file. Unrecognized formats are left untouched rather than guessed at.
function normalizeExifTimestamp(raw: string): string {
    const match = raw.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!match) return raw;
    const [, y, mo, d, h, mi, s] = match;
    return `${y}:${mo}:${d} ${h}:${mi}:${s}`;
}

function formatShutter(ss: string): string {
    const val = parseFloat(ss);
    if (isNaN(val)) return ss;
    if (val >= 0.4) return val.toFixed(1) + 's';
    return '1/' + Math.round(1 / val);
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// Runs exiftool over `entries` in batches of 50, mutating each ManifestPhoto's
// `exif`/`ts` fields in place. Shared by selectTrip() (which reports progress
// to the UI) and the background sweeper (which doesn't need to). `onProgress`
// is optional; `shouldStop` lets a caller bail out mid-scan (trip switch,
// sweeper yielding) without losing whatever's already been parsed.
async function scanExifBatch(
    entries: ManifestPhoto[],
    tripPath: string,
    onProgress?: (pct: number) => void,
    shouldStop?: () => boolean,
): Promise<void> {
    for (let i = 0; i < entries.length; i += 50) {
        if (shouldStop?.()) return;
        onProgress?.(Math.round((i / entries.length) * 100));
        const batch = entries.slice(i, i + 50);
        const batchPaths = batch.map((p) => join(tripPath, p.sourceFile));
        const { stdout } = await new Deno.Command('exiftool', { args: ['-n', ...batchPaths] }).output();
        const chunks = new TextDecoder().decode(stdout).trim().split(/={8}\s/);
        batch.forEach((entry) => {
            const chunk = chunks.find((c) => c.includes(entry.sourceFile));
            const rawExif: Record<string, string> = {};
            if (chunk) {
                chunk.split('\n').forEach((line) => {
                    const colonIdx = line.indexOf(':');
                    if (colonIdx !== -1) {
                        rawExif[line.substring(0, colonIdx).trim()] = line.substring(colonIdx + 1).trim();
                    }
                });
            }
            const exif: ExifData = {};
            const keepKeys = [
                'Date/Time Original',
                'Create Date',
                'Modify Date',
                'Focal Length In 35mm Format',
                'Focal Length 35mm Equiv',
            ];
            keepKeys.forEach((k) => {
                if (rawExif[k]) exif[k] = rawExif[k];
            });
            // Applied only to the date-like keys - aperture/shutter/etc above
            // aren't timestamps and shouldn't go through this.
            (['Date/Time Original', 'Create Date', 'Modify Date'] as const).forEach((k) => {
                if (exif[k]) exif[k] = normalizeExifTimestamp(exif[k]!);
            });

            const apKey = Object.keys(rawExif).find((k) =>
                k.toLowerCase().includes('aperture') && !k.toLowerCase().includes('max')
            );
            exif['pc_aperture'] = apKey ? parseFloat(rawExif[apKey]).toFixed(1) : (rawExif['FNumber'] || '');
            const ssKey = Object.keys(rawExif).find((k) =>
                k.toLowerCase().includes('shutter') && k.toLowerCase().includes('speed')
            );
            exif['pc_shutter'] = ssKey ? formatShutter(rawExif[ssKey]) : (rawExif['ExposureTime'] || '');
            exif['pc_iso'] = (rawExif['ISO'] || '').toString();

            const latVal = rawExif['GPS Latitude'] ? parseFloat(rawExif['GPS Latitude']) : null;
            const lonVal = rawExif['GPS Longitude'] ? parseFloat(rawExif['GPS Longitude']) : null;
            if (latVal !== null && lonVal !== null) {
                const latRef = rawExif['GPS Latitude Ref'] ||
                    (String(rawExif['GPS Latitude']).includes('S') ? 'S' : 'N');
                const lonRef = rawExif['GPS Longitude Ref'] ||
                    (String(rawExif['GPS Longitude']).includes('W') ? 'W' : 'E');
                exif['GPS Latitude'] = (latRef === 'S' ? -Math.abs(latVal) : Math.abs(latVal)).toString();
                exif['GPS Longitude'] = (lonRef === 'W' ? -Math.abs(lonVal) : Math.abs(lonVal)).toString();
            }
            // Mutates the same ManifestPhoto object held in the caller's
            // manifest.photos array, so no separate write-back is needed.
            entry.exif = exif;
            entry.ts = (exif['Date/Time Original'] || exif['Create Date'] || '').toString();
        });
    }
}

// --------------------------------------------------------------------------

class CastManager {
    private client: CastClient | null = null;
    private player: CastPlayer | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    public status: CastStatus = 'OFF';
    public ip: string | null = null;
    public connected = false;
    // True if, on last check, the device was running a session we did not launch
    // (another sender's app, or a DefaultMediaReceiver session left over from a
    // previous crashed instance of this program). We never assume ownership of
    // a session we didn't observe ourselves launching.
    public foreignSession = false;

    constructor(ip: string | null, private onStatusChange: () => void) {
        this.ip = ip;
        this.startHeartbeat();
    }

    updateIp(newIp: string) {
        logger.info(`[Cast] IP updated to ${newIp}`);
        this.ip = newIp;
        this.dispose();
        this.startHeartbeat();
    }

    private startHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(async () => {
            if (this.status === 'ACTIVE') return;
            const up = await this.probe();
            const newStatus = up ? 'AVAILABLE' : 'OFF';
            if (this.status !== newStatus) {
                logger.info(`[Cast] Heartbeat status change: ${this.status} -> ${newStatus}`);
                this.status = newStatus;
                this.onStatusChange();
            }
        }, 5000);
    }

    private async probe(): Promise<boolean> {
        if (!this.ip) return false;
        try {
            const conn = await Deno.connect({ hostname: this.ip, port: GOOGLE_CAST_PORT, transport: 'tcp' });
            conn.close();
            return true;
        } catch {
            return false;
        }
    }

    // Opens a short-lived connection purely to ask the device what it's
    // actually running right now. Unlike `probe()` (which only checks that
    // GOOGLE_CAST_PORT is open), this uses the CASTV2 receiver channel's
    // getStatus() to see the real application/session state - the only way
    // to know if the device is idle, running our own app, or busy with
    // something else (another sender, or a session orphaned by a crash of
    // a previous instance of this program).
    private probeStatus(): Promise<{ appId: string | null; sessionId: string | null } | null> {
        const ip = this.ip;
        if (!ip) return Promise.resolve(null);

        return new Promise((resolve) => {
            const probeClient = new Client();
            let settled = false;
            const finish = (result: { appId: string | null; sessionId: string | null } | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutHandle);
                try {
                    probeClient.close();
                } catch {
                    // already closed / never connected
                }
                resolve(result);
            };

            const timeoutHandle = setTimeout(() => {
                logger.warn('[Cast] Status probe timed out.');
                finish(null);
            }, 4000);

            probeClient.on('error', (err: Error) => {
                logger.debug(`[Cast] Status probe connection error: ${getErrorMessage(err)}`);
                finish(null);
            });

            probeClient.connect({ host: ip, port: GOOGLE_CAST_PORT }, () => {
                probeClient.getStatus((err: Error | null, status: { applications?: Array<{ appId?: string; sessionId?: string }> }) => {
                    if (err || !status) {
                        logger.debug(`[Cast] getStatus failed: ${err ? getErrorMessage(err) : 'no status returned'}`);
                        return finish(null);
                    }
                    const app = status.applications?.[0];
                    finish({ appId: app?.appId ?? null, sessionId: app?.sessionId ?? null });
                });
            });
        });
    }

    // Call once at startup (and any time we need to re-establish ground truth,
    // e.g. after this process itself was restarted) before assuming anything
    // about the device's state. A saved settings.ip or a previous in-memory
    // `status` value only tells us what we last *asked for* - it says nothing
    // about what actually happened afterward: the device could have been power
    // cycled, taken over by another Cast sender in the house, or left mid-session
    // by a crashed prior run of this same program.
    async verifyStartupState(): Promise<'idle' | 'ours' | 'foreign' | 'unreachable'> {
        const result = await this.probeStatus();

        if (!result) {
            logger.info('[Cast] Startup check: device unreachable.');
            this.status = 'OFF';
            this.foreignSession = false;
            return 'unreachable';
        }

        if (!result.appId) {
            logger.info('[Cast] Startup check: device idle, no application running.');
            this.status = 'AVAILABLE';
            this.foreignSession = false;
            return 'idle';
        }

        if (result.appId === DEFAULT_MEDIA_RECEIVER_APP_ID) {
            // A DefaultMediaReceiver session is already live. We did not launch it
            // in this process, so we don't know if it's healthy or stale - we
            // deliberately do NOT auto-attach/join it. Surfacing it as active lets
            // the UI reflect reality; the user can still explicitly toggle casting,
            // which will launch a fresh session on top of it.
            logger.info(`[Cast] Startup check: found an existing DefaultMediaReceiver session (${result.sessionId}).`);
            this.status = 'ACTIVE';
            this.foreignSession = false;
            return 'ours';
        }

        logger.info(`[Cast] Startup check: device busy with a different application (${result.appId}).`);
        this.status = 'ACTIVE';
        this.foreignSession = true;
        return 'foreign';
    }

    // deno-lint-ignore require-await
    async connect(): Promise<boolean> {
        const ip = this.ip;
        if (!ip) return false;
        if (this.player && this.connected && this.status === 'ACTIVE') return true;

        // verifyStartupState() only ran once, at process start - by the time
        // a later /toggle-cast happens, hours could have passed and someone
        // else could be using the device. This won't stop an explicit user
        // action from taking over (that's normal Chromecast behavior - any
        // sender app does this), but it keeps `foreignSession` truthful for
        // the UI instead of only being accurate in the first few seconds.
        const status = await this.probeStatus();
        if (status?.appId && status.appId !== DEFAULT_MEDIA_RECEIVER_APP_ID) {
            logger.warn(`[Cast] Taking over from a different application (${status.appId}) already running on the device.`);
            this.foreignSession = true;
        } else {
            this.foreignSession = false;
        }

        return new Promise((resolve) => {
            logger.info(`[Cast] Attempting manual connection to ${ip}...`);
            this.client = new Client();

            const client = this.client!;
            client.on('error', (err: Error) => {
                logger.error(`[Cast] Client error event: ${getErrorMessage(err)}`);
                this.dispose('OFFLINE');
                resolve(false);
            });

            client.connect({ host: ip, port: 8009 }, () => {
                client.launch(DefaultMediaReceiver, (err: Error | null, player: CastPlayer) => {
                    if (err) {
                        logger.error(`[Cast] Launch failed: ${err?.message || err}`);
                        this.dispose('OFFLINE');
                        resolve(false);
                    } else {
                        this.player = player;
                        this.connected = true;
                        logger.info(`[Cast] Connected successfully. Status: ${this.status} -> ACTIVE`);
                        this.status = 'ACTIVE';
                        this.onStatusChange();
                        resolve(true);
                    }
                });
            });
        });
    }

    load(url: string) {
        if (this.player) {
            logger.debug(`[Cast] Loading image onto receiver: ${url}`);
            this.player.load({ contentId: url, contentType: 'image/jpeg' }, { autoplay: true }, (err: Error | null) => {
                if (err) logger.error(`[Cast] Player load error: ${err?.message || err}`);
            });
        }
    }

    dispose(forceStatus: 'OFF' | 'OFFLINE' = 'OFF') {
        try {
            if (this.client) this.client.close();
        } catch {
            logger.warn('Could not close client connection.');
        }
        this.client = this.player = null;
        this.connected = false;

        if (this.status !== forceStatus) {
            logger.info(`[Cast] Connection closed. Status: ${this.status} -> ${forceStatus}`);
            this.status = forceStatus;
        }
        this.onStatusChange();
    }
}

// --------------------------------------------------------------------------

class GeoProxy {
    private cache: Record<string, string> = {};
    // Coordinates that failed this run - not persisted, so a transient outage
    // or rate limit doesn't get "cached" forever; it'll be retried on the next
    // run/sweep. This just stops it from being retried on every single photo
    // within the *current* run once it's already failed once.
    private failedThisSession = new Set<string>();
    private lastRequestTime = 0;
    constructor() {
        try {
            this.cache = JSON.parse(Deno.readTextFileSync(GEO_CACHE_FILE));
        } catch {
            this.cache = {};
        }
    }

    // Returns the resolved city (possibly an empty string - a real "no city
    // found here" answer, e.g. open ocean or remote wilderness), or null if
    // the lookup itself failed (network error, rate limit, bad response) and
    // should be retried later rather than treated as a final answer.
    async getCity(lat: string, lon: string): Promise<string | null> {
        if (!lat || !lon) return '';
        // Rounded to ~3 decimal places (~111m) - far more precision than a
        // city-level lookup needs, and it collapses the many near-identical
        // GPS points a single walk through a city produces into one cached
        // request instead of one per photo.
        const key = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
        if (key in this.cache) return this.cache[key];
        if (this.failedThisSession.has(key)) return null;

        const now = Date.now();
        const wait = Math.max(0, 1100 - (now - this.lastRequestTime));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        // Set before the request, not just on success, so a failed/slow
        // request still counts against the throttle window for the next call.
        this.lastRequestTime = Date.now();
        try {
            const r = await fetch(
                `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=14`,
                { headers: { 'User-Agent': `photocast/${VERSION}` } },
            );
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            const loc = d.address?.city || d.address?.town || d.address?.village || '';
            this.cache[key] = loc;
            try {
                Deno.writeTextFileSync(GEO_CACHE_FILE, JSON.stringify(this.cache));
            } catch (e) {
                logger.warn(`Could not persist geo cache: ${getErrorMessage(e)}`);
            }
            return loc;
        } catch (e) {
            logger.warn(`Failed to fetch location data: ${getErrorMessage(e)}`);
            this.failedThisSession.add(key);
            return null;
        }
    }
}

// --------------------------------------------------------------------------

// Owns one trip's persistent state on the view-tree SSD: its manifest.json
// (EXIF + render status per photo) and the directory the rendered jpgs live
// in. Reconciliation is deliberately split into cheap and expensive layers:
// a fingerprint check first (fast, no exiftool), then a per-file diff only if
// that fails, so re-selecting an already-swept trip costs one directory
// listing, not a full rescan.
class ManifestStore {
    public manifest: TripManifest | null = null;
    public readonly dir: string;
    private readonly manifestPath: string;

    constructor(
        viewRoot: string,
        public readonly year: number,
        public readonly tripName: string,
        public readonly sourcePath: string,
    ) {
        this.dir = join(viewRoot, String(year), tripName);
        this.manifestPath = join(this.dir, 'manifest.json');
    }

    private async load(): Promise<TripManifest | null> {
        try {
            const raw = JSON.parse(await Deno.readTextFile(this.manifestPath)) as TripManifest;
            if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
                logger.warn(`[Manifest] ${this.tripName}: schema version mismatch, treating as unscanned.`);
                return null;
            }
            return raw;
        } catch {
            return null; // missing or corrupt - either way, treat as never scanned
        }
    }

    async save(): Promise<void> {
        if (!this.manifest) return;
        try {
            await Deno.mkdir(this.dir, { recursive: true });
            const tmpPath = `${this.manifestPath}.tmp`;
            await Deno.writeTextFile(tmpPath, JSON.stringify(this.manifest, null, 2));
            await Deno.rename(tmpPath, this.manifestPath); // atomic - never leaves a half-written manifest
        } catch (e) {
            logger.error(`[Manifest] ${this.tripName}: failed to save manifest: ${getErrorMessage(e)}`);
        }
    }

    // One entry per canonical base name. Priority: an edited JPG variant
    // (matched via canonicalPhotoBase, e.g. "_DXO"/"_topaz") beats a plain
    // JPG/JPEG of the same base, which beats a RAW sibling. This means a RAW
    // file is skipped not just when an exact-name JPG exists (the original
    // rule) but also when a differently-named edited export of it exists.
    private static async listSourceFiles(
        tripPath: string,
    ): Promise<{ name: string; path: string; mtimeIso: string; size: number }[]> {
        type Candidate = { name: string; ext: string; isEdited: boolean };
        const byBase = new Map<string, Candidate>();
        const priority = (c: Candidate) => c.isEdited ? 3 : (c.ext === '.jpg' || c.ext === '.jpeg') ? 2 : 1;

        for (const e of Deno.readDirSync(tripPath)) {
            const ext = extname(e.name).toLowerCase();
            if (!PHOTO_EXTENSIONS.includes(ext)) continue;
            const rawName = parsePath(e.name).name;
            const base = canonicalPhotoBase(rawName);
            const isJpg = ext === '.jpg' || ext === '.jpeg';
            const candidate: Candidate = { name: e.name, ext, isEdited: isJpg && rawName !== base };

            const existing = byBase.get(base);
            if (!existing || priority(candidate) > priority(existing)) {
                byBase.set(base, candidate);
            }
        }

        const out: { name: string; path: string; mtimeIso: string; size: number }[] = [];
        for (const c of byBase.values()) {
            const p = join(tripPath, c.name);
            const stat = await Deno.stat(p);
            out.push({
                name: basename(p),
                path: p,
                mtimeIso: (stat.mtime ?? new Date(0)).toISOString(),
                size: stat.size,
            });
        }
        return out;
    }

    // Reconciles the manifest against what's actually on disk. Returns the
    // photos that need a fresh EXIF scan (new or changed files) - the caller
    // runs exiftool only on that subset, not the whole trip.
    async reconcile(tripPath: string): Promise<{ needsScan: ManifestPhoto[] }> {
        const files = await ManifestStore.listSourceFiles(tripPath);
        const maxMtime = files.reduce((max, f) => (f.mtimeIso > max ? f.mtimeIso : max), '');
        const fingerprint = { fileCount: files.length, maxMtime };

        const existing = this.manifest ?? await this.load();

        const fingerprintMatches = existing !== null &&
            existing.sourceFingerprint.fileCount === fingerprint.fileCount &&
            existing.sourceFingerprint.maxMtime === fingerprint.maxMtime;

        if (fingerprintMatches && existing) {
            logger.debug(`[Manifest] ${this.tripName}: fingerprint unchanged (${files.length} files), skipping scan.`);
            this.manifest = existing;
            this.applyRenderVersionBump();
            return { needsScan: [] };
        }

        // Fingerprint mismatch (or no prior manifest): diff file-by-file. This
        // still costs only a directory listing plus a per-file stat - exiftool
        // is reserved for entries that are actually new or changed.
        const bySource = new Map((existing?.photos ?? []).map((p) => [p.sourceFile, p]));
        const seen = new Set<string>();
        const nextPhotos: ManifestPhoto[] = [];
        const needsScan: ManifestPhoto[] = [];

        for (const f of files) {
            seen.add(f.name);
            const prior = bySource.get(f.name);
            if (prior && prior.sourceMtime === f.mtimeIso && prior.sourceSize === f.size) {
                nextPhotos.push(prior); // untouched since last scan - trust its EXIF and status
                continue;
            }
            const entry: ManifestPhoto = {
                sourceFile: f.name,
                sourceMtime: f.mtimeIso,
                sourceSize: f.size,
                viewFile: `${parsePath(f.name).name}.jpg`,
                ts: '',
                exif: {},
                status: 'pending',
            };
            nextPhotos.push(entry);
            needsScan.push(entry);
        }

        for (const [name, prior] of bySource) {
            if (seen.has(name)) continue; // removed from the source directory
            logger.info(`[Manifest] ${this.tripName}: ${name} no longer present, dropping from view tree.`);
            Deno.remove(join(this.dir, prior.viewFile)).catch(() => {
                // already gone, or never rendered - either way, nothing to clean up
            });
        }

        this.manifest = {
            schemaVersion: MANIFEST_SCHEMA_VERSION,
            trip: { name: this.tripName, year: this.year, sourcePath: this.sourcePath },
            sourceFingerprint: fingerprint,
            scannedAt: new Date().toISOString(),
            renderVersion: existing?.renderVersion ?? RENDER_VERSION,
            photos: nextPhotos,
        };
        this.applyRenderVersionBump();
        await this.save();
        logger.info(`[Manifest] ${this.tripName}: ${needsScan.length} new/changed of ${files.length} total files.`);
        return { needsScan };
    }

    // A code-level pipeline change (RENDER_VERSION bump) invalidates rendered
    // images only - not EXIF data. Applied once per reconcile as a one-shot
    // transition so in-progress re-rendering isn't re-triggered every sweep.
    private applyRenderVersionBump() {
        if (!this.manifest) return;
        if (this.manifest.renderVersion !== RENDER_VERSION) {
            logger.info(
                `[Manifest] ${this.tripName}: render pipeline changed (v${this.manifest.renderVersion} -> v${RENDER_VERSION}), marking all photos for re-render.`,
            );
            for (const p of this.manifest.photos) p.status = 'pending';
            this.manifest.renderVersion = RENDER_VERSION;
        }
    }

    // "Needing work" now covers two cases: not yet rendered, or rendered but
    // still missing a location that a previous attempt failed to resolve.
    // process() itself is cheap for the latter (cache-hit branch, no
    // re-render) - this just makes sure it actually gets called again.
    photosNeedingRender(): ManifestPhoto[] {
        return this.manifest?.photos.filter((p) => p.status !== 'ready' || needsGeoLookup(p.exif)) ?? [];
    }

    markReady(sourceFile: string) {
        const entry = this.manifest?.photos.find((p) => p.sourceFile === sourceFile);
        if (entry) entry.status = 'ready';
    }

    markFailed(sourceFile: string) {
        const entry = this.manifest?.photos.find((p) => p.sourceFile === sourceFile);
        if (entry) {
            entry.status = 'failed';
            entry.attempts = (entry.attempts ?? 0) + 1;
        }
    }
}

// --------------------------------------------------------------------------

// Owns the top-level index.json at the view root: a cheap, whole-library
// summary the background sweeper (and anything else inspecting the view tree)
// can read in one file instead of opening every trip's manifest to see what
// still needs work.
class ViewIndexStore {
    private index: ViewIndex | null = null;
    private readonly path: string;

    constructor(private viewRoot: string) {
        this.path = join(viewRoot, 'index.json');
    }

    async load(): Promise<ViewIndex> {
        if (this.index) return this.index;
        try {
            const raw = JSON.parse(await Deno.readTextFile(this.path)) as ViewIndex;
            this.index = raw.schemaVersion === MANIFEST_SCHEMA_VERSION
                ? raw
                : { schemaVersion: MANIFEST_SCHEMA_VERSION, viewRoot: this.viewRoot, trips: {} };
        } catch {
            this.index = { schemaVersion: MANIFEST_SCHEMA_VERSION, viewRoot: this.viewRoot, trips: {} };
        }
        return this.index;
    }

    async save(): Promise<void> {
        if (!this.index) return;
        try {
            await Deno.mkdir(this.viewRoot, { recursive: true });
            const tmpPath = `${this.path}.tmp`;
            await Deno.writeTextFile(tmpPath, JSON.stringify(this.index, null, 2));
            await Deno.rename(tmpPath, this.path);
        } catch (e) {
            logger.error(`[Index] Failed to save index.json: ${getErrorMessage(e)}`);
        }
    }

    // Adds any trip from trips.yml not yet tracked (as 'unswept'), and flags
    // entries whose trip no longer exists in config as 'orphaned' - it never
    // deletes their view-tree folder automatically. An orphaned trip that
    // reappears (e.g. a rename reverted) is un-flagged rather than re-added.
    async reconcileWithConfig(config: TripConfig): Promise<void> {
        const index = await this.load();
        const validKeys = new Set<string>();
        for (const t of config.trips) {
            const year = new Date(t.start).getFullYear();
            const key = `${year}/${t.name}`;
            validKeys.add(key);
            const existing = index.trips[key];
            if (!existing) {
                index.trips[key] = {
                    tripName: t.name,
                    year,
                    manifestPath: join(String(year), t.name, 'manifest.json'),
                    photoCount: 0,
                    readyCount: 0,
                    status: 'unswept',
                    lastSwept: null,
                };
            } else if (existing.status === 'orphaned') {
                logger.info(`[Index] ${key} reappeared in trips.yml, un-orphaning.`);
                existing.status = existing.readyCount >= existing.photoCount && existing.photoCount > 0
                    ? 'ready'
                    : 'unswept';
            }
        }
        for (const [key, entry] of Object.entries(index.trips)) {
            if (!validKeys.has(key) && entry.status !== 'orphaned') {
                logger.info(`[Index] ${key} no longer in trips.yml - flagging orphaned (view tree left untouched).`);
                entry.status = 'orphaned';
            }
        }
        await this.save();
    }

    async updateTrip(key: string, patch: ViewIndexEntry): Promise<void> {
        const index = await this.load();
        index.trips[key] = patch;
        await this.save();
    }

    // Trips still needing work, oldest-swept-first (never-swept first), skipping
    // anything already fully rendered or flagged orphaned.
    async pendingTrips(): Promise<{ key: string; name: string; year: number }[]> {
        const index = await this.load();
        return Object.entries(index.trips)
            .filter(([, e]) => e.status !== 'ready' && e.status !== 'orphaned')
            .sort(([, a], [, b]) => (a.lastSwept ?? '').localeCompare(b.lastSwept ?? ''))
            .map(([key, e]) => ({ key, name: e.tripName, year: e.year }));
    }
}

// --------------------------------------------------------------------------

// JpgFromRaw is only reliably present on a handful of formats (notably Nikon
// NEF, Pentax PEF) - trying it first on formats that never have it (Olympus
// ORF, Adobe DNG including phone-camera motion-photo DNGs) means every single
// one of those files pays for a full exiftool subprocess spawn that's
// guaranteed to fail before falling through to the tag that actually works.
// Worth re-tuning this against what you actually see in your own logs across
// camera models/firmware - exiftool tag availability isn't perfectly uniform
// even within a format.
const RAW_PREVIEW_TAG_ORDER: Record<string, string[]> = {
    '.orf': ['-PreviewImage', '-ThumbnailImage'],
    '.dng': ['-PreviewImage', '-JpgFromRaw', '-ThumbnailImage'],
    '.nef': ['-JpgFromRaw', '-PreviewImage', '-ThumbnailImage'],
    '.pef': ['-JpgFromRaw', '-PreviewImage', '-ThumbnailImage'],
};
const DEFAULT_PREVIEW_TAG_ORDER = ['-JpgFromRaw', '-PreviewImage', '-ThumbnailImage'];

class ImageProcessor {
    private currentWorkerId = 0;
    public readyMap = new Set<number>();
    get generation(): number {
        return this.currentWorkerId;
    }
    constructor(private tempDir: string, private onReady: (idx: number) => void) {
        try {
            Deno.mkdirSync(tempDir, { recursive: true });
        } catch {
            logger.warn('Could not create temp directory for image processing. Some features may not work correctly.');
        }
    }
    setTrip(name: string) {
        this.currentWorkerId++;
        this.readyMap.clear();
        return this.currentWorkerId;
    }

    private async tryExtract(p: string, v: string, gen: number): Promise<boolean> {
        if (gen !== this.currentWorkerId) return false;
        const tags = RAW_PREVIEW_TAG_ORDER[extname(p).toLowerCase()] ?? DEFAULT_PREVIEW_TAG_ORDER;
        for (const tag of tags) {
            await new Deno.Command('exiftool', { args: ['-quiet', '-m', '-b', tag, '-W', v, p] }).output();
            try {
                const stat = await Deno.stat(v);
                if (stat.isFile && stat.size > 5000) {
                    const f = await Deno.open(v, { read: true });
                    const header = new Uint8Array(2);
                    await f.read(header);
                    f.close();
                    if (header[0] === 0xFF && header[1] === 0xD8) {
                        const { stdout } = await new Deno.Command('magick', { args: ['identify', '-format', '%w', v] })
                            .output();
                        const width = parseInt(new TextDecoder().decode(stdout)) || 0;

                        if (width >= 1000) {
                            await new Deno.Command('exiftool', {
                                args: ['-quiet', '-overwrite_original', '-TagsFromFile', p, '-Orientation', v],
                            }).output();
                            logger.debug(`[Processor] Extracted high-res preview (${width}px) using ${tag} from ${p}`);
                            return true;
                        } else {
                            logger.debug(`[Processor] Preview from ${tag} too small (${width}px). Discarding ${p}.`);
                            await Deno.remove(v);
                        }
                    } else await Deno.remove(v);
                }
            } catch {
                logger.debug(`Could not process image. ${basename(p)}`);
            }
        }
        return false;
    }

    async process(path: string, outPath: string, scratchKey: string, exif: ExifData, gen: number, geo: GeoProxy): Promise<boolean> {
        if (gen !== this.currentWorkerId) return false;
        let cacheHit = false;
        try {
            const stats = await Deno.stat(outPath);
            if (stats.isFile && stats.size > 0) {
                logger.debug(`[Cache Hit] ${basename(outPath)}`);
                cacheHit = true;
            }
        } catch {
            logger.debug(`[Cache Miss] ${basename(outPath)}`);
        }

        if (!cacheHit) {
            try {
                logger.debug(`[Processor] Cache Miss: Generating ${basename(outPath)} (${basename(path)})...`);
                let input = path;
                const scratch = join(this.tempDir, `pre_${scratchKey}.jpg`);
                let scratchRaw = join(this.tempDir, `raw_${scratchKey}.tiff`);
                let cleanupRaw = false;
                let rawDeveloped = false;
                let shouldProcess = true;

                if (['.nef', '.orf', '.dng', '.arw', '.heic'].includes(extname(path).toLowerCase())) {
                    if (await this.tryExtract(path, scratch, gen)) {
                        input = scratch;
                    } else {
                        const tools = ['dcraw', 'dcraw_emu'];
                        for (const tool of tools) {
                            if (rawDeveloped) break;
                            try {
                                logger.debug(`[Processor] Attempting RAW decode with ${tool}...`);
                                const rawCmd = new Deno.Command(tool, { args: ['-c', '-w', '-T', path] });
                                const { code, stdout } = await rawCmd.output();
                                if (code === 0 && stdout.length > 5000) {
                                    await Deno.writeFile(scratchRaw, stdout);
                                    input = scratchRaw;
                                    cleanupRaw = true;
                                    rawDeveloped = true;
                                    logger.debug(`[Processor] Successfully decoded RAW with libraw (${tool})`);
                                }
                            } catch (e) {
                                logger.debug(`[Processor] Failed to decode RAW with ${tool}`);
                            }
                        }
                        if (!rawDeveloped && Deno.build.os === 'darwin') {
                            try {
                                logger.debug(`[Processor] Attempting RAW decode with macOS native sips...`);
                                scratchRaw = join(this.tempDir, `raw_${scratchKey}.jpg`);
                                const sipsCmd = new Deno.Command('sips', {
                                    args: ['-s', 'format', 'jpeg', '-Z', '1920', path, '--out', scratchRaw],
                                });
                                const { code } = await sipsCmd.output();
                                if (code === 0) {
                                    input = scratchRaw;
                                    cleanupRaw = true;
                                    rawDeveloped = true;
                                    logger.debug(`[Processor] Successfully decoded RAW with macOS sips`);
                                }
                            } catch (e) {
                                logger.debug(`[Processor] Failed to decode RAW with macOS sips`);
                            }
                        }
                        if (!rawDeveloped) {
                            logger.error(
                                `[Processor] Skipping ${basename(path)}: No valid image format could be extracted.`,
                            );
                            shouldProcess = false;
                        }
                    }
                }

                if (!shouldProcess) return false;

                await Deno.mkdir(dirname(outPath), { recursive: true });

                const magickArgs = [
                    input,
                    '-auto-orient',
                    '-modulate',
                    '100,110',
                    '-contrast-stretch',
                    '0.5%x0.5%',
                    '-unsharp',
                    '0x0.75+0.75+0.008',
                    '-resize',
                    '1920x1080>',
                    '-strip',
                    outPath,
                ];

                if (!rawDeveloped) magickArgs.unshift('-define', 'delegate:disable=darktable');

                const cmd = new Deno.Command('magick', { args: magickArgs });
                const out = await cmd.output();
                if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));

                if (cleanupRaw) {
                    try {
                        await Deno.remove(input);
                    } catch {
                        logger.debug(`[Processor] Failed to remove temporary RAW file: ${input}`);
                    }
                }
                try {
                    await Deno.remove(scratch);
                } catch {
                    logger.debug(`[Processor] Failed to remove temporary scratch file: ${scratch}`);
                }

                logger.debug(`[Processor] Magick finished: ${basename(outPath)}`);
            } catch (e) {
                logger.error(`[Processor] ${basename(outPath)} failed: ${getErrorMessage(e)}`);
                return false;
            }
        }

        // Runs on both a fresh render AND a cache hit - deliberately not gated
        // on `!cacheHit`. Otherwise, a photo whose geo lookup failed on first
        // render (rate limit, network blip) would sit there missing its
        // location caption forever, since every future selection/sweep would
        // just hit the cache-hit branch above and never look at geo again.
        // `pc_location === undefined` means "never successfully resolved" -
        // an empty string is a real answer (the geocoder was reached and
        // genuinely has no city for that point) and is left alone.
        if (exif['GPS Latitude'] && exif['GPS Longitude'] && exif['pc_location'] === undefined) {
            const loc = await geo.getCity(exif['GPS Latitude'], exif['GPS Longitude']);
            if (loc !== null) exif['pc_location'] = loc;
        }

        return true;
    }

    // Renders every photo the manifest still considers not-ready, updating and
    // periodically saving the manifest as it goes so an interrupted run (crash,
    // trip switch) can resume from wherever it left off rather than restarting.
    // `photos` is the display-ordered list (already sorted by TS); `entries` is
    // the manifest's own list, kept in sync so status changes persist.
    async runWorker(photos: PhotoEntry[], tripName: string, manifest: ManifestStore, geo: GeoProxy) {
        const gen = this.currentWorkerId;
        logger.info(`[Worker] Starting background processing for ${tripName} (${photos.length} items)`);
        let sinceSave = 0;
        for (let i = 0; i < photos.length; i++) {
            if (gen !== this.currentWorkerId) return;
            const entry = photos[i];
            if (entry.status === 'ready' && !needsGeoLookup(entry.exif)) {
                this.readyMap.add(i);
                continue;
            }
            const outPath = join(manifest.dir, entry.viewFile);
            const scratchKey = parsePath(entry.viewFile).name.replace(/[^a-z0-9]/gi, '_');
            const ok = await this.process(entry.path, outPath, scratchKey, entry.exif, gen, geo);
            if (gen !== this.currentWorkerId) return;
            if (ok) {
                entry.status = 'ready';
                manifest.markReady(basename(entry.path));
                this.readyMap.add(i);
                this.onReady(i);
            } else {
                entry.status = 'failed';
                manifest.markFailed(basename(entry.path));
            }
            if (++sinceSave >= 10) {
                sinceSave = 0;
                await manifest.save();
            }
        }
        await manifest.save();
        this.onReady(-1);
    }

    async generateStatusImg(text: string): Promise<Uint8Array | null> {
        const out = STATUS_FRAME_FILE;
        await new Deno.Command('magick', {
            args: [
                '-size',
                '1920x1080',
                'canvas:black',
                '-font',
                FONT_PATH,
                '-fill',
                'white',
                '-pointsize',
                '60',
                '-gravity',
                'north',
                '-annotate',
                '+0+360',
                text,
                out,
            ],
        }).output();
        try {
            return await Deno.readFile(out);
        } catch {
            return null;
        }
    }
}

// --------------------------------------------------------------------------

// Continuously sweeps every configured trip in the background, rendering
// anything the manifest still considers not-ready, so switching to an
// already-swept trip in the UI costs nothing beyond a fingerprint check.
//
// This is deliberately a *separate* ImageProcessor instance from the
// interactive one PhotoCastSystem uses for the currently-selected trip. The
// two need independent cancellation semantics: the interactive worker is
// cancelled by bumping its generation counter every time the user switches
// trips, but the sweeper never gets "cancelled" that way - it just yields
// temporarily (checked between photos, not between trips) and resumes later
// exactly where it left off. Giving it its own instance means its generation
// counter can simply stay fixed forever, and yielding is handled entirely by
// the checks in sweepPass()/sweepTrip() instead.
//
// To avoid racing the interactive worker on the same files, the sweeper
// simply skips whatever trip is currently selected - the interactive worker
// is already handling that one.
class BackgroundSweeper {
    private processor: ImageProcessor;
    private stopRequested = false;
    private tripsConfig: TripConfig | null = null;
    private lastTripsCheck = 0;

    constructor(
        private viewRoot: string,
        private configPath: string,
        private geo: GeoProxy,
        private index: ViewIndexStore,
        private ctx: { getActiveTripKey: () => string | null; isCasting: () => boolean; isUserActive: () => boolean },
    ) {
        this.processor = new ImageProcessor(SCRATCH_DIR, () => {
            // No UI to notify - the sweeper's progress is reflected in
            // index.json/manifest.json, not in live READY broadcasts.
        });
        this.processor.setTrip('__sweeper__'); // fixes a generation that's never bumped again
    }

    start() {
        this.loop().catch((e) => logger.error(`[Sweeper] Loop exited unexpectedly: ${getErrorMessage(e)}`));
    }

    stop() {
        this.stopRequested = true;
    }

    private async loop() {
        while (!this.stopRequested) {
            try {
                await this.refreshTripsConfigIfStale();
                if (this.tripsConfig) await this.sweepPass(this.tripsConfig);
            } catch (e) {
                logger.error(`[Sweeper] Pass failed: ${getErrorMessage(e)}`);
            }
            await sleep(SWEEP_IDLE_INTERVAL_MS);
        }
    }

    private async refreshTripsConfigIfStale() {
        const now = Date.now();
        if (this.tripsConfig && now - this.lastTripsCheck < TRIPS_YAML_POLL_MS) return;
        this.tripsConfig = parseYaml(await Deno.readTextFile(this.configPath)) as TripConfig;
        await this.index.reconcileWithConfig(this.tripsConfig);
        this.lastTripsCheck = now;
    }

    private async sweepPass(config: TripConfig) {
        const pending = await this.index.pendingTrips();
        if (pending.length === 0) {
            logger.debug('[Sweeper] Nothing pending this pass.');
            return;
        }
        logger.info(`[Sweeper] ${pending.length} trip(s) pending.`);
        for (const { key, name, year } of pending) {
            if (this.stopRequested) return;
            if (this.ctx.isCasting()) {
                logger.debug('[Sweeper] Casting active - pausing sweep until next pass.');
                return;
            }
            if (this.ctx.isUserActive()) {
                logger.debug('[Sweeper] User recently active - pausing sweep until next pass.');
                return;
            }
            if (this.ctx.getActiveTripKey() === key) {
                logger.debug(`[Sweeper] Skipping ${name} - currently selected interactively.`);
                continue;
            }
            await this.sweepTrip(key, name, year, config);
        }
    }

    private async sweepTrip(key: string, name: string, year: number, config: TripConfig) {
        const tripPath = join(config.target, String(year), name);
        const manifest = new ManifestStore(this.viewRoot, year, name, tripPath);

        let needsScan: ManifestPhoto[];
        try {
            ({ needsScan } = await manifest.reconcile(tripPath));
        } catch (e) {
            logger.warn(`[Sweeper] ${name}: could not read source directory (${getErrorMessage(e)}); leaving as-is.`);
            return;
        }

        if (needsScan.length > 0) {
            logger.info(`[Sweeper] ${name}: scanning EXIF for ${needsScan.length} new/changed file(s).`);
            await scanExifBatch(
                needsScan,
                tripPath,
                undefined,
                () => this.stopRequested || this.ctx.isCasting() || this.ctx.isUserActive(),
            );
            await manifest.save();
        }

        const toRender = manifest.photosNeedingRender().filter((p) => (p.attempts ?? 0) < MAX_RENDER_ATTEMPTS);
        let processedThisPass = 0;
        for (const photo of toRender) {
            if (
                this.stopRequested || this.ctx.isCasting() || this.ctx.isUserActive() ||
                this.ctx.getActiveTripKey() === key
            ) {
                logger.debug(
                    `[Sweeper] ${name}: yielding mid-trip (${processedThisPass}/${toRender.length} done this pass).`,
                );
                break; // manifest already reflects progress so far; resume next pass
            }
            const outPath = join(manifest.dir, photo.viewFile);
            const scratchKey = parsePath(photo.viewFile).name.replace(/[^a-z0-9]/gi, '_');
            const sourcePath = join(tripPath, photo.sourceFile);
            const ok = await this.processor.process(
                sourcePath,
                outPath,
                scratchKey,
                photo.exif,
                this.processor.generation,
                this.geo,
            );
            if (ok) manifest.markReady(photo.sourceFile);
            else manifest.markFailed(photo.sourceFile);
            processedThisPass++;
            if (processedThisPass % 10 === 0) await manifest.save();
        }
        await manifest.save();

        const total = manifest.manifest?.photos.length ?? 0;
        const ready = manifest.manifest?.photos.filter((p) => p.status === 'ready').length ?? 0;
        await this.index.updateTrip(key, {
            tripName: name,
            year,
            manifestPath: join(String(year), name, 'manifest.json'),
            photoCount: total,
            readyCount: ready,
            status: ready >= total && total > 0 ? 'ready' : 'partial',
            lastSwept: new Date().toISOString(),
        });
        logger.info(`[Sweeper] ${name}: ${ready}/${total} ready.`);
    }
}

// --------------------------------------------------------------------------

class PhotoCastSystem {
    private photoEntries: PhotoEntry[] = [];
    private currentIndex = 0;
    private lastSentIndex = -1;
    private tripName = '';
    // Deliberately NOT restored from state.json on startup. Whether we should be
    // actively pushing images to the Chromecast is a live decision, not a saved
    // fact - the device may have been power cycled, taken over by another sender,
    // or left in an unknown state by a crash of a previous run of this program.
    // Every run starts assuming nothing, and verifyStartupState() (see start())
    // establishes real ground truth before any casting decision is made.
    private isCasting = false;
    private isScanning = false;
    private isPaused = false;
    private scanPercent = 0;
    private sessionId = Date.now().toString();
    private sockets = new Set<WebSocket>();
    private processor: ImageProcessor;
    private cast: CastManager;
    private geo: GeoProxy;
    private settings = DEFAULT_SETTINGS;
    private timeRemaining = 30;
    private lastCastTime = 0;
    // Updated on any user-initiated navigation or trip selection (not the
    // auto-advance timer). Lets the sweeper back off entirely for a short
    // grace period rather than only skipping the currently-selected trip -
    // useful on modest hardware where competing with active browsing/casting
    // for CPU would actually be noticeable.
    private lastInteractionTime = 0;
    // The manifest for whichever trip is currently selected. Owns the on-disk
    // location of that trip's rendered images and its EXIF/status cache.
    private currentManifest: ManifestStore | null = null;
    // The year of the currently selected trip, kept alongside tripName so we
    // can build the same "<year>/<tripName>" key the view index uses, without
    // re-deriving it from trips.yml every time something needs to check.
    private currentTripYear = 0;
    private viewIndex: ViewIndexStore;
    private sweeper: BackgroundSweeper;

    private websiteDirPath: string;
    private websiteIndexFile: string;

    constructor(
        private configPath: string,
        private port: number,
        private websitePath: string,
        private viewRoot: string,
    ) {
        this.geo = new GeoProxy();
        this.viewIndex = new ViewIndexStore(this.viewRoot);
        this.sweeper = new BackgroundSweeper(this.viewRoot, this.configPath, this.geo, this.viewIndex, {
            getActiveTripKey: () => (this.tripName ? `${this.currentTripYear}/${this.tripName}` : null),
            isCasting: () => this.isCasting,
            isUserActive: () => Date.now() - this.lastInteractionTime < INTERACTION_GRACE_MS,
        });
        const resolvedPath = isAbsolute(websitePath) ? websitePath : join(Deno.cwd(), websitePath);
        try {
            const info = Deno.statSync(resolvedPath);
            logger.info(`Resolved website path: ${resolvedPath} (${info.isDirectory ? 'directory' : 'file'})`);
            if (info.isDirectory) {
                this.websiteDirPath = resolvedPath;
                this.websiteIndexFile = this.findWebsiteIndex(resolvedPath);
            } else if (info.isFile) {
                this.websiteDirPath = dirname(resolvedPath);
                this.websiteIndexFile = resolvedPath;
            } else {
                throw new Error('Website path must be a directory or an HTML file.');
            }
        } catch (e) {
            logger.error(`Website file error: ${getErrorMessage(e)}`);
            Deno.exit(1);
        }

        try {
            this.settings = JSON.parse(Deno.readTextFileSync(SETTINGS_FILE));
        } catch {
            logger.warn('No existing settings found. Using defaults.');
            this.settings = DEFAULT_SETTINGS;
        }

        this.processor = new ImageProcessor(SCRATCH_DIR, (idx) => {
            if (idx === -1) {
                this.isScanning = false;
                this.broadcastState(true);
            } else if (this.photoEntries[idx]) {
                this.broadcast({
                    type: 'READY',
                    index: idx,
                    file: basename(this.photoEntries[idx].path),
                    exif: this.photoEntries[idx].exif,
                });
                this.saveState();
            }
        });

        this.cast = new CastManager(this.settings.ip, () => this.broadcastState());
        this.timeRemaining = this.settings.timeout;

        this.setupRoutes();
        this.watchHtmlFile();

        setInterval(() => {
            if (this.isScanning || this.photoEntries.length === 0 || this.processor.readyMap.size === 0) return;

            if (this.isPaused) {
                if (this.cast.connected && this.cast.status === 'ACTIVE') {
                    const now = Date.now();
                    if (now - this.lastCastTime >= 60000) {
                        logger.info(
                            '[Anti-Screensaver] Paused for 60s, resending image to keep Chromecast active.',
                        );
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
            const watcher = Deno.watchFs(this.websiteIndexFile);
            logger.info(`[Watcher] Watching HTML file: ${this.websiteIndexFile}`);

            let debounceTimer: number | null = null;
            (async () => {
                for await (const event of watcher) {
                    if (event.kind === 'modify') {
                        if (debounceTimer) clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(() => {
                            logger.info('[Watcher] HTML file modified. Reloading clients.');
                            this.broadcast({ type: 'RELOAD' });
                        }, 500) as unknown as number;
                    }
                }
            })();
        } catch (e) {
            logger.error(`[Watcher] Could not watch HTML: ${getErrorMessage(e)}`);
        }
    }

    private findWebsiteIndex(dir: string): string {
        const candidates = ['index.html', 'photocast.html'];
        for (const name of candidates) {
            try {
                const candidatePath = join(dir, name);
                const stat = Deno.statSync(candidatePath);
                if (stat.isFile) return candidatePath;
            } catch {
                // ignore missing candidate
            }
        }

        for (const entry of Deno.readDirSync(dir)) {
            if (entry.isFile && entry.name.toLowerCase().endsWith('.html')) {
                return join(dir, entry.name);
            }
        }

        throw new Error(`No HTML entry file found in website directory: ${dir}`);
    }

    private async saveState() {
        const data: RestoredState = {
            tripName: this.tripName,
            currentIndex: this.currentIndex,
        };
        try {
            await Deno.writeTextFile(STATE_FILE, JSON.stringify(data));
        } catch {
            logger.warn('Could not save state file.');
        }
    }

    // Keeps index.json's summary of this trip accurate regardless of whether
    // it was rendered by the interactive worker (here) or the background
    // sweeper (BackgroundSweeper.sweepTrip) - both funnel through the same
    // per-trip manifest, so both can report the same way.
    private async updateIndexForTrip(year: number, name: string, manifest: ManifestStore) {
        const total = manifest.manifest?.photos.length ?? 0;
        const ready = manifest.manifest?.photos.filter((p) => p.status === 'ready').length ?? 0;
        await this.viewIndex.updateTrip(`${year}/${name}`, {
            tripName: name,
            year,
            manifestPath: join(String(year), name, 'manifest.json'),
            photoCount: total,
            readyCount: ready,
            status: ready >= total && total > 0 ? 'ready' : 'partial',
            lastSwept: new Date().toISOString(),
        });
    }

    private broadcastState(force: boolean = false) {
        const msg: BroadcastMessage = {
            type: 'SYNC',
            sessionId: this.sessionId,
            index: this.currentIndex,
            timeRemaining: this.timeRemaining,
            isScanning: this.isScanning,
            isPaused: this.isPaused,
            trip: this.tripName,
            total: this.photoEntries.length,
            castStatus: this.cast.status,
            castForeignSession: this.cast.foreignSession,
            settings: this.settings,
            scanPercent: this.scanPercent,
        };
        if (force || (this.currentIndex !== this.lastSentIndex && this.photoEntries.length > 0)) {
            msg.files = Object.fromEntries(
                Array.from(this.processor.readyMap).filter((idx) => this.photoEntries[idx]).map((
                    idx,
                ) => [idx, basename(this.photoEntries[idx].path)]),
            );
            msg.exifs = Object.fromEntries(
                Array.from(this.processor.readyMap).filter((idx) => this.photoEntries[idx]).map((
                    idx,
                ) => [idx, this.photoEntries[idx].exif]),
            );
            msg.ready = Array.from(this.processor.readyMap);
            this.lastSentIndex = this.currentIndex;
        }
        this.broadcast(msg);
    }

    private broadcast(msg: BroadcastMessage) {
        const json = JSON.stringify(msg);
        for (const s of this.sockets) if (s.readyState === WebSocket.OPEN) s.send(json);
    }

    private setupRoutes() {
        const app = new Application();
        const router = new Router();

        app.addEventListener('error', (evt) => {
            const err = evt.error;
            const msg = err?.message || String(err) || '';
            if (isNoisy(msg)) {
                evt.preventDefault();
                return;
            }
            logger.debug(`[Server Error] ${msg}`);
        });

        router.get('/ws', (ctx) => {
            if (!ctx.isUpgradable) return;
            const ws = ctx.upgrade();
            this.sockets.add(ws);
            ws.onopen = () => setTimeout(() => this.broadcastState(true), 100);
            ws.onmessage = (e: { data: string }) => {
                try {
                    const d = JSON.parse(e.data);
                    if (d.type === 'MOVE') {
                        this.lastInteractionTime = Date.now();
                        this.move(d.step);
                    }
                    if (d.type === 'JUMP') {
                        this.lastInteractionTime = Date.now();
                        this.currentIndex = d.index;
                        this.timeRemaining = this.settings.timeout;
                        this.refresh();
                        this.broadcastState();
                    }
                    if (d.type === 'TOGGLE_PAUSE') {
                        this.isPaused = !this.isPaused;
                        logger.info(`[Playback] Pause toggled: ${this.isPaused}`);
                        this.broadcastState();
                    }
                    if (d.type === 'UPDATE_SETTINGS') {
                        this.settings = { ...this.settings, ...d.settings };
                        Deno.writeTextFileSync(SETTINGS_FILE, JSON.stringify(this.settings));
                        this.cast.updateIp(this.settings.ip);
                        this.timeRemaining = this.settings.timeout;
                        this.broadcastState();
                    }
                } catch {
                    logger.warn('Could not update settings.');
                }
            };
            ws.onclose = () => this.sockets.delete(ws);
        });

        router.get('/img/:trip/:filename', async (ctx) => {
            const { trip, filename } = ctx.params;
            if (filename === 'status') {
                try {
                    ctx.response.body = await Deno.readFile(STATUS_FRAME_FILE);
                    ctx.response.type = 'image/jpeg';
                } catch {
                    ctx.response.status = 404;
                }
                return;
            }
            const idx = this.photoEntries.findIndex((e) => basename(e.path) === filename);
            if (idx === -1 || !this.currentManifest) return ctx.response.status = 404;
            try {
                ctx.response.body = await Deno.readFile(join(this.currentManifest.dir, this.photoEntries[idx].viewFile));
                ctx.response.type = 'image/jpeg';
            } catch {
                // Not rendered yet (or briefly removed by a manifest reconcile
                // cleanup) - show the placeholder rather than a broken image.
                try {
                    ctx.response.body = await Deno.readFile(STATUS_FRAME_FILE);
                    ctx.response.type = 'image/jpeg';
                } catch {
                    ctx.response.status = 404;
                }
            }
        });

        router.get('/trips-list', async (ctx) => {
            const config = parseYaml(await Deno.readTextFile(this.configPath)) as TripConfig;
            const validTrips: TripItem[] = [];
            for (const t of config.trips) {
                const tripPath = join(config.target, new Date(t.start).getFullYear().toString(), t.name);
                try {
                    let hasFiles = false;
                    for (const entry of Deno.readDirSync(tripPath)) {
                        if (
                            (entry.isFile || entry.isSymlink) &&
                            ['.jpg', '.jpeg', '.png', '.dng', '.orf', '.nef', '.arw', '.heic'].includes(
                                extname(entry.name).toLowerCase(),
                            )
                        ) {
                            hasFiles = true;
                            break;
                        }
                    }
                    if (hasFiles) validTrips.push(t);
                } catch {
                    logger.warn('Could not read trip directory.');
                }
            }
            ctx.response.body = validTrips.sort((a: TripItem, b: TripItem) =>
                new Date(b.start).getTime() - new Date(a.start).getTime()
            ).map((t: TripItem) => t.name);
        });

        router.get('/search', async (ctx) => {
            await this.selectTrip(undefined, ctx.request.url.searchParams.get('q') || '');
            ctx.response.status = 200;
        });
        // router.get("/random", async (ctx) => { await this.selectTrip(); ctx.response.status = 200; });

        router.get('/toggle-cast', async (ctx) => {
            this.isCasting = !this.isCasting;
            logger.info(`[Cast] Toggle isCasting=${this.isCasting}`);
            try {
                if (this.isCasting) await this.refresh();
                else this.cast.dispose('OFF');
                ctx.response.status = 200;
                ctx.response.body = {
                    status: 'ok',
                    isCasting: this.isCasting,
                    castStatus: this.cast.status,
                    ip: this.settings.ip,
                    connected: this.cast.connected,
                };
            } catch (e) {
                const errorMessage = getErrorMessage(e);
                logger.error(`[Cast] Toggle refresh failed: ${errorMessage}`);
                ctx.response.status = 500;
                ctx.response.body = { status: 'error', message: errorMessage || 'Refresh failed' };
            }
        });

        router.get('/cast-status', (ctx) => {
            ctx.response.status = 200;
            ctx.response.body = {
                status: 'ok',
                isCasting: this.isCasting,
                castStatus: this.cast.status,
                castIp: this.cast.ip,
                connected: this.cast.connected,
            };
        });

        router.post('/update-settings', async (ctx) => {
            try {
                const body = await ctx.request.body({ type: 'json' }).value as Partial<Settings>;
                this.settings = { ...this.settings, ...body };
                try {
                    try {
                        Deno.mkdirSync(USER_CACHE_DIR, { recursive: true });
                    } catch {
                        logger.warn(
                            'Could not create cache directory for settings. Changes will not be saved persistently.',
                        );
                    }
                    Deno.writeTextFileSync(SETTINGS_FILE, JSON.stringify(this.settings));
                } catch (e) {
                    logger.error(`[Settings] Write error: ${getErrorMessage(e)}`);
                }
                this.cast.updateIp(this.settings.ip);
                this.timeRemaining = this.settings.timeout;
                this.broadcastState(true);
                ctx.response.status = 200;
                ctx.response.body = { status: 'ok', settings: this.settings };
            } catch (e) {
                logger.error(`[Settings] Update failed: ${getErrorMessage(e)}`);
                ctx.response.status = 400;
                ctx.response.body = { status: 'error', message: 'bad request' };
            }
        });

        const serveStaticFile = async (ctx: Context, filePath: string, contentType: string) => {
            try {
                ctx.response.body = await Deno.readFile(filePath);
                ctx.response.type = contentType;
                //  make sure files like sw.js are not cached by the browser
                ctx.response.headers.set('Cache-Control', 'no-cache');
            } catch {
                ctx.response.status = 404;
            }
        };

        router.get('/manifest.webmanifest', async (ctx) => {
            await serveStaticFile(ctx, join(this.websiteDirPath, 'manifest.webmanifest'), 'application/manifest+json');
        });

        router.get('/sw.js', async (ctx) => {
            await serveStaticFile(ctx, join(this.websiteDirPath, 'sw.js'), 'application/javascript');
        });

        router.get('/icons/:filename', async (ctx) => {
            const filename = ctx.params.filename;
            await serveStaticFile(ctx, join(this.websiteDirPath, 'icons', filename), 'image/png');
        });

        const htmlFilename = basename(this.websiteIndexFile);
        router.get(`/${htmlFilename}`, async (ctx) => {
            ctx.response.body = await Deno.readTextFile(this.websiteIndexFile);
            ctx.response.type = 'text/html';
        });

        router.get('/', async (ctx) => {
            ctx.response.body = await Deno.readTextFile(this.websiteIndexFile);
            ctx.response.type = 'text/html';
            // more ensuring no caching
            ctx.response.headers.set('Cache-Control', 'no-cache');
        });

        app.use(router.routes());
        app.listen({ port: this.port });
    }

    private move(step: number) {
        if (this.isScanning || this.photoEntries.length === 0) return;
        const total = this.photoEntries.length;
        const direction = step >= 0 ? 1 : -1;
        let next = (this.currentIndex + step + total) % total;
        // Skip over anything not rendered yet (early in a large trip's sweep,
        // or if the sweeper is still catching up on this one) rather than
        // landing on it and asking the Chromecast to load a file that isn't
        // there. Bounded by `total` so a trip with nothing ready yet doesn't
        // spin forever.
        let attempts = 0;
        while (!this.processor.readyMap.has(next) && attempts < total) {
            next = (next + direction + total) % total;
            attempts++;
        }
        if (attempts >= total) return; // nothing in this trip is ready yet - stay put
        this.currentIndex = next;
        this.timeRemaining = this.settings.timeout;
        this.saveState();
        this.refresh();
        this.broadcastState();
    }

    private async refresh() {
        try {
            if (!this.isCasting) return;

            if (await this.cast.connect()) {
                const tripSafe = this.tripName.replace(/[^a-z0-9]/gi, '_');
                const showStatus = this.isScanning || this.photoEntries.length === 0 ||
                    !this.processor.readyMap.has(this.currentIndex);
                const url = showStatus
                    ? `http://${LOCAL_IP}:${this.port}/img/${tripSafe}/status?t=${Date.now()}`
                    : `http://${LOCAL_IP}:${this.port}/img/${tripSafe}/${
                        basename(this.photoEntries[this.currentIndex].path)
                    }?t=${Date.now()}`;
                this.cast.load(url);
                this.lastCastTime = Date.now();
            }
        } catch (e) {
            logger.error(`[Cast] Refresh exception: ${getErrorMessage(e)}`);
        }
    }

    public async selectTrip(name?: string, query?: string, restored?: RestoredState) {
        this.lastInteractionTime = Date.now();
        const q = query || '';
        this.timeRemaining = this.settings.timeout;
        this.lastSentIndex = -1;

        const config = parseYaml(await Deno.readTextFile(this.configPath)) as TripConfig;
        let trips = config.trips;

        // If we're restoring a session, try to find that same trip in the
        // current config - but from here on it goes through exactly the same
        // manifest reconciliation as any other selection. Trusting the saved
        // photo list verbatim (the old behavior) meant a trip whose source
        // folder changed while the app was down would silently show stale data.
        let trip: TripItem | undefined;
        let restoredIndex: number | null = null;
        if (restored && (!q || restored.tripName.toLowerCase().includes(q.toLowerCase()))) {
            trip = trips.find((t) => t.name === restored.tripName);
            if (trip) restoredIndex = restored.currentIndex;
            else logger.warn(`[Scanner] Restored trip "${restored.tripName}" no longer found in ${this.configPath}.`);
        }

        if (!trip) {
            if (q) trips = trips.filter((t: TripItem) => t.name.toLowerCase().includes(q.toLowerCase()));
            trip = trips.find((t: TripItem) => t.name === name) || trips[Math.floor(Math.random() * trips.length)];
        }

        if (!trip) {
            this.isScanning = false;
            return;
        }

        this.currentIndex = restoredIndex ?? 0;

        this.isScanning = true;
        this.scanPercent = 0;
        this.photoEntries = [];
        this.tripName = trip.name;
        // Clears the client-side view, not the on-disk cache - the previous
        // trip's rendered images and manifest are left exactly where they are,
        // ready instantly if the user selects it again.
        this.broadcast({ type: 'CLEAR' });
        const currentGen = this.processor.setTrip(this.tripName);

        try {
            const out = STATUS_FRAME_FILE;
            await new Deno.Command('magick', {
                args: [
                    '-size',
                    '1920x1080',
                    'canvas:black',
                    '-font',
                    FONT_PATH,
                    '-fill',
                    'white',
                    '-pointsize',
                    '60',
                    '-gravity',
                    'north',
                    '-annotate',
                    '+0+300',
                    `Preparing Trip...\n${this.tripName}`,
                    out,
                ],
            }).output();
        } catch (e) {
            logger.error(`[Scanner] Failed to generate status image: ${getErrorMessage(e)}`);
        }

        this.refresh();
        this.broadcastState();

        const year = new Date(trip.start).getFullYear();
        this.currentTripYear = year;
        const tripPath = join(config.target, year.toString(), trip.name);
        logger.info(`[Scanner] Folder: ${tripPath}`);

        const manifest = new ManifestStore(this.viewRoot, year, trip.name, tripPath);
        this.currentManifest = manifest;

        let needsScan: ManifestPhoto[];
        try {
            ({ needsScan } = await manifest.reconcile(tripPath));
        } catch (e) {
            logger.error(`[Scanner] Failed to read trip directory: ${getErrorMessage(e)}`);
            this.isScanning = false;
            return;
        }

        if (currentGen !== this.processor.generation) return;

        if (needsScan.length > 0) {
            logger.info(
                `[Scanner] Running exiftool on ${needsScan.length} new/changed file(s) of ${manifest.manifest?.photos.length ?? 0} total.`,
            );
            await scanExifBatch(
                needsScan,
                tripPath,
                (pct) => {
                    this.scanPercent = pct;
                    this.broadcastState();
                },
                () => currentGen !== this.processor.generation,
            );
            if (currentGen !== this.processor.generation) return;
            await manifest.save();
        } else {
            logger.info(`[Scanner] Manifest up to date, no EXIF rescan needed.`);
        }

        if (currentGen !== this.processor.generation) return;

        this.photoEntries = (manifest.manifest?.photos ?? [])
            .map((p): PhotoEntry => ({
                path: join(tripPath, p.sourceFile),
                TS: p.ts,
                exif: p.exif,
                viewFile: p.viewFile,
                status: p.status,
            }))
            .sort((a, b) => a.TS.localeCompare(b.TS));

        this.processor.readyMap = new Set(
            this.photoEntries.reduce<number[]>((acc, e, i) => {
                if (e.status === 'ready') acc.push(i);
                return acc;
            }, []),
        );

        this.scanPercent = 100;
        this.isScanning = false;
        this.saveState();
        this.refresh();
        const tripYearAtStart = year;
        const tripNameAtStart = trip.name;
        this.processor.runWorker(this.photoEntries, this.tripName, manifest, this.geo).then(() =>
            this.updateIndexForTrip(tripYearAtStart, tripNameAtStart, manifest)
        );
    }
    public async start(initialSearch?: string) {
        let restored = null;
        try {
            restored = JSON.parse(await Deno.readTextFile(STATE_FILE));
        } catch (e) {
            logger.warn('Could not restore previous state.');
        }

        // Establish real ground truth about the Chromecast before doing anything
        // else. The periodic heartbeat only checks that the port is reachable and
        // runs on a 5s interval; on startup we want a definitive answer right away,
        // and one that distinguishes "idle", "already running our app", and
        // "busy with something else" - a plain reachability check can't tell those
        // apart, and getting this wrong risks silently interrupting someone else's
        // Cast session the moment this program decides to display something.
        const castState = await this.cast.verifyStartupState();
        switch (castState) {
            case 'foreign':
                logger.info(
                    '[Cast] Device is currently in use by another sender. Will not cast until the user confirms.',
                );
                break;
            case 'ours':
                logger.info(
                    '[Cast] Found a pre-existing DefaultMediaReceiver session (likely from a previous run). Not attaching automatically.',
                );
                break;
            case 'unreachable':
                logger.info('[Cast] Device unreachable at startup; heartbeat will keep checking.');
                break;
            case 'idle':
                logger.info('[Cast] Device idle and available.');
                break;
        }
        this.broadcastState(true);

        // Runs independently of whatever trip ends up selected below - it
        // works through every other trip in the background so switching to
        // one later costs nothing beyond a fingerprint check.
        this.sweeper.start();

        await this.selectTrip(undefined, initialSearch, restored);
    }
}

// --------------------------------------------------------------------------
// main
const program = new Command();
program.description(`${PROGRAM} - Cast albums to Chromecast`)
    .option('-i, --ip <string>', 'Chromecast IP', DEFAULT_SETTINGS.ip)
    .option('-p, --port <number>', 'Local web port', DEFAULT_SETTINGS.port.toString())
    .option('-y, --yaml <string>', 'YAML', './trips.yml')
    .option('-v, --verbose', 'Debug', false)
    .option('--version', 'Show version', () => {
        logger.info(`photocast - version ${VERSION}`);
        Deno.exit(0);
    })
    .option('-s, --search <string>', 'Search')
    .option('--headless', 'Headless background mode', false)
    .option('-c, --clear-cache', 'Wipe Cache', false)
    .option('--view-root <string>', 'Persistent view-tree root for rendered images + manifests', DEFAULT_VIEW_ROOT)
    .option('--website <string>', 'Website folder or HTML entry file', './website');

program.parse(process.argv);
const options = program.opts();

try {
    Deno.mkdirSync(USER_CACHE_DIR, { recursive: true });
} catch (e) {
    logger.warn(`Could not create user cache directory at ${USER_CACHE_DIR}: ${getErrorMessage(e)}`);
}

if( options.verbose) setLogLevel('DEBUG');
if( options.headless) setLogFile( LOG_FILE)

// daemonise the deno way
if (options.headless && !Deno.env.get('PHOTOCAST_BACKGROUND')) {

    // logger.info('🚀 Spawning photocast in the background...');

    const execName = basename(Deno.execPath()).toLowerCase();
    const isCompiled = execName !== 'deno' && execName !== 'deno.exe';

    // handle a compiled version, the args will be different
    const args = isCompiled ? [...Deno.args] : ['run', '-A', import.meta.url, ...Deno.args];

    // relaunch the app again
    const child = new Deno.Command(Deno.execPath(), {
        args: args,
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
        env: { PHOTOCAST_BACKGROUND: '1' },
    }).spawn();

    child.unref();
    // logger.info(`✅ Background process spawned (PID: ${child.pid}). You can close this terminal.`);
    logger.info(`📝 Logs are being written to: ${getLogFile()}`);
    Deno.exit(0);
}

if (options.clearCache) {
    try {
        await purgeCacheKeepSettings();
        logger.info('Cache Wiped.');
    } catch {
        logger.warn('Could not clear cache.');
    }
}
if (options.website) {
    try {
        await Deno.stat(isAbsolute(options.website) ? options.website : join(Deno.cwd(), options.website));
    } catch (e) {
        logger.error(`Website path error: ${getErrorMessage(e)}`);
        Deno.exit(1);
    }
}

// const isRunningAsDaemon = !!Deno.env.get('PHOTOCAST_BACKGROUND');

logger.info(`[Startup] View tree root: ${options.viewRoot}`);
new PhotoCastSystem(options.yaml, parseInt(options.port), options.website, options.viewRoot).start(options.search);