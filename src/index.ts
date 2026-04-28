import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Airtunes implementation (node_airtunes2 port) in src/core.
import LegacyAirTunes from './core/index';
import config, { applyConfig, type AirplayConfig } from './utils/config';

type LegacyAirTunesInstance = {
  add: (host: string, options?: Record<string, unknown>, mode?: number, txt?: string[] | string) => any;
  stop: (deviceKey: string) => void;
  stopAll: (cb?: () => void) => void;
  setVolume: (deviceKey: string, volume: number, callback?: (err?: unknown) => void) => void;
  setTrackInfo: (deviceKey: string, title: string, artist?: string, album?: string, cb?: (err?: unknown) => void) => void;
  setArtwork: (deviceKey: string, art: Buffer, contentType?: string, cb?: (err?: unknown) => void) => void;
  setProgress: (deviceKey: string, progress: number, duration: number, cb?: (err?: unknown) => void) => void;
  setPasscode: (deviceKey: string, passcode: string) => void;
  write: (chunk: Buffer) => boolean;
  end: () => void;
  on: (event: string, cb: (...args: any[]) => void) => void;
};

/**
 * Configuration for a single AirPlay sender.
 */
export interface LoxAirplaySenderOptions {
  host: string;
  /** RAOP port (defaults to 5000). */
  port?: number;
  /** Display name shown on the receiver. */
  name?: string;
  /** AirPlay 1 password; null disables auth. */
  password?: string | null;
  /** Initial volume 0–100 (default 50). */
  volume?: number;
  /** Explicit RAOP mode; defaults based on airplay2 flag. */
  mode?: number;
  /** Additional TXT records to advertise. */
  txt?: string[];
  /** Force ALAC encoding even when input is ALAC. */
  forceAlac?: boolean;
  /** Enable ALAC encoding pipeline. */
  alacEncoding?: boolean;
  /** Input format; pcm triggers encoding, alac passes through. */
  inputCodec?: 'pcm' | 'alac';
  /** Enable AirPlay 2 authentication + flags. */
  airplay2?: boolean;
  /** Emit verbose transport logs. */
  debug?: boolean;
  /** Optional unix ms start time for synced playback. */
  startTimeMs?: number;
  /** Logger hook for internal messages. */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Override transport/buffer tuning without patching the module. */
  config?: Partial<AirplayConfig>;
}

/**
 * Metadata sent to receivers for UI display.
 */
export interface AirplayMetadata {
  title?: string;
  artist?: string;
  album?: string;
  cover?: { data: Buffer; mime?: string };
  coverUrl?: string;
  elapsedMs?: number;
  durationMs?: number;
}

export interface LoxAirplayEvent {
  event: 'device' | 'buffer' | 'error' | 'metrics' | 'session-ended' | string;
  message?: string;
  detail?: any;
}

export class LoxAirplaySender extends EventEmitter {
  private airtunes: LegacyAirTunesInstance | null = null;
  private deviceKey: string | null = null;
  private started = false;
  private source: Readable | null = null;
  private log?: LoxAirplaySenderOptions['log'];
  private lastTrackKey: string | null = null;
  private lastCoverKey: string | null = null;
  private lastProgressKey: string | null = null;
  private lastCoverUrl: string | null = null;
  private coverFetch?: Promise<{ data: Buffer; mime?: string } | null>;
  private artworkTimer?: NodeJS.Timeout;
  private pendingArtwork?: { data: Buffer; mime?: string; key: string };
  private lastTrackChangeAt = 0;

