import { Duplex } from 'node:stream';
import Devices from './devices';
import config, { applyConfig, type AirplayConfig } from '../utils/config';
import CircularBuffer from '../utils/circularBuffer';
import AudioOut from './audioOut';

/**
 * High-level RAOP/AirPlay sender that wires together devices, buffering, and output.
 * Acts as a Duplex stream: write PCM/ALAC chunks, listen to status events.
 */
class AirTunes extends Duplex {
  public readonly devices: Devices;
  private readonly circularBuffer: CircularBuffer;

  /**
   * @param options.packetSize Override packet size; defaults to config.
   * @param options.startTimeMs Optional unix ms to align playback start.
   */
  constructor(options: { packetSize?: number; startTimeMs?: number; config?: Partial<AirplayConfig> } = {}) {
    super({ readableObjectMode: false, writableObjectMode: false });

    if (options.config) {
      applyConfig(options.config);
    }

    const audioOut = new AudioOut();
    this.devices = new Devices(audioOut);

    this.devices.init();
    this.devices.on('status', (key, status, desc) => {
      this.emit('device', key, status, desc);
    });

    const packetSize = options.packetSize ?? config.packet_size;
    this.circularBuffer = new CircularBuffer(config.packets_in_buffer, packetSize);

    this.circularBuffer.on('status', (status) => {
      this.emit('buffer', status);
    });

    audioOut.init(this.devices, this.circularBuffer, options.startTimeMs);
    audioOut.on('metrics', (metrics) => {
      this.emit('metrics', metrics);
    });

    this.circularBuffer.on('drain', () => {
      this.emit('drain');
    });

    this.circularBuffer.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /** Register an AirTunes (RAOP) device and start streaming to it. */
  public add(host: string, options: Record<string, unknown>, mode = 0, txt: string[] | string = '') {
    return this.devices.add('airtunes', host, options, mode, txt);
  }

  /** Register a CoreAudio output (legacy shim). */
  public addCoreAudio(options: Record<string, unknown>): unknown {
    return this.devices.add('coreaudio', null, options);
  }

  /** Stop every device and release resources. */
  public stopAll(cb?: () => void): void {
    this.devices.stopAll(cb);
  }

  /** Stop a single device by key. */
  public stop(deviceKey: string): void {
    this.devices.stop(deviceKey);
  }

  /** Adjust volume for a device. */
  public setVolume(deviceKey: string, volume: number, callback?: (err?: unknown) => void): void {
    this.devices.setVolume(deviceKey, volume, callback);
  }

  /**
   * Push playback position (seconds) to a device.
   */
  public setProgress(
    deviceKey: string,
    progress: number,
    duration: number,
    callback?: (err?: unknown) => void,
  ): void {
    this.devices.setProgress(deviceKey, progress, duration, callback);
  }

  /**
   * Update track title/artist/album on a device.
   */
  public setTrackInfo(
    deviceKey: string,
    name: string,
    artist?: string,
    album?: string,
    callback?: (err?: unknown) => void,
  ): void {
    this.devices.setTrackInfo(deviceKey, name, artist, album, callback);
  }

  /**
   * Flush buffered audio for a track switch: clear our circular buffer and tell
   * every receiver to drop its buffered audio and re-anchor at the current RTP
   * position. Keeps the RTP timeline continuous so playback does not desync.
   */
  public reset(): void {
    this.circularBuffer.reset();
    this.devices.flush();
  }

  /** Send artwork to a device. */
  public setArtwork(deviceKey: string, art: Buffer, contentType?: string, callback?: (err?: unknown) => void): void {
    this.devices.setArtwork(deviceKey, art, contentType, callback);
  }

  /** Write PCM/ALAC frames into the buffer. */
  public override write(data: Buffer): boolean {
    return this.circularBuffer.write(data);
  }

  /** Provide a passcode to a device requiring auth. */
  public setPasscode(deviceKey: string, passcode: string): void {
    this.devices.setPasscode(deviceKey, passcode);
  }

  /** Close the writable side and stop buffering. */
  public override end(chunk?: any, encoding?: any, cb?: any): this {
    this.circularBuffer.end();
    return super.end(chunk, encoding, cb);
  }
}

export default AirTunes;
