import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import config from '../utils/config';
import * as nu from '../utils/numUtil';
import RTSP from './rtsp';
import UDPServers from './udpServers';
import { encodePcmToAlac } from '../utils/alac';

/**
 * AirTunes (RAOP/AirPlay) device session.
 * Handles RTSP control, UDP audio transport, optional ALAC encoding, and authentication hints.
 */
const RTP_HEADER_SIZE = 12;

type AnyObject = Record<string, unknown>;
type RTSPClient = {
  on: (event: string, cb: (...args: any[]) => void) => void;
  once: (event: string, cb: (...args: any[]) => void) => void;
  startHandshake: (udpServers: any, host: string, port: number) => void;
  teardown: () => void;
  setVolume: (volume: number, callback?: (err?: unknown) => void) => void;
  setTrackInfo: (name: string, artist?: string, album?: string, callback?: (err?: unknown) => void) => void;
  setProgress: (progress: number, duration: number, callback?: (err?: unknown) => void) => void;
  setArtwork: (art: Buffer, contentType?: string, callback?: (err?: unknown) => void) => void;
  setPasscode: (password: string) => void;
};
type Packet = { seq: number; pcm: Buffer; timestamp: number };
type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;

function formatLogArg(value: any): string {
  if (Buffer.isBuffer(value)) {
    return `<buffer len=${value.length}>`;
  }
  if (value instanceof Uint8Array) {
    return `<uint8 len=${value.length}>`;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function logLine(ctx: { log?: LogFn } | null | undefined, ...args: any[]): void {
  if (!args.length) {
    return;
  }
  if (ctx?.log) {
    const formatted = args.map(formatLogArg).join(' ');
    ctx.log('debug', formatted);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(...args);
}

class BufferWithNames {
  private readonly buffer: Array<[string, any]> = [];

  constructor(private readonly size: number) {}

  public add(name: string, item: any): void {
    while (this.buffer.length > this.size) {
      this.buffer.shift();
    }
    this.buffer.push([name, item]);
  }

  public getLatestNamed(name: string): any {
    for (let i = this.buffer.length - 1; i >= 0; i -= 1) {
      if (this.buffer[i][0] === name) {
        return this.buffer[i][1];
      }
    }
    return undefined;
  }
}

type AirTunesDeviceInstance = EventEmitter & {
  audioPacketHistory: BufferWithNames | null;
  udpServers: UDPServers;
  audioOut: EventEmitter;
  type: string;
  options: AnyObject;
  host: string;
  port: number;
  key: string;
  mode: number;
  forceAlac: boolean;
  statusflags: string[];
  alacEncoding: boolean;
  inputCodec: 'pcm' | 'alac';
  airplay2: boolean;
  txt: string[];
  borkedshp: boolean;
  needPassword: boolean;
  needPin: boolean;
  transient: boolean;
  features: string[];
  rtsp: RTSPClient | null;
  audioCallback: ((packet: Packet) => void) | null;
  encoder: any[];
  credentials: any;
  audioSocket: dgram.Socket | null;
  status: string;
  serverPort: number;
  controlPort: number;
  timingPort: number;
  audioLatency: number;
  requireEncryption: boolean;
  log?: LogFn;
  logLine?: (...args: any[]) => void;
  doHandshake: () => void;
  relayAudio: () => void;
  cleanup: (reason?: string) => void;
};

/**
 * Construct a RAOP/AirPlay device handler.
 * Accepts discovery TXT/flags and wires RTSP handshake to UDP audio.
 */
function AirTunesDevice(
  this: AirTunesDeviceInstance,
  host: string | null,
  audioOut: EventEmitter,
  options: AnyObject,
  mode = 0,
  txt: string[] | string = '',
) {
  EventEmitter.call(this);

  if (!host) {
    throw new Error('host is mandatory');
  }

  this.audioPacketHistory = new BufferWithNames(100);

  this.udpServers = new UDPServers();
  this.audioOut = audioOut;
  this.type = 'airtunes';
  this.options = options;
  this.log = (options as any)?.log;
  this.logLine = (...args: any[]) => logLine(this, ...args);
  this.host = host;
  this.port = Number((options as any)?.port ?? 5000);
  this.key = this.host + ':' + this.port;
  this.mode = mode; // Homepods with or without passcode
  // if (options.password != null && compatMode === true) {
  //   this.mode = 1; // Airport / Shairport passcode mode
    // this.mode = 2 // MFi mode
  // }
  this.forceAlac = (options as any).forceAlac ?? true;
  // this.skipAutoVolume = options.skipAutoVolume ?? false
  this.statusflags = [];
  this.alacEncoding = (options as any)?.alacEncoding ?? true;
  this.inputCodec = (options as any)?.inputCodec ?? 'pcm';
  this.airplay2 = (options as any)?.airplay2 ?? false;
  this.txt = Array.isArray(txt) ? txt : txt ? [String(txt)] : [];
  this.borkedshp = false;
  if (this.airplay2 && this.mode === 0) {
    this.mode = 2;
  }
  // console.debug('airplay txt', this.txt, 'port', this.port);
  let a = this.txt.filter((u: string) => String(u).startsWith('et='));
  if ((a[0] ?? '').includes('4')) {
    this.mode = 2;
  }
  let b = this.txt.filter((u: string) => String(u).startsWith('cn='));
  if (!this.forceAlac){
  if ((b[0] ?? '').includes('0')) {
    this.alacEncoding = false;
  }}
  let c = this.txt.filter((u: string) => String(u).startsWith('sf='));
  this.statusflags = c[0] ? parseInt(c[0].substring(3)).toString(2).split('') : []
  if (c.length == 0) {
      c = this.txt.filter((u: string) => String(u).startsWith('flags='))
  this.statusflags = c[0] ? parseInt(c[0].substring(6)).toString(2).split('') : []
  }
  this.needPassword = false;
  this.needPin = false;
  this.transient = false;
  let d: string[] = this.txt.filter((u: string) => String(u).startsWith('features='));
  if (d.length === 0) d = this.txt.filter((u: string) => String(u).startsWith('ft='));
  const features_set = d.length > 0 ? d[0].substring(d[0].indexOf('=') + 1).split(',') : [];
  this.features = [
    ...(features_set.length > 0 ? parseInt(features_set[0], 10).toString(2).split('') : []),
    ...(features_set.length > 1 ? parseInt(features_set[1], 10).toString(2).split('') : []),
  ];
  if (this.features.length > 0){
    this.transient = (this.features[this.features.length - 1 - 48] == '1')
  }

  if (this.statusflags.length) {
    let PasswordRequired = (this.statusflags[this.statusflags.length - 1 - 7] == '1')
    let PinRequired = (this.statusflags[this.statusflags.length - 1 - 3] == '1')
    let OneTimePairingRequired = (this.statusflags[this.statusflags.length - 1 - 9] == '1')
  // console.debug('needPss', PasswordRequired, PinRequired, OneTimePairingRequired);
    this.needPassword = PasswordRequired;
    this.needPin = (PinRequired || OneTimePairingRequired)
    this.transient = !(PasswordRequired || PinRequired || OneTimePairingRequired);
  }
  if (this.airplay2 && this.statusflags.length === 0 && !this.needPassword && !this.needPin) {
    this.transient = true;
  }
  // console.debug('transient', this.transient);
  // detect old shairports with broken text
  let oldver1 = this.txt.filter((u: string) => String(u).startsWith('sm='));
  let oldver2 = this.txt.filter((u: string) => String(u).startsWith('sv='));
  if ((b[0] ?? '') === 'cn=0,1' && (a[0] ?? '') === 'et=0,1' && (oldver1[0] ?? '') === 'sm=false' && (oldver2[0] ?? '') === 'sv=false' && this.statusflags.length === 0) {
    // console.debug('borked shairport found');
    this.alacEncoding = true
    this.borkedshp = true;
  }
  let k = this.txt.filter((u: string) => String(u).startsWith('am='));
  if ((k[0] ?? '').includes('AppleTV3,1') || (k[0] ?? '').includes('AirReceiver3,1') || (k[0] ?? '').includes('AirRecever3,1') || (k[0] ?? '').includes('Shairport')) {
    this.alacEncoding = true
    this.airplay2 = false
  }
  k = this.txt.filter((u: string) => String(u).startsWith('rmodel='));
  if ((k[0] ?? '').includes('AppleTV3,1') || (k[0] ?? '').includes('AirReceiver3,1') || (k[0] ?? '').includes('AirRecever3,1') || (k[0] ?? '').includes('Shairport')) {
    this.alacEncoding = true
    this.airplay2 = false
  }
  let manufacturer = this.txt.filter((u: string) => String(u).startsWith('manufacturer='));
  if ((manufacturer[0] ?? '').includes('Sonos')) {
    this.mode = 2;
    this.needPin = true
  }
  // console.debug('needPin', this.needPin);
  // console.debug('mode-atv', this.mode);
  // console.debug('alacEncoding', this.alacEncoding);
  try{
  this.rtsp = new (RTSP as any).Client((options as any).volume || 50, (options as any).password || null, audioOut,
    {
    mode: this.mode,
    txt: this.txt,
    alacEncoding: this.alacEncoding,
    needPassword: this.needPassword,
    airplay2: this.airplay2,
    needPin: this.needPin,
    debug: (options as any).debug,
    transient: this.transient,
    borkedshp: this.borkedshp,
    log: this.log,
  });} catch(e){
  this.logLine?.('rtsp error', e)}
  this.audioCallback = null;
  this.encoder = [];
  this.credentials = null;

  // this.func = `
  // const {Worker, isMainThread, parentPort, workerData} = require('node:worker_threads');
  // var { WebSocketServer } = require('ws');
  // const wss = new WebSocketServer({ port: 8980 });
  //  wss.on('connection', function connection(ws) {
  //    ws.on('message', function message(data) {
  //      parentPort.postMessage({message: data});
  //    });
  //    parentPort.on("message", data => {
  //      console.log("ass");
  //      ws.send(data);
  //    });
  //  });`;
  // this.worker = new Worker(func, {eval: true});
}

Object.setPrototypeOf(AirTunesDevice.prototype, EventEmitter.prototype);

AirTunesDevice.prototype.start = function (this: AirTunesDeviceInstance): void {
  this.audioSocket = dgram.createSocket('udp4');

  // Wait until timing and control ports are chosen. We need them in RTSP handshake.
  this.udpServers.on('ports', (err: any) => {
    if(err) {
      this.logLine?.(err.code);
      this.status = 'stopped';
      this.emit('status', 'stopped', 'udp_ports');
      this.logLine?.('port issues');
      this.emit('error', 'udp_ports', err.code);

      return;
    }
    this.doHandshake();
  });

  this.udpServers.bind(this.host);
};

AirTunesDevice.prototype.doHandshake = function (this: AirTunesDeviceInstance): void {
  try{
  if (this.rtsp == null){
    try{
      this.rtsp = new (RTSP as any).Client((this.options as any).volume || 30, (this.options as any).password || null, this.audioOut,
        {
        mode: this.mode,
        txt: this.txt,
        alacEncoding: this.alacEncoding,
        needPassword: this.needPassword,
        airplay2: this.airplay2,
        needPin: this.needPin,
        debug: true,
        transient: this.transient,
        borkedshp: this.borkedshp,
        log: this.log,
      });} catch(e){
      this.logLine?.(e)}
  }
  if (!this.rtsp) {
    return;
  }
  this.rtsp.on('config', (setup: any) => {
    this.audioLatency = setup.audioLatency;
    this.requireEncryption = setup.requireEncryption;
    this.serverPort = setup.server_port;
    this.controlPort = setup.control_port;
    this.timingPort = setup.timing_port;
    this.credentials = setup.credentials ;
    try {
      (this.audioOut as any)?.setLatencyFrames?.(this.audioLatency);
    } catch {
      /* ignore */
    }
  });

  this.rtsp.on('ready', () => {
    this.status = 'playing';
    this.emit('status','playing');
    this.relayAudio();
  });

  this.rtsp.on('need_password', () => {
    this.emit('status','need_password');
  });

  this.rtsp.on('pair_failed', () => {
    this.emit('status','pair_failed');
  });

  this.rtsp.on('pair_success', () => {
    this.emit('status','pair_success');
  });

  this.rtsp.on('end', (err: any) => {
    const reason = err == null ? 'unknown' : String(err);
    this.logLine?.(reason);
    this.cleanup(reason);

    if(reason !== 'stopped')
      this.emit(reason);
  });
  } catch(e){
    this.logLine?.(e)
  }
  // console.log(this.udpServers, this.host,this.port)
  if (!this.rtsp) {
    return;
  }
  this.rtsp.startHandshake(this.udpServers, this.host, this.port);
};

AirTunesDevice.prototype.relayAudio = function (this: AirTunesDeviceInstance): void {
  this.status = 'ready';
  this.emit('status', 'ready');

  let packetCount = 0;
  let byteCount = 0;
  let lastLogAt = 0;

  this.audioCallback = (packet: Packet) => {
    const airTunes = makeAirTunesPacket(
      packet,
      this.encoder,
      this.requireEncryption,
      this.alacEncoding,
      this.credentials,
      this.inputCodec,
    );
    // if (self.credentials) {
    //   airTunes = self.credentials.encrypt(airTunes)
    // }
    if(this.audioSocket == null){
      this.audioSocket = dgram.createSocket('udp4');
      this.audioSocket.on('error', (err) => {
        this.logLine?.('audio socket error', {
          host: this.host,
          port: this.serverPort,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    this.audioSocket.send(
      airTunes, 0, airTunes.length,
      this.serverPort, this.host,
      (err) => {
        if (err) {
          this.logLine?.('audio packet send failed', {
            host: this.host,
            port: this.serverPort,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    packetCount += 1;
    byteCount += airTunes.length;
    const now = Date.now();
    if (now - lastLogAt > 5000) {
      lastLogAt = now;
      if ((this.options as any)?.debug) {
        this.logLine?.('audio packet send stats', {
          host: this.host,
          port: this.serverPort,
          packets: packetCount,
          bytes: byteCount,
        });
      }
    }
  };
//   this.sendAirTunesPacket = function(airTunes) {
//     try{
//     if(self.audioSocket == null){
//       self.audioSocket = dgram.createSocket('udp4');
//     }
//     self.audioSocket.send(
//       airTunes, 0, airTunes.length,
//       self.serverPort, self.host
//     );} catch(e){

//       console.log('send error',e)
//     }
//   };

//   this.audioCallback = function(packet) {
//     var airTunes = makeAirTunesPacket(packet, self.encoder, self.requireEncryption, self.alacEncoding, self.credentials);
//     try{
//     self.sendAirTunesPacket(airTunes);
//     self.audioPacketHistory.add(packet.seq, airTunes); // If we need to resend it
//     } catch(e){}
//   };

//   this.udpServers.on('resendRequested', function (missedSeq, count) {
//     try{
//     for (var i = 0; i < count; i++) {
//     airTunes = self.audioPacketHistory.getLatestNamed(missedSeq + i);
//     if (airTunes != null)
//     self.sendAirTunesPacket(airTunes);}}
//     catch (_){}
//   });

  this.audioOut.on('packet', this.audioCallback);
};

AirTunesDevice.prototype.onSyncNeeded = function (this: AirTunesDeviceInstance, seq: number): void {
  this.udpServers.sendControlSync(seq, this);
  //if ( this.airplay2)this.rtsp.sendControlSync(seq, this, this.rtsp);
};

AirTunesDevice.prototype.cleanup = function (
  this: AirTunesDeviceInstance,
  reason = 'stopped',
): void {
  this.audioSocket = null;
  this.audioPacketHistory = null;
  this.status = 'stopped';
  this.emit('status', 'stopped', reason);
  // console.debug('stop');
  if(this.audioCallback) {
    this.audioOut.removeListener('packet', this.audioCallback);
    this.audioCallback = null;
  }

  this.udpServers.close();
  this.removeAllListeners();
  this.rtsp = null;
};

AirTunesDevice.prototype.reportStatus = function (this: AirTunesDeviceInstance): void {
   this.emit('status', this.status);
};

AirTunesDevice.prototype.stop = function (this: AirTunesDeviceInstance, cb?: () => void): void {
  try{
    if (!this.rtsp) return;
    this.rtsp.once('end', function() {
      if(cb)
        cb();
    });
    // console.debug('teardown');
    this.rtsp.teardown();
  } catch(_){}
};

AirTunesDevice.prototype.setVolume = function (this: AirTunesDeviceInstance, volume: number, callback?: (err?: unknown) => void): void {
  if (!this.rtsp) return;
  this.rtsp.setVolume(volume, callback);
};

AirTunesDevice.prototype.setTrackInfo = function (this: AirTunesDeviceInstance, name: string, artist?: string, album?: string, callback?: (err?: unknown) => void): void {
  if (!this.rtsp) return;
  this.rtsp.setTrackInfo(name, artist, album, callback);
};

AirTunesDevice.prototype.setProgress = function (this: AirTunesDeviceInstance, progress: number, duration: number, callback?: (err?: unknown) => void): void {
  if (!this.rtsp) return;
  this.rtsp.setProgress(progress, duration, callback);
};

AirTunesDevice.prototype.setArtwork = function (this: AirTunesDeviceInstance, art: Buffer, contentType?: string, callback?: (err?: unknown) => void): void {
  if (!this.rtsp) return;
  this.rtsp.setArtwork(art, contentType, callback);
};

AirTunesDevice.prototype.setPasscode = function (this: AirTunesDeviceInstance, password: string): void {
  if (!this.rtsp) return;
  this.rtsp.setPasscode(password);
};

AirTunesDevice.prototype.requireEncryption = function (this: AirTunesDeviceInstance): boolean {
  return Boolean(this.requireEncryption);
};

export default AirTunesDevice;


function makeAirTunesPacket(
  packet: Packet,
  encoder: any,
  requireEncryption: boolean,
  alacEncoding = true,
  credentials: any = null,
  inputCodec: 'pcm' | 'alac' = 'pcm',
): Buffer {
  const useAlacInput = inputCodec === 'alac';
  var alac = useAlacInput
    ? packet.pcm
    : (alacEncoding || credentials)
      ? encodePcmToAlac(packet.pcm)
      : pcmParse(packet.pcm);
  var airTunes = Buffer.alloc(alac.length + RTP_HEADER_SIZE);

  var header = makeRTPHeader(packet);
  if (requireEncryption) {
    alac = encryptAES(alac, alac.length);
  }
  if (credentials) {
    let pcm = credentials.encryptAudio(alac,header.slice(4,12),packet.seq)
    let airplay = Buffer.alloc(RTP_HEADER_SIZE + pcm.length);
    header.copy(airplay);
    pcm.copy(airplay, RTP_HEADER_SIZE);
    return airplay;
    // console.log(alac.length)
  }  else {
  header.copy(airTunes);
  alac.copy(airTunes, RTP_HEADER_SIZE);
  return airTunes;}
}

function pcmParse(pcmData: Buffer): Buffer {
    let dst = new Uint8Array(352 * 4);
    let src = pcmData;

    let a = 0;
    let b = 0;
    let size;
    for (size = 0; size < 352; size++) {
      dst[a++] = src[b + 1];
      dst[a++] = src[b++];
      b++;

      dst[a++] = src[b + 1];
      dst[a++] = src[b++];
      b++;
    }
    return Buffer.from(dst);
}

function encryptAES(alacData: Buffer, alacSize: number): Buffer {
  let result = Buffer.concat([])
  const isv = Buffer.from([0x78, 0xf4, 0x41, 0x2c, 0x8d, 0x17, 0x37, 0x90, 0x2b, 0x15, 0xa6, 0xb3, 0xee, 0x77, 0x0d, 0x67]);
  const aes_key = Buffer.from([0x14, 0x49, 0x7d, 0xcc, 0x98, 0xe1, 0x37, 0xa8, 0x55, 0xc1, 0x45, 0x5a, 0x6b, 0xc0, 0xc9, 0x79]);
  let remainder = alacData.length % 16
  let end_of_encoded_data = alacData.length - remainder;
  let cipher = crypto.createCipheriv('aes-128-cbc', aes_key, isv);
	cipher.setAutoPadding(false);

  let i = 0;
  let l = end_of_encoded_data - 16;
	for (i = 0, l = end_of_encoded_data - 16; i <= l; i += 16) {
      let chunk = cipher.update(alacData.slice(i,i+16))
      result = Buffer.concat([result,chunk])
	}
  return Buffer.concat([result, alacData.slice(end_of_encoded_data)]);
}



function makeRTPHeader(packet: Packet): Buffer {
  var header = Buffer.alloc(RTP_HEADER_SIZE);

  if(packet.seq === 0)
    header.writeUInt16BE(0x80e0, 0);
  else
    header.writeUInt16BE(0x8060, 0);

  header.writeUInt16BE(nu.low16(packet.seq), 2);

  header.writeUInt32BE(packet.timestamp, 4);
  header.writeUInt32BE(config.device_magic, 8);

  return header;
}