  /**
   * Create + start a sender for a single AirPlay device.
   * Returns true when the pipeline initializes; safe to call multiple times to restart.
   */
  public start(options: LoxAirplaySenderOptions, onEvent?: (event: LoxAirplayEvent) => void): boolean {
    if (this.started) {
      this.stop();
    }
    this.log = options.log;
    if (options.config) {
      applyConfig(options.config);
    }
    const inputCodec = options.inputCodec ?? 'pcm';
    config.packet_size = inputCodec === 'alac' ? config.alac_packet_size : config.pcm_packet_size;
    this.airtunes = new LegacyAirTunes({
      packetSize: config.packet_size,
      startTimeMs: options.startTimeMs,
      config: options.config,
    }) as LegacyAirTunesInstance;
    this.airtunes.on('device', (key: string, status: string, desc: string) => {
      onEvent?.({ event: 'device', message: status, detail: { key, desc } });
      if (status === 'stopped') {
        onEvent?.({ event: 'session-ended', message: desc || 'stopped', detail: { key, reason: desc || 'stopped' } });
      }
    });
    this.airtunes.on('buffer', (status: string) => {
      onEvent?.({ event: 'buffer', message: status });
    });
    this.airtunes.on('error', (err: unknown) => {
      onEvent?.({ event: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    this.airtunes.on('metrics', (detail: unknown) => {
      onEvent?.({ event: 'metrics', detail });
    });

    const dev = this.airtunes.add(options.host, {
      port: options.port,
      name: options.name,
      password: options.password ?? null,
      volume: options.volume ?? 50,
      mode: options.mode ?? (options.airplay2 ? 2 : 0),
      txt: options.txt ?? [],
      forceAlac: options.forceAlac ?? true,
      alacEncoding: options.alacEncoding ?? true,
      inputCodec,
      airplay2: options.airplay2 ?? false,
      debug: options.debug ?? false,
      log: options.log,
    });

    this.deviceKey = dev?.key ?? `${options.host}:${options.port ?? 5000}`;
    this.started = true;
    return true;
  }

  /**
   * Push raw PCM or ALAC frames into the stream.
   */
  public sendPcm(chunk: Buffer): void {
    if (!this.airtunes || !this.started) return;
    this.airtunes.write(chunk);
  }

  /**
   * Pipe a readable stream into the sender; auto-stops on end/error.
   */
  public pipeStream(stream: Readable): void {
    if (!this.airtunes || !this.started) return;
    this.source = stream;
    stream.on('data', (chunk: Buffer) => this.sendPcm(chunk));
    stream.on('end', () => this.stop());
    stream.on('error', () => this.stop());
  }

  /** Adjust receiver volume (0–100). */
  public setVolume(volume: number): void {
    if (!this.airtunes || !this.deviceKey) return;
    this.airtunes.setVolume(this.deviceKey, volume);
  }

  /** Update track metadata immediately without artwork/progress. */
  public setTrackInfo(title: string, artist?: string, album?: string): void {
    if (!this.airtunes || !this.deviceKey) return;
    this.airtunes.setTrackInfo(this.deviceKey, title, artist, album);
  }

  /** Send cover art immediately. */
  public setArtwork(art: Buffer, contentType?: string): void {
    if (!this.airtunes || !this.deviceKey) return;
    this.airtunes.setArtwork(this.deviceKey, art, contentType);
  }

  /** Send playback progress in seconds (elapsed, duration). */
  public setProgress(progress: number, duration: number): void {
    if (!this.airtunes || !this.deviceKey) return;
    this.airtunes.setProgress(this.deviceKey, progress, duration);
  }

  /**
   * Convenience to send track info, cover (buffer or URL), and progress.
   * Deduplicates payloads and staggers artwork on track changes.
   */
  public async setMetadata(payload: AirplayMetadata): Promise<void> {
    if (!this.airtunes || !this.deviceKey) return;
    const title = payload.title ?? '';
    const artist = payload.artist ?? '';
    const album = payload.album ?? '';
    const trackKey = `${title}::${artist}::${album}`;
    const trackChanged = Boolean(title && trackKey !== this.lastTrackKey);
    if (trackChanged) {
      this.setTrackInfo(title, artist, album);
      this.lastTrackKey = trackKey;
      this.lastCoverKey = null;
      this.lastCoverUrl = null;
      this.lastTrackChangeAt = Date.now();
    }

    let coverPayload = payload.cover;
    const coverUrl = payload.coverUrl;
    if (!coverPayload?.data && coverUrl) {
      if (coverUrl !== this.lastCoverUrl && !this.coverFetch) {
        this.lastCoverUrl = coverUrl;
        this.lastCoverKey = null;
        this.coverFetch = this.fetchCover(coverUrl).finally(() => {
          this.coverFetch = undefined;
        });
      }
      if (this.coverFetch) {
        coverPayload = (await this.coverFetch) ?? undefined;
      }
    }
    if (coverPayload?.data) {
      const coverKey = coverUrl
        ? `${coverUrl}:${coverPayload.mime ?? 'unknown'}:${coverPayload.data.length}`
        : `${coverPayload.mime ?? 'unknown'}:${coverPayload.data.length}`;
      if (coverKey !== this.lastCoverKey) {
        if (trackChanged) {
          this.queueArtwork(coverPayload, coverKey, 200);
        } else {
          this.sendArtworkNow(coverPayload, coverKey);
        }
      }
    }

    const durationInput =
      typeof payload.durationMs === 'number' && payload.durationMs > 0 ? payload.durationMs : null;
    const elapsedInput =
      typeof payload.elapsedMs === 'number' && payload.elapsedMs >= 0 ? payload.elapsedMs : null;
    const durationSec =
      durationInput !== null ? Math.floor(durationInput > 1000 ? durationInput / 1000 : durationInput) : null;
    const elapsedSecRaw =
      elapsedInput !== null ? Math.floor(elapsedInput > 1000 ? elapsedInput / 1000 : elapsedInput) : null;
    if (durationSec !== null && elapsedSecRaw !== null && durationSec > 0) {
      const elapsedSec = Math.min(Math.max(0, elapsedSecRaw), durationSec);
      const progressKey = `${elapsedSec}/${durationSec}`;
      if (progressKey !== this.lastProgressKey) {
        this.setProgress(elapsedSec, durationSec);
        this.lastProgressKey = progressKey;
      }
    }
  }

  /** Provide a passcode when a receiver requests it. */
  public setPasscode(passcode: string): void {
    if (!this.airtunes || !this.deviceKey) return;
    this.airtunes.setPasscode(this.deviceKey, passcode);
  }

  /**
   * Stop streaming and tear down state/sockets. Safe to call multiple times.
   */
  public stop(): void {
    if (this.source) {
      try {
        this.source.destroy();
      } catch {
        // ignore
      }
      this.source = null;
    }
    this.lastTrackKey = null;
    this.lastCoverKey = null;
    this.lastProgressKey = null;
    this.lastCoverUrl = null;
    this.lastTrackChangeAt = 0;
    this.pendingArtwork = undefined;
    if (this.artworkTimer) {
      clearTimeout(this.artworkTimer);
      this.artworkTimer = undefined;
    }
    if (this.airtunes) {
      if (this.deviceKey) {
        this.airtunes.stop(this.deviceKey);
      }
      this.airtunes.stopAll?.(() => undefined);
      this.airtunes.end?.();
    }
    this.airtunes = null;
    this.deviceKey = null;
    this.started = false;
  }

  private async fetchCover(url: string): Promise<{ data: Buffer; mime?: string } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        this.log?.('warn', 'airplay cover fetch failed', { status: response.status, url });
        return null;
      }
      const mime = response.headers.get('content-type') || undefined;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) {
        this.log?.('warn', 'airplay cover fetch empty', { url });
        return null;
      }
      return { data: buffer, mime };
    } catch {
      this.log?.('warn', 'airplay cover fetch error', { url });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private sendArtworkNow(payload: { data: Buffer; mime?: string }, coverKey: string): void {
    this.setArtwork(payload.data, payload.mime);
    this.lastCoverKey = coverKey;
  }

  private queueArtwork(payload: { data: Buffer; mime?: string }, coverKey: string, delayMs: number): void {
    this.pendingArtwork = { ...payload, key: coverKey };
    if (this.artworkTimer) {
      clearTimeout(this.artworkTimer);
    }
    this.artworkTimer = setTimeout(() => {
      this.artworkTimer = undefined;
      const pending = this.pendingArtwork;
      this.pendingArtwork = undefined;
      if (!pending) return;
      if (pending.key === this.lastCoverKey) return;
      this.sendArtworkNow({ data: pending.data, mime: pending.mime }, pending.key);
    }, delayMs);
  }
}

/**
 * Convenience helper to construct + start a sender in one call.
 */
export function start(options: LoxAirplaySenderOptions, onEvent?: (event: LoxAirplayEvent) => void): LoxAirplaySender {
  const sender = new LoxAirplaySender();
  sender.start(options, onEvent);
  return sender;
}

export default LoxAirplaySender;
