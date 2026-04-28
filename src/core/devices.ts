import { EventEmitter } from 'node:events';
import async from 'async';
import AirTunesDevice from './deviceAirtunes';

type DeviceStatus = 'connecting' | 'ready' | 'playing' | 'stopped' | 'error' | string;
type AirTunesDeviceInstance = any;

type DevicesEmitter = EventEmitter & {
  emit(event: 'status', key: string, status: DeviceStatus, desc: string): boolean;
  emit(event: 'airtunes_devices', hasAirTunes: boolean): boolean;
  emit(event: 'need_sync'): boolean;
};

/**
 * Tracks and controls all connected AirPlay/RAOP devices.
 * Responsible for lifecycle, fan-out of state, and sync signaling.
 */
export default class Devices extends EventEmitter implements DevicesEmitter {
  private readonly devices: Record<string, AirTunesDeviceInstance> = {};
  private hasAirTunes = false;

  constructor(private readonly audioOut: EventEmitter) {
    super();
  }

  /** Wire device sync events from AudioOut into individual devices. */
  public init(): void {
    this.audioOut.on('need_sync', (seq: number) => {
      this.forEach((dev) => {
        try {
          if (dev.onSyncNeeded && dev.controlPort) {
            dev.onSyncNeeded(seq);
          }
        } catch {
          // ignore
        }
      });
    });
  }

  /** Iterate over live devices. */
  private forEach(it: (dev: AirTunesDeviceInstance, key: string) => void): void {
    for (const key of Object.keys(this.devices)) {
      it(this.devices[key], key);
    }
  }

  /**
   * Add (or reuse) a device and start playback.
   * @param type Device type (airtunes/coreaudio).
   * @param host Target host/IP.
   * @param options Transport options (volume/password/etc).
   * @param mode RAOP mode (0 default, 2 for AirPlay 2).
   * @param txt TXT records advertised by the device.
   */
  public add(
    type: string,
    host: string | null,
    options: any,
    mode = 0,
    txt: string[] | string = '',
  ): AirTunesDeviceInstance {
    this.emit('status', host ?? 'unknown', 'connecting', '');
    const dev = new (AirTunesDevice as any)(host, this.audioOut, options, mode, txt);

    const previousDev = this.devices[dev.key];
    if (previousDev) {
      previousDev.reportStatus();
      return previousDev;
    }

    this.devices[dev.key] = dev;

    dev.on('status', (status: DeviceStatus, desc = '') => {
      if (status === 'error' || status === 'stopped') {
        delete this.devices[dev.key];
        this.checkAirTunesDevices();
      }

      if (this.hasAirTunes && status === 'playing') {
        this.emit('need_sync');
      }

      this.emit('status', dev.key, status, desc);
    });

    dev.start();
    this.checkAirTunesDevices();
    return dev;
  }

  /** Adjust volume on one device. */
  public setVolume(key: string, volume: number, callback?: (err?: unknown) => void): void {
    const dev = this.devices[key];
    if (!dev) {
      this.emit('status', key, 'error', 'not_found');
      return;
    }
    dev.setVolume(volume, callback);
  }

  /** Push playback position to one or all devices. */
  public setProgress(key: string, progress: number, duration: number, callback?: (err?: unknown) => void): void {
    try {
      if (key === 'all') {
        for (const device of Object.keys(this.devices)) {
          try {
            this.devices[device].setProgress(progress, duration, callback);
          } catch (err: any) {
            if (err?.name === 'TypeError') {
              delete this.devices[device];
            }
          }
        }
        return;
      }
      const dev = this.devices[key];
      if (!dev) {
        this.emit('status', key, 'error', 'not_found');
        return;
      }
      dev.setProgress(progress, duration, callback);
    } catch {
      // ignore
    }
  }

  /**
   * Update track info on one or all devices.
   */
  public setTrackInfo(
    key: string,
    name: string,
    artist?: string,
    album?: string,
    callback?: (err?: unknown) => void,
  ): void {
    try {
      if (key === 'all') {
        for (const device of Object.keys(this.devices)) {
          try {
            this.devices[device].setTrackInfo(name, artist, album, callback);
          } catch (err: any) {
            if (err?.name === 'TypeError') {
              delete this.devices[device];
            }
          }
        }
        return;
      }
      const dev = this.devices[key];
      if (!dev) {
        this.emit('status', key, 'error', 'not_found');
        return;
      }
      dev.setTrackInfo(name, artist, album, callback);
    } catch {
      // ignore
    }
  }

  /** Update artwork on one or all devices. */
  public setArtwork(key: string, art: Buffer, contentType?: string, callback?: (err?: unknown) => void): void {
    try {
      if (key === 'all') {
        for (const device of Object.keys(this.devices)) {
          try {
            this.devices[device].setArtwork(art, contentType, callback);
          } catch (err: any) {
            if (err?.name === 'TypeError') {
              delete this.devices[device];
            }
          }
        }
        return;
      }
      const dev = this.devices[key];
      if (!dev) {
        this.emit('status', key, 'error', 'not_found');
        return;
      }
      dev.setArtwork(art, contentType, callback);
    } catch {
      // ignore
    }
  }

  /** Provide a passcode to a specific device. */
  public setPasscode(key: string, passcode: string): void {
    const dev = this.devices[key];
    if (!dev) {
      this.emit('status', key, 'error', 'not_found');
      return;
    }
    dev.setPasscode(passcode);
  }

  /** Stop one device. */
  public stop(key: string): void {
    const dev = this.devices[key];
    if (!dev) {
      this.emit('status', key, 'error', 'not_found');
      return;
    }
    dev.stop();
    delete this.devices[key];
  }

  /** Stop every device in parallel. */
  public stopAll(allCb?: (err?: unknown) => void): void {
    const devices = Object.values(this.devices);
    async.each(
      devices,
      (dev: AirTunesDeviceInstance, callback: (err?: unknown) => void) => {
        dev.stop(callback);
      },
      (err: unknown) => {
        if (allCb) {
          allCb(err as Error);
        }
      },
    );
  }

  /** Track whether any active device is RAOP to drive sync signals. */
  private checkAirTunesDevices(): void {
    let hasAirTunes = false;
    this.forEach((dev) => {
      if (dev.type === 'airtunes') {
        hasAirTunes = true;
      }
    });

    if (hasAirTunes !== this.hasAirTunes) {
      this.hasAirTunes = hasAirTunes;
      this.emit('airtunes_devices', hasAirTunes);
    }
  }
}
