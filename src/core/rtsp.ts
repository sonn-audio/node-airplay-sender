var net = require('net'),
    nodeCrypto = require('crypto'),
    events = require('events'),
    util = require('util'),
    fs = require('fs'),
    dgram = require('dgram');
const ntp = require('../utils/ntp').default ?? require('../utils/ntp');
const config = require('../utils/config').default ?? require('../utils/config');
const nu = require('../utils/numUtil');
const bplistCreator = require('bplist-creator');
const bplistParser   = require('bplist-parser');
const LegacySRP = require('./srp').default ?? require('./srp');
const {SRP, SRPClient, SrpClient}  = require('fast-srp-hap');
const ATVAuthenticator  = require('./atvAuthenticator').default ?? require('./atvAuthenticator');
const tlv = require('../homekit/tlv').default;
const enc = require('../homekit/encryption').default;
const Credentials = require('../homekit/credentials').Credentials;
const { method, attempt } = require('lodash');
const { hexString2ArrayBuffer } = require('../utils/util');
const ed25519_js = require('@noble/ed25519');
const curve25519_js = require('curve25519-js');
const varint = require('varint');
const struct = require('python-struct');
const { default: number } = require('../homekit/number');
var INFO = -1,
    OPTIONS = 0,
    ANNOUNCE = 1,
    SETUP = 2,
    RECORD = 3,
    SETVOLUME = 4,
    PLAYING = 5,
    TEARDOWN = 6,
    CLOSED = 7,
    SETDAAP = 8,
    SETART = 9,
    PAIR_VERIFY_1 = 10,
    PAIR_VERIFY_2 = 11,
    OPTIONS2 = 12,
    AUTH_SETUP = 13,
    PAIR_PIN_START = 14,
    PAIR_PIN_SETUP_1 = 15,
    PAIR_PIN_SETUP_2 = 16,
    PAIR_PIN_SETUP_3 = 17,
    PAIR_SETUP_1 = 18,
    PAIR_SETUP_2 = 19,
    PAIR_SETUP_3 = 20,
    PAIR_VERIFY_HAP_1 = 21,
    PAIR_VERIFY_HAP_2 = 22,
    SETUP_AP2_1 = 23,
    SETUP_AP2_2 = 24,
    SETPEERS = 25,
    FLUSH = 26,
    GETVOLUME = 27,
    SETPROGRESS = 28,
    OPTIONS3 = 29;

var rtsp_methods = ["INFO",
  "OPTIONS",
  "ANNOUNCE",
  "SETUP",
  "RECORD",
  "SETVOLUME",
  "PLAYING",
  "TEARDOWN",
  "CLOSED",
  "SETDAAP",
  "SETART",
  "PAIR_VERIFY_1",
  "PAIR_VERIFY_2",
  "OPTIONS2",
  "AUTH_SETUP",
  "PAIR_PIN_START",
  "PAIR_PIN_SETUP_1",
  "PAIR_PIN_SETUP_2",
  "PAIR_PIN_SETUP_3",
  "PAIR_SETUP_1",
  "PAIR_SETUP_2",
  "PAIR_SETUP_3",
  "PAIR_VERIFY_HAP_1",
  "PAIR_VERIFY_HAP_2",
  "SETUP_AP2_1",
  "SETUP_AP2_2",
  "SETPEERS",
  "FLUSH",
  "GETVOLUME",
  "SETPROGRESS",
  "OPTIONS3"
];

type AnyObject = Record<string, any>;
type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
type ClientInstance = AnyObject & {
  log?: LogFn;
  logLine?: (...args: any[]) => void;
};

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

function Client(this: ClientInstance, volume: number, password: string | null, audioOut: any, options: AnyObject) {
  events.EventEmitter.call(this);

  this.audioOut = audioOut;
  this.status = PAIR_VERIFY_1;
  this.socket = null;
  this.cseq = 0;
  this.announceId = null;
  this.activeRemote = nu.randomInt(9).toString().toUpperCase();
  this.dacpId = "04F8191D99BEC6E9";
  this.session = null;
  this.readySent = false;
  this.timeout = null;
  this.volume = volume;
  this.progress = 0;
  this.duration = 0;
  this.starttime = 0;
  this.password = password;
  this.passwordTried = false;
  this.requireEncryption = false;
  this.trackInfo = null;
  this.artwork = null;
  this.artworkContentType = null;
  this.callback = null;
  this.controlPort = null;
  this.timingPort  = null;
  this.sentFakeProgess = false;
  this.timingDestPort  = null;
  this.eventPort   = null;
  this.heartBeat = null;
  this.pair_verify_1_verifier = null;
  this.pair_verify_1_signature = null;
  this.code_digest = null;
  this.authSecret = null;
  this.mode = options?.mode ?? 0;
  this.dnstxt = options?.txt ?? [];
  this.alacEncoding = options?.alacEncoding ?? true;
  this.needPassword = options?.needPassword ?? false;
  this.airplay2 = options?.airplay2 ?? false;
  this.needPin = options?.needPin ?? false;
  this.debug = options?.debug ?? false;
  this.transient = options?.transient ?? false;
  this.borkedshp = options?.borkedshp ?? false;
  this.log = options?.log;
  this.logLine = (...args: any[]) => logLine(this, ...args);
  this.privateKey = null;
  this.srp = new SRP(2048);
  this.I = '366B4165DD64AD3A';
  this.P = null;
  this.s = null;
  this.B = null;
  this.a = null;
  this.A = null;
  this.M1 = null;
  this.epk = null;
  this.authTag = null;
  this._atv_salt = null;
  this._atv_pub_key = null;
  this._hap_genkey = null;
  this._hap_encrypteddata = null;
  this.pairingId = null;
  this.seed = null;
  this.credentials = null;
  this.event_credentials = null;
  this.verifier_hap_1 = null;
  this.encryptionKey = null;
  this.encryptedChannel = false;
  this.hostip = null;
  this.homekitver = this.transient ? "4" : "3";
  this.metadataReady = false;
  (this as AnyObject).connectAttempts = 0;
}

util.inherits(Client, events.EventEmitter);

export { Client };
export default { Client };

Client.prototype.startHandshake = function(this: ClientInstance, udpServers: any, host: string, port: number) {
  this.startTimeout();
  this.hostip = host;
  this.controlPort = udpServers.control.port;
  this.timingPort  = udpServers.timing.port;
  (this as AnyObject).connectAttempts = 0;

  const connect = () => {
    const attempt = (this as AnyObject).connectAttempts ?? 0;
    this.socket = net.connect(port, host, async () => {
      this.clearTimeout();
      (this as AnyObject).connectAttempts = 0;

      if (this.needPassword || this.needPin) {
        this.status = PAIR_PIN_START;
        this.sendNextRequest();
        this.startHeartBeat();
      } else {
        if (this.mode != 2) {
          if (this.debug) this.logLine?.("AUTH_SETUP","nah")
          this.status = OPTIONS;
          this.sendNextRequest();
          this.startHeartBeat();
        } 
        else {
          this.status = AUTH_SETUP;
          if (this.debug) this.logLine?.("AUTH_SETUP","yah")
          this.sendNextRequest();
          this.startHeartBeat();
        }
      }
    });

    let blob = '';
    this.socket.on('data', (data: Buffer) => {
      if (this.encryptedChannel && this.credentials){
        // if (this.debug != false) this.logLine?.("incoming", data)
        data = this.credentials.decrypt(data)
      }
      this.clearTimeout();

      /*
       * I wish I could use node's HTTP parser for this...
       * I assume that all responses have empty bodies.
       */
      const rawData = data;
      const dataStr = data.toString();

      blob += dataStr;
      let endIndex = blob.indexOf('\r\n\r\n');

      if (endIndex < 0) {
          return;
      }

      endIndex += 4;

      blob = blob.substring(0, endIndex);
      this.processData(blob, rawData);

      blob = dataStr.substring(endIndex);
    });

    this.socket.on('error', (err: any) => {
      this.socket = null;
      this.clearTimeout();
      const nextAttempt = ((this as AnyObject).connectAttempts ?? 0) + 1;
      (this as AnyObject).connectAttempts = nextAttempt;
      const shouldRetry = nextAttempt <= config.rtsp_retry_attempts;
      if (shouldRetry) {
        const baseBackOff = Math.min(
          config.rtsp_retry_base_ms * Math.pow(2, nextAttempt - 1),
          config.rtsp_retry_max_ms
        );
        const jitter = Math.random() * config.rtsp_retry_jitter_ms;
        const backOff = baseBackOff + jitter;
        if (this.debug) this.logLine?.('rtsp_retry', { attempt: nextAttempt, backOff, code: err?.code });
        setTimeout(() => {
          this.startTimeout();
          connect();
        }, backOff);
        return;
      }

      if (this.debug) this.logLine?.(err?.code);
      if(err?.code === 'ECONNREFUSED'){
        if (this.debug) this.logLine?.('block');
        this.cleanup('connection_refused');}
      else
        this.cleanup('rtsp_socket', err?.code);
    });

    this.socket.on('end', () => {
      if (this.debug) this.logLine?.('block2');
      this.cleanup('disconnected');
    });
  };

  connect();
};

Client.prototype.startTimeout = function(this: ClientInstance) {
  if (this.timeout) {
    clearTimeout(this.timeout);
    this.timeout = null;
  }
  this.timeout = setTimeout(() => {
    if (this.debug) this.logLine?.('timeout');
    this.cleanup('timeout');
  }, config.rtsp_timeout);
};

Client.prototype.clearTimeout = function(this: ClientInstance) {
  if(this.timeout !== null) {
    clearTimeout(this.timeout);
    this.timeout = null;
  }
};

Client.prototype.teardown = function(this: ClientInstance) {
  if(this.status === CLOSED) {
    this.emit('end', 'stopped');
    return;
  }

  this.status = TEARDOWN;
  this.sendNextRequest();
};

Client.prototype.setVolume = function(this: ClientInstance, volume: number, callback?: (err?: unknown) => void) {
  if(this.status !== PLAYING)
    return;

  this.volume = volume;
  this.callback = callback;
  this.status = SETVOLUME;
  this.sendNextRequest();
};

// Drop the receiver's buffered audio and re-anchor playback at the current RTP
// position (RTP-Info: seq=lastSeq+1). Used on track switch/scrub so the new
// track starts cleanly instead of replaying stale buffered frames.
Client.prototype.flush = function(this: ClientInstance) {
  if(this.status !== PLAYING)
    return;

  this.status = FLUSH;
  this.sendNextRequest();
};

Client.prototype.setProgress = function(this: ClientInstance, progress: number, duration: number, callback?: (err?: unknown) => void) {
  if(this.status !== PLAYING)
    return;
  let normProgress = progress;
  let normDuration = duration;
  if (normDuration > 1000) {
    if (normProgress > 1000) {
      normProgress = Math.round(normProgress / 1000);
    }
    normDuration = Math.round(normDuration / 1000);
  }
  if (normDuration > 0) {
    normProgress = Math.min(Math.max(0, normProgress), normDuration);
  }
  this.progress = normProgress;
  this.duration = normDuration;
  this.callback = callback;
  this.status = SETPROGRESS;
  this.sendNextRequest();
};

Client.prototype.setPasscode = async function(this: ClientInstance, passcode: string) {
  this.password = passcode;
  this.status = this.airplay2 ? PAIR_SETUP_1 : PAIR_PIN_SETUP_1;
  this.sendNextRequest();
}

Client.prototype.startHeartBeat = function(this: ClientInstance) {
  if (this.heartBeat) {
    clearInterval(this.heartBeat);
    this.heartBeat = null;
  }
  if (config.rtsp_heartbeat > 0){
    this.heartBeat = setInterval(() => {
      this.sendHeartBeat(() => {
        //this.logLine?.('HeartBeat sent!');
      });
    }, config.rtsp_heartbeat);
  }
};

Client.prototype.sendHeartBeat = function(this: ClientInstance, callback?: (err?: unknown) => void) {
  if(this.status !== PLAYING)
    return;

  this.status = OPTIONS;
  this.callback = callback;
  this.sendNextRequest();
};

Client.prototype.setTrackInfo = function(this: ClientInstance, name: string, artist?: string, album?: string, callback?: (err?: unknown) => void) {
  if(this.status !== PLAYING)
    return;
  if (name != this.trackInfo?.name || artist != this.trackInfo?.artist || album != this.trackInfo?.album) {
    this.starttime = this.audioOut.lastSeq *config.frames_per_packet + 2*config.sampling_rate;
  }
  this.trackInfo = {
    name: name,
    artist: artist,
    album: album
  };
  this.status = SETDAAP;
  this.callback = callback;
  this.sendNextRequest();
};

Client.prototype.setArtwork = function(this: ClientInstance, art: Buffer | string, contentType?: string | null, callback?: (err?: unknown) => void) {
  if(this.status !== PLAYING)
    return;

  if (typeof contentType == 'function') {
    callback = contentType;
    contentType = null;
  }

  if (typeof art == 'string') {
    if (contentType === null) {
      var ext = art.slice(-4);
      if (ext == ".jpg" || ext == "jpeg") {
        contentType = "image/jpeg";
      } else if (ext == ".png") {
        contentType = "image/png";
      } else if (ext == ".gif") {
        contentType = "image/gif";
      } else {
        return this.cleanup('unknown_art_file_ext');
      }
    }
    return fs.readFile(art, (err: NodeJS.ErrnoException | null, data: Buffer) => {
      if (err !== null) {
        return this.cleanup('invalid_art_file');
      }
      this.setArtwork(data, contentType, callback);
    });
  }

  if (contentType === null)
    return this.cleanup('no_art_content_type');

  this.artworkContentType = contentType;
  this.artwork = art;
  this.status = SETART;
  this.callback = callback;
  this.sendNextRequest();
};

Client.prototype.nextCSeq = function(this: ClientInstance) {
  this.cseq += 1;

  return this.cseq;
};

Client.prototype.cleanup = function(this: ClientInstance, type: string, msg?: any) {
  this.emit('end', type, msg);
  this.status = CLOSED;
  this.trackInfo = null;
  this.artwork = null;
  this.artworkContentType = null;
  this.callback = null;
  this.srp = null;
  this.P = null;
  this.s = null;
  this.B = null;
  this.a = null;
  this.A = null;
  this.M1 = null;
  this.epk = null;
  this.authTag = null;
  this._hap_genkey = null;
  this._hap_encrypteddata = null;
  this.seed = null;
  this.credentials = null;
  // this.password = null;
  this.removeAllListeners();

  if(this.timeout) {
    clearTimeout(this.timeout);
    this.timeout = null;
  }

  if (this.heartBeat) {
    clearInterval(this.heartBeat);
    this.heartBeat = null;
  }

  if(this.socket) {
    this.socket.destroy();
    this.socket = null;
  }

  if (this.eventsocket) {
    try {
      this.eventsocket.destroy?.();
      this.eventsocket = null;
    } catch {
      /* ignore */
    }
  }

  if (this.controlsocket) {
    try {
      this.controlsocket.close();
    } catch {
      /* ignore */
    }
    this.controlsocket = null;
  }

  if (this.timingsocket) {
    try {
      this.timingsocket.close();
    } catch {
      /* ignore */
    }
    this.timingsocket = null;
  }

  const audioSocket = (this as AnyObject).audioSocket;
  if (audioSocket) {
    try {
      audioSocket.close?.();
      audioSocket.destroy?.();
    } catch {
      /* ignore */
    }
    (this as AnyObject).audioSocket = null;
  }
};

function parseResponse(blob: string): AnyObject {
  var response: AnyObject = {}, lines = blob.split('\r\n');


  if (lines[0].match(/^Audio-Latency/)) {
      let tmp = lines[0];
      lines[0] = lines[1];
      lines[1] = tmp;
  }

  var codeRes = /(\w+)\/(\S+) (\d+) (.*)/.exec(lines[0]);
  if(!codeRes) {
    response.code = 599;
    response.status = 'UNEXPECTED ' + lines[0];

    return response;
  }

  response.code = parseInt(codeRes[3], 10);
  response.status = codeRes[4];

  var headers: AnyObject = {};
  lines.slice(1).forEach(function(line: string) {
    var res = /([^:]+):\s*(.*)/.exec(line);

    if(!res)
      return;

    headers[res[1]] = res[2];
  });

  response.headers = headers;
  //this.logLine?.(response);
  return response;
}

function parseResponse2(blob: string, self: ClientInstance): AnyObject {

  var response: AnyObject = {}, lines = blob.split('\r\n');
  // if (self.debug) self.logLine?.(lines);


  if (lines[0].match(/^Audio-Latency/)) {
      let tmp = lines[0];
      lines[0] = lines[1];
      lines[1] = tmp;
  }

  var codeRes = /(\w+)\/(\S+) (\d+) (.*)/.exec(lines[0]);
  if(!codeRes) {
    response.code = 599;
    response.status = 'UNEXPECTED ' + lines[0];

    return response;
  }

  response.code = parseInt(codeRes[3], 10);
  response.status = codeRes[4];

  var headers: AnyObject = {};
  lines.slice(1).forEach(function(line: string) {
    var res = /([^:]+):\s*(.*)/.exec(line);

    if(!res)
      return;

    headers[res[1]] = res[2];
  });

  response.headers = headers;

  // if (this.debug) this.logLine?.('res: ', response);
  return response;
}

function md5(str: string) {
  var md5sum = nodeCrypto.createHash('md5');
  md5sum.update(str);

  return md5sum.digest('hex').toUpperCase();
}

function md5norm(str: string) {
  var md5sum = nodeCrypto.createHash('md5');
  md5sum.update(str);

  return md5sum.digest('hex');
}

Client.prototype.makeHead = function(this: ClientInstance, method: string, uri: string, di?: any, clear = false, dimode: any = null) {
  var head = method + ' ' + uri + ' RTSP/1.0' + '\r\n'
  if (!clear){
    head += 'CSeq: ' + this.nextCSeq() + '\r\n' +
    'User-Agent: ' + (this.airplay2 ? "AirPlay/409.16": config.user_agent) + '\r\n' +
    'DACP-ID: ' + this.dacpId + '\r\n' +
    (this.session ? 'Session: ' + this.session + '\r\n' : '') +
    'Active-Remote: ' + this.activeRemote + '\r\n'
    head += 'Client-Instance: ' + this.dacpId + '\r\n'
  };

  if(di) {
    if (dimode == 'airplay2') {
      var ha1 = md5norm(di.username + ':' + di.realm + ':' + di.password);
      var ha2 = md5norm(method + ':' + uri);
      var diResponse = md5(ha1 + ':' + di.nonce + ':' + ha2);
    } else {
    var ha1 = md5(di.username + ':' + di.realm + ':' + di.password);
    var ha2 = md5(method + ':' + uri);
    var diResponse = md5(ha1 + ':' + di.nonce + ':' + ha2);}

    head += 'Authorization: Digest ' +
      'username="' + di.username + '", ' +
      'realm="' + di.realm + '", ' +
      'nonce="' + di.nonce + '", ' +
      'uri="' + uri + '", ' +
      'response="' + diResponse + '"\r\n';
  }

  return head;
}

Client.prototype.makeHeadWithURL = function(this: ClientInstance, method: string, digestInfo: any, dimode: any) {
  return this.makeHead(method, 'rtsp://' + this.socket.address().address + '/' + this.announceId, digestInfo, false, dimode);
}

Client.prototype.makeRtpInfo = function(this: ClientInstance) {
  var nextSeq = this.audioOut.lastSeq + 1;
  var rtpSyncTime = nextSeq*config.frames_per_packet + 2*config.sampling_rate;
  return 'RTP-Info: seq=' + nextSeq + ';rtptime=' + rtpSyncTime + '\r\n';
};

Client.prototype.sendNextRequest = async function(this: ClientInstance, di?: any) {

  var request: any = '';
  var body = '';
  if (this.debug) this.logLine?.('Sending request:', rtsp_methods[this.status+1]);
  switch(this.status) {
  case PAIR_PIN_START:
    this.I = '366B4165DD64AD3A';
    this.P = null;
    this.s = null;
    this.B = null;
    this.a = null;
    this.A = null;
    this.M1 = null;
    this.epk = null;
    this.authTag = null;
    this._atv_salt = null;
    this._atv_pub_key = null;
    this._hap_encrypteddata = null;
    this.seed = null;
    this.pairingId = nodeCrypto.randomUUID();
    this.credentials = null;
    this.verifier_hap_1 = null;
    this.encryptionKey = null;

    request = ''
    if (this.transient && (this.needPin != true) && (this.needPassword != true)) {
      (this.status = PAIR_SETUP_1)
      this.sendNextRequest();
    } else 
    if (this.needPin){
    request += this.makeHead("POST","/pair-pin-start", "", true);
    if (this.airplay2){
      request += 'User-Agent: AirPlay/409.16\r\n'
      request += 'Connection: keep-alive\r\n'
      request += 'CSeq: ' + 0 + '\r\n' ;
    }

    request += 'Content-Length:' + 0 + '\r\n\r\n';
    this.socket.write(Buffer.from(request, 'utf-8'))} else {
      if (this.password) {
        this.status = this.airplay2 ? PAIR_SETUP_1 : PAIR_PIN_SETUP_1;
        this.sendNextRequest();
      } else {
        if (!this.needPassword) {
          this.status = this.airplay2 ? INFO : PAIR_PIN_SETUP_1;
          this.sendNextRequest();
        } else {
          this.emit("need_password");
        }
      }
    }
    request = ''
  //}
  break;
  case PAIR_PIN_SETUP_1:
    request = ''
    request += this.makeHead("POST","/pair-setup-pin", "", true);
    request += 'Content-Type: application/x-apple-binary-plist\r\n'
    let u =  bplistCreator({
      user: '366B4165DD64AD3A',
      method: 'pin'
    });
    request += 'Content-Length:' + Buffer.byteLength(u) + '\r\n\r\n';
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),u]))
    request = ''
  break;
  case PAIR_PIN_SETUP_2:
    request = ''
    request += this.makeHead("POST","/pair-setup-pin", "", true);
    request += 'Content-Type: application/x-apple-binary-plist\r\n'
    let u1 =  bplistCreator({
      pk: Buffer.from(this.A, 'hex'),
      proof: Buffer.from(this.M1, 'hex')
    });
    request += 'Content-Length:' + Buffer.byteLength(u1) + '\r\n\r\n';
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),u1]))
    request = ''
  break;
  case PAIR_PIN_SETUP_3:
    request = ''
    request += this.makeHead("POST","/pair-setup-pin", "", true);
    request += 'Content-Type: application/x-apple-binary-plist\r\n'
    let u2 =  bplistCreator({
      epk: Buffer.from(this.epk, 'hex'),
      authTag: Buffer.from(this.authTag, 'hex')
    });
    request += 'Content-Length:' + Buffer.byteLength(u2) + '\r\n\r\n';
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),u2]))
    request = ''
  break;
  case PAIR_VERIFY_1:
    request = ''
    request += this.makeHead("POST","/pair-verify", "", true);
    request += 'Content-Type: application/octet-stream\r\n'
    this.pair_verify_1_verifier = ATVAuthenticator.verifier(this.authSecret);
    request += 'Content-Length:' + Buffer.byteLength(this.pair_verify_1_verifier.verifierBody) + '\r\n\r\n';
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),this.pair_verify_1_verifier.verifierBody]))
    request = ''
  break;
  case PAIR_VERIFY_2:
    request = ''
    request += this.makeHead("POST","/pair-verify", "", true);
    request += 'Content-Type: application/octet-stream\r\n'
    request += 'Content-Length:' + Buffer.byteLength(this.pair_verify_1_signature) + '\r\n\r\n';
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),this.pair_verify_1_signature]))
    request = ''
    // const verifier = ATVAuthenticator.verifier('3c0591f41d1236c9ce5078sscd6fcd42f71f374b8b6dff33fea825366f1c34f828');
    // request += 'Content-Length:' + Buffer.byteLength(verifier.verifierBody) + '\r\n\r\n';
    // this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),verifier.verifierBody]))
    // request = ''
  break;
  case PAIR_SETUP_1:
    if (this.debug) this.logLine?.('loh')
    request = ''
    request += this.makeHead("POST","/pair-setup", "", true);
    request += 'User-Agent: AirPlay/409.16\r\n'
    request += 'CSeq: ' + this.nextCSeq() + '\r\n' ;
    request += 'Connection: keep-alive\r\n'
    request += 'X-Apple-HKP: '+ this.homekitver +'\r\n'

    this.logLine?.('rtsp.transient',this.transient)
    if (this.transient == true) {
      this.logLine?.('rtsp.transient','uas')
     let ps1 = tlv.encode(
              tlv.Tag.Sequence, 0x01,
              tlv.Tag.PairingMethod, 0x00,
              tlv.Tag.Flags, 0x00000010,
    );

    request += 'Content-Length: ' + Buffer.byteLength(ps1) + '\r\n';
    request += 'Content-Type: application/octet-stream' + '\r\n\r\n'
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),ps1]))
    } else {

      let ps1 = tlv.encode(
        tlv.Tag.PairingMethod, 0x00,
        tlv.Tag.Sequence, 0x01,
      );
    request += 'Content-Length: ' + 6 + '\r\n';
    request += 'Content-Type: application/octet-stream' + '\r\n\r\n'
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),ps1]))}

    request = ''
  break;
  case PAIR_SETUP_2:
    if (this.debug) this.logLine?.('loh2')
    request = ''
    request += this.makeHead("POST","/pair-setup", "", true);
    request += 'User-Agent: AirPlay/409.16\r\n'
    request += 'CSeq: ' + this.nextCSeq() + '\r\n' ;
    request += 'Connection: keep-alive\r\n'
    request += 'X-Apple-HKP: '+ this.homekitver +'\r\n'
    request += 'Content-Type: application/octet-stream\r\n'
    let ps2 = tlv.encode(
      tlv.Tag.Sequence, 0x03,
      tlv.Tag.PublicKey, this.A,
      tlv.Tag.Proof, this.M1,
    )
    request += 'Content-Length: ' + Buffer.byteLength(ps2) + '\r\n\r\n';
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),ps2]))
    request = ''
  break;
  case PAIR_SETUP_3:
    if (this.debug) this.logLine?.('loh3')
    request = ''
    request += this.makeHead("POST","/pair-setup", "", true);
    request += 'User-Agent: AirPlay/409.16\r\n'
    request += 'CSeq: ' + this.nextCSeq() + '\r\n' ;
    request += 'Connection: keep-alive\r\n'
    request += 'X-Apple-HKP: '+ this.homekitver +'\r\n'
    request += 'Content-Type: application/octet-stream\r\n'
    this.K = this.srp.computeK()
    this.seed = nodeCrypto.randomBytes(32);
    // let keyPair = ed25519.MakeKeypair(this.seed);
    this.privateKey = ed25519_js.utils.randomPrivateKey();
    let publicKey = await ed25519_js.getPublicKey(this.privateKey);
    // let keyPair = nacl.sign.keyPair.fromSeed(this.seed)
    // let privateKey = keyPair.secretKey;
    // let publicKey = keyPair.publicKey;
    let deviceHash = enc.HKDF(
        "sha512",
        Buffer.from("Pair-Setup-Controller-Sign-Salt"),
        this.K,
        Buffer.from("Pair-Setup-Controller-Sign-Info"),
        32
    );
    let deviceInfo = Buffer.concat([deviceHash, Buffer.from(this.pairingId), publicKey]);
    let deviceSignature = await ed25519_js.sign(deviceInfo, this.privateKey);
    // let deviceSignature = nacl.sign(deviceInfo, privateKey)
    this.encryptionKey = enc.HKDF(
        "sha512",
        Buffer.from("Pair-Setup-Encrypt-Salt"),
        this.K,
        Buffer.from("Pair-Setup-Encrypt-Info"),
        32
    );
    let tlvData = tlv.encode(
        tlv.Tag.Username, Buffer.from(this.pairingId),
        tlv.Tag.PublicKey, publicKey,
        tlv.Tag.Signature, deviceSignature
      );
    let encryptedTLV = Buffer.concat(enc.encryptAndSeal(tlvData, null, Buffer.from('PS-Msg05'), this.encryptionKey));
      // this.logLine?.("DEBUG: Encrypted Data=" + encryptedTLV.toString('hex'));
    let outerTLV = tlv.encode(
        tlv.Tag.Sequence, 0x05,
        tlv.Tag.EncryptedData, encryptedTLV
    );
    request += 'Content-Length: ' + Buffer.byteLength(outerTLV) + '\r\n\r\n';
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),outerTLV]))
    request = ''
  break;
  case PAIR_VERIFY_HAP_1:
    request = ''
    request += this.makeHead("POST","/pair-verify", "", true);
    request += 'User-Agent: AirPlay/409.16\r\n'
    request += 'CSeq: ' + this.nextCSeq() + '\r\n' ;
    request += 'Connection: keep-alive\r\n'
    request += 'X-Apple-HKP: '+ this.homekitver +'\r\n'
    request += 'Content-Type: application/octet-stream\r\n'

    let hap1kp = curve25519_js.generateKeyPair(Buffer.alloc(32))
    this.verifyPrivate = Buffer.from(hap1kp.private)
    this.verifyPublic = Buffer.from(hap1kp.public)
    // this.verifyPrivate = Buffer.alloc(32);
    // curve25519.makeSecretKey(this.verifyPrivate);
    // this.verifyPublic = curve25519.derivePublicKey(this.verifyPrivate);
    let encodedData = tlv.encode(
      tlv.Tag.Sequence, 0x01,
      tlv.Tag.PublicKey, this.verifyPublic
    );
    request += 'Content-Length: ' + Buffer.byteLength(encodedData) + '\r\n\r\n';
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),encodedData]))
    request = ''
  break;
  case PAIR_VERIFY_HAP_2:
    request = ''
    request += this.makeHead("POST","/pair-verify", "", true);
    request += 'User-Agent: AirPlay/409.16\r\n'
    request += 'CSeq: ' + this.nextCSeq() + '\r\n' ;
    request += 'Connection: keep-alive\r\n'
    request += 'X-Apple-HKP: '+ this.homekitver +'\r\n'
    request += 'Content-Type: application/octet-stream\r\n'
    let identifier = tlv.decode(this.verifier_hap_1.pairingData)[tlv.Tag.Username];
    let signature  = tlv.decode(this.verifier_hap_1.pairingData)[tlv.Tag.Signature];
    let material = Buffer.concat([this.verifyPublic, Buffer.from(this.credentials.pairingId), this.verifier_hap_1.sessionPublicKey]);
    // let keyPair1 = ed25519.MakeKeypair(this.credentials.encryptionKey);
    // let signed = ed25519.Sign(material, keyPair1);
    // let keyPair1 = ed25519.MakeKeypair(this.credentials.encryptionKey);
    let signed = await ed25519_js.sign(material, this.privateKey);
    this.logLine?.("lengths", this.credentials.encryptionKey.length)
    // let keyPair1 = nacl.sign.keyPair.fromSeed(this.credentials.encryptionKey)
    // let signed = nacl.sign(material, keyPair1.secretKey);
    let plainTLV = tlv.encode(
      tlv.Tag.Username, Buffer.from(this.credentials.pairingId),
      tlv.Tag.Signature, signed
    );
    let encryptedTLV1 = Buffer.concat(enc.encryptAndSeal(plainTLV, null, Buffer.from('PV-Msg03'), this.verifier_hap_1.encryptionKey));
    let pv2 = tlv.encode(
      tlv.Tag.Sequence, 0x03,
      tlv.Tag.EncryptedData, encryptedTLV1
    );
    request += 'Content-Length: ' + Buffer.byteLength(pv2) + '\r\n\r\n';
    this.socket.write(Buffer.concat([Buffer.from(request, 'utf-8'),pv2]))
    request = ''
  break;
  case AUTH_SETUP:
    request = ''
    request += this.makeHead("POST","/auth-setup", di);
    request += 'Content-Length: ' + 33 + '\r\n\r\n';
    let finalbuffer = Buffer.concat([Buffer.from(request, 'utf-8'),
    Buffer.from([0x01, // unencrypted
            0x4e,0xea,0xd0,0x4e,0xa9,0x2e,0x47,0x69,
            0xd2,0xe1,0xfb,0xd0,0x96,0x81,0xd5,0x94,
            0xa8,0xef,0x18,0x45,0x4a,0x24,0xae,0xaf,
            0xb3,0x14,0x97,0x0d,0xa0,0xb5,0xa3,0x49])
          ])
    if (this.airplay2 != true && this.credentials != null){
      try {
        this.socket.write(this.credentials.encrypt(finalbuffer))
      } catch (e){

      }
    } else {
      this.socket.write(finalbuffer)
    }

    request = ''
    // this.status = OPTIONS;
    // this.sendNextRequest()
  break;
  case OPTIONS:
    request += this.makeHead('OPTIONS', '*', di);
    if (this.airplay2){
      request += 'User-Agent: AirPlay/409.16\r\n'
      request += 'Connection: keep-alive\r\n'
    }
    request += 'Apple-Challenge: SdX9kFJVxgKVMFof/Znj4Q\r\n\r\n';
  break;
  case OPTIONS2:

      request = ''
      request += this.makeHead('OPTIONS', '*');
      request += this.code_digest;
      this.logLine?.(request)
      this.socket.write(Buffer.from(request, 'utf-8'))
      request = ''
  break;
  case OPTIONS3:
  request = ''
  request += this.makeHead('OPTIONS', '*', di);
  this.logLine?.(request)
  this.socket.write(Buffer.from(request, 'utf-8'))
  request = ''
  break;
  case ANNOUNCE:
    if (this.announceId == null) {
    this.announceId = nu.randomInt(10);}

    body =
      'v=0\r\n' +
      'o=iTunes ' + this.announceId +' 0 IN IP4 ' + this.socket.address().address + '\r\n' +
      's=iTunes\r\n' +
      'c=IN IP4 ' + this.socket.address().address + '\r\n' +
      't=0 0\r\n' +
      'm=audio 0 RTP/AVP 96\r\n';
    if (!this.alacEncoding){
      body = body + 'a=rtpmap:96 L16/44100/2\r\n' +
      'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100\r\n'} else {
      body = body + 'a=rtpmap:96 AppleLossless\r\n' +
      'a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100\r\n'
      }
;
    if (this.requireEncryption) {
      body +=
        'a=rsaaeskey:' + config.rsa_aeskey_base64 + '\r\n' +
        'a=aesiv:' + config.iv_base64 + '\r\n';
    }

    request += this.makeHeadWithURL('ANNOUNCE', di);
    request +=
      'Content-Type: application/sdp\r\n' +
      'Content-Length: ' + body.length + '\r\n\r\n';

    request += body;
    //this.logLine?.(request);
  break;
  case SETUP:
    request += this.makeHeadWithURL('SETUP', di);
    request +=
      'Transport: RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;' +
      'control_port=' + this.controlPort + ';' +
      'timing_port=' + this.timingPort + '\r\n\r\n';
    //this.logLine?.(request);
  break;
  case INFO:
    request += this.makeHead('GET', '/info',  di, true);
    request += 'User-Agent: AirPlay/409.16\r\n'
    request += 'Connection: keep-alive\r\n'
    request += 'CSeq: ' + this.nextCSeq() + '\r\n\r\n' ;
    if (this.credentials){
    let enct1x = this.credentials.encrypt(Buffer.concat([Buffer.from(request, 'utf-8')]));
    this.socket.write(enct1x)
    request = ''}
    //this.logLine?.(request);
  break;
  case SETUP_AP2_1:
    if (this.announceId == null) {
      this.announceId = nu.randomInt(10);}
    request += this.makeHeadWithURL('SETUP', di, "airplay2");
    request += 'Content-Type: application/x-apple-binary-plist\r\n'
    // request += 'CSeq: ' + this.nextCSeq() + '\r\n' ;
    // this.timingPort = 32325;
    this.logLine?.('starting ports', this.timingPort, this.controlPort)
    let setap1 =  bplistCreator(
      {deviceID: '2C:61:F3:B6:64:C1',
      sessionUUID: '8EB266BA-B741-40C5-8213-4B7A38DF8773',
      timingPort: this.timingPort,
      timingProtocol: 'NTP'
      // ekey: config.rsa_aeskey_base64,
      // eiv: config.iv_base64
    }
    )
    ;
    try{this.timingsocket.close();} catch(e){}
    try{
    this.timingsocket = dgram.createSocket({type: 'udp4', reuseAddr: true});
    this.timingsocket.on('message', (msg: Buffer, rinfo: any) => {

    // only listen and respond on own hosts
    // if (this.hosts.indexOf(rinfo.address) < 0) return;

      var ts1 = msg.readUInt32BE(24);
      var ts2 = msg.readUInt32BE(28);

      var reply = Buffer.alloc(32);
      reply.writeUInt16BE(0x80d3, 0);
      reply.writeUInt16BE(0x0007, 2);
      reply.writeUInt32BE(0x00000000, 4);

      reply.writeUInt32BE(ts1, 8);
      reply.writeUInt32BE(ts2, 12);

      var ntpTime = ntp.timestamp();

      ntpTime.copy(reply, 16);
      ntpTime.copy(reply, 24);

      this.timingsocket.send(
        reply, 0, reply.length,
        rinfo.port, rinfo.address
      );
      this.logLine?.('timing socket pinged', rinfo.port, rinfo.address)
    });
    this.timingsocket.bind(this.timingPort, this.socket.address().address);} catch(e){}
    request += 'Content-Length: ' + Buffer.byteLength(setap1) + '\r\n\r\n';
    this.logLine?.(request)
    let s1ct = this.credentials.encrypt(Buffer.concat([Buffer.from(request, 'utf-8'),setap1]));
    this.socket.write(s1ct);
    request = ''
  break;
  case SETPEERS:
    request += this.makeHeadWithURL('SETPEERS', di);
    request += 'Content-Type: /peer-list-changed\r\n'
    let speers =  bplistCreator([
      this.hostip, this.socket.address().address
    ]);
    this.logLine?.([
      this.hostip, this.socket.address().address
    ])
    request += 'Content-Length: ' + Buffer.byteLength(speers) + '\r\n\r\n';
    let spct = this.credentials.encrypt(Buffer.concat([Buffer.from(request, 'utf-8'),speers]));
    this.socket.write(spct);
    request = ''
  break;
  case FLUSH:
    request += this.makeHeadWithURL('FLUSH', di);
    request += this.makeRtpInfo()+ '\r\n';
    let fct = this.credentials.encrypt(Buffer.concat([Buffer.from(request, 'utf-8')]));
    this.socket.write(fct);
    request = ''
  break;
  case SETUP_AP2_2:
    if (this.announceId == null) {
      this.announceId = nu.randomInt(10);}
    request += this.makeHeadWithURL('SETUP', di);
    request += 'Content-Type: application/x-apple-binary-plist\r\n'
    let setap2 =  bplistCreator(
      {streams: [{audioFormat: 262144, // PCM/44100/16/2
          audioMode: 'default',
          controlPort: this.controlPort,
          ct: 2,
          isMedia: true,
          latencyMax: 88200,
          latencyMin: 11025,
          shk: Buffer.from(this.credentials.writeKey),
          spf: 352,
          sr: 44100,
          type: 0x60,
          supportsDynamicStreamID: false,
          streamConnectionID: this.announceId
          }]});
    request += 'Content-Length: ' + Buffer.byteLength(setap2) + '\r\n\r\n';
    this.controlsocket = dgram.createSocket({type: 'udp4', reuseAddr: true});
    this.controlsocket.on('message', (msg: Buffer) => {
      this.logLine?.('controlsocket.data',msg)
    })
    this.controlsocket.bind(this.controlPort, this.socket.address().address);
    let s2ct = this.credentials.encrypt(Buffer.concat([Buffer.from(request, 'utf-8'),setap2]));
    this.socket.write(s2ct);
    request = ''
  break;
  case RECORD:
    //this.logLine?.(request);
    if (this.airplay2){
    this.event_credentials =  new Credentials(
      "sdsds",
      "",
      "",
      "",
      this.seed
    );
    this.event_credentials.writeKey = enc.HKDF(
      "sha512",
      Buffer.from("Events-Salt"),
      this.srp.computeK(),
      Buffer.from("Events-Read-Encryption-Key"),
      32
    );
    this.event_credentials.readKey = enc.HKDF(
      "sha512",
      Buffer.from("Events-Salt"),
      this.srp.computeK(),
      Buffer.from("Events-Write-Encryption-Key"),
      32
    );
    this.eventsocket = net.connect(this.eventPort, this.hostip, async () => {

    });
    this.eventsocket.on('data', (data: Buffer) => {
      if (this.debug) {
        this.logLine?.('eventsocket.data', data)
        try {
          const decrypted = this.event_credentials?.decrypt(data);
          if (decrypted) {
            this.logLine?.('eventsocket.data2', decrypted.toString());
          }
        } catch (err) {
          this.logLine?.('eventsocket.decrypt.error', err);
        }
      }

    });
    this.eventsocket.on('error', (err: any) => {
      if (this.debug) this.logLine?.('eventsocket.error', err)
    })
    }
    if (this.airplay2 != null && this.credentials != null) {
    //  this.controlsocket.close();
      var nextSeq = this.audioOut.lastSeq + 10;
      var rtpSyncTime = nextSeq*config.frames_per_packet + 2*config.sampling_rate;
      request += this.makeHead('RECORD', 'rtsp://' + this.socket.address().address + '/' + this.announceId, di, true);
      request += 'CSeq: '+ ++this.cseq+ '\r\n';
      request += 'User-Agent: AirPlay/409.16' + '\r\n';
      request += 'Client-Instance: ' + this.dacpId + '\r\n'
      request += 'DACP-ID: ' + this.dacpId + '\r\n';
      request += 'Active-Remote: ' + this.activeRemote+ '\r\n';
      request += 'X-Apple-ProtocolVersion: 1\r\n'
      request += 'Range: npt=0-\r\n'
      request += this.makeRtpInfo()+ '\r\n';
      // request += '\r\n';
      this.logLine?.('ssdas3', request)
      let rct = this.credentials.encrypt(Buffer.from(request, 'utf-8'));
      this.socket.write(rct);
      request = ""
    } else {
      request += this.makeHeadWithURL('RECORD', di);
      request += 'Range: npt=0-\r\n'
      request += this.makeRtpInfo()+ '\r\n';
    }
  break;
  case GETVOLUME:
    body = "volume\r\n"
    request += this.makeHeadWithURL('GET_PARAMETER', di);
    request +=
    'Content-Type: text/parameters\r\n' +
    'Content-Length: ' + body.length + '\r\n\r\n';
    if (this.airplay2) {
      let rct2 = this.credentials.encrypt(Buffer.concat([Buffer.from(request+body, 'utf-8')]));
      this.socket.write(rct2);
      request = ""

    } else {

    }
  break;
  case SETVOLUME:
    var attenuation =
      this.volume === 0.0 ?
      -144.0 :
      (-30.0)*(100 - this.volume)/100.0;

    body = 'volume: ' + attenuation + '\r\n';

    request += this.makeHeadWithURL('SET_PARAMETER', di);
    request +=
      'Content-Type: text/parameters\r\n' +
      'Content-Length: ' + body.length + '\r\n\r\n';

    request += body;
    //this.logLine?.(request);
  break;
  case SETPROGRESS:
    function hms(seconds: number): string {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      return [h, m, s].map((a) => a.toString().padStart(2, '0')).join(':');
    }
    let position = this.starttime + (this.progress) * Math.floor((2*config.sampling_rate)/(config.frames_per_packet/125)/0.71);
    let duration = this.starttime + (this.duration) *Math.floor((2*config.sampling_rate)/(config.frames_per_packet/125)/0.71);
    if (this.debug) {this.logLine?.('start', this.starttime, 'position', position, 'duration', duration , 'position1', hms(this.progress), 'duration1', hms(this.duration))}
    body = "progress: " + this.starttime +"/"+ position +"/"+ duration +'\r\n';
    request += this.makeHeadWithURL('SET_PARAMETER', di);
    request +=
      'Content-Type: text/parameters\r\n' +
      'Content-Length: ' + body.length + '\r\n\r\n';

    request += body;
    //this.logLine?.(request);
  break;
  case SETDAAP:
    let daapenc = true;
    //daapenc = true
    var name = this.daapEncode('minm', this.trackInfo.name,daapenc);
    var artist = this.daapEncode('asar', this.trackInfo.artist, daapenc);
    var album = this.daapEncode('asal', this.trackInfo.album, daapenc);
    var daapInfo = this.daapEncodeList('mlit', daapenc, name, artist, album);

    var head = this.makeHeadWithURL('SET_PARAMETER', di);
    head += this.makeRtpInfo();
    head +=
      'Content-Type: application/x-dmap-tagged\r\n' +
      'Content-Length: ' + daapInfo.length + '\r\n\r\n';

    var buf = Buffer.alloc(head.length);
    buf.write(head, 0, head.length, 'utf-8');
    request = Buffer.concat([buf, daapInfo]);
    //this.logLine?.(request);
    break;

  case SETART:
    var head = this.makeHeadWithURL('SET_PARAMETER', di);
    head += this.makeRtpInfo();
    head +=
      'Content-Type: ' + this.artworkContentType + '\r\n' +
      'Content-Length: ' + this.artwork.length + '\r\n\r\n';

    var buf = Buffer.alloc(head.length);
    buf.write(head, 0, head.length, 'utf-8');
    request = Buffer.concat([buf, this.artwork]);
    //this.logLine?.(request);
   if (this.encryptedChannel && this.credentials) {
    this.socket.write(this.credentials.encrypt(Buffer.concat([request])));
   } else
   {this.socket.write(request);}
    request = ''
    break;

  case TEARDOWN:
    try{
    this.socket.end(this.makeHead('TEARDOWN', '', di) + '\r\n');
    } catch(_){}
      if (this.debug) this.logLine?.('teardown');
    this.cleanup('stopped');

    // return here since the socket is closed
    return;

  default:
    return;
  }

  this.startTimeout();
  if (this.encryptedChannel && this.credentials) {
    this.socket.write(this.credentials.encrypt(Buffer.concat([Buffer.from(request, 'utf-8')])));
  } else
  {this.socket.write(request);}
};

Client.prototype.daapEncodeList = function(this: ClientInstance, field: string, enc: any, ...args: any[]) {
  var values = Array.prototype.slice.call(args);
  var value = Buffer.concat(values);
  var buf = Buffer.alloc(field.length + 4);
  buf.write(field, 0, field.length, enc ? 'utf-8' : "ascii");
  buf.writeUInt32BE(value.byteLength, field.length);
  return Buffer.concat([buf, value]);
};

Client.prototype.daapEncode = function(this: ClientInstance, field: string, value: any, enc?: string) {
  var valuebuf = Buffer.from(value, 'utf-8');
  var buf = Buffer.alloc(field.length + valuebuf.byteLength + 4);

  buf.write(field, 0, field.length, enc ? 'utf-8' : "ascii");
  buf.writeUInt32BE(valuebuf.byteLength, field.length);
  buf.write(value, field.length + 4, valuebuf.byteLength, enc ? 'utf-8' : "ascii");
  return buf;
};

Client.prototype.parsePorts = function(this: ClientInstance, headers: AnyObject) {
  function parsePort(name: string, transport: string) {
    var re = new RegExp(name + '=(\\d+)');
    var res = re.exec(transport);

    return res ? parseInt(res[1]) : null;
  }

  var transport = String(headers['Transport'] ?? ''),
      rtspConfig: AnyObject = {
        audioLatency: parseInt(String(headers['Audio-Latency'] ?? '0'), 10),
        requireEncryption: this.requireEncryption
      },
      names = ['server_port', 'control_port', 'timing_port'];

  for(var i = 0; i < names.length; i++) {
    var name = names[i];
    var port = parsePort(name, transport);

    if(port === null) {
        if (this.debug) this.logLine?.('parseport');
      // this.cleanup('parse_ports', transport);
      // return false;
      rtspConfig[name] = 4533;
    } else
      rtspConfig[name] = port;
  }

  this.emit('config', rtspConfig);

  return true;
}

function parseAuthenticate(auth: string, field: string) {
  var re = new RegExp(field + '="([^"]+)"'),
      res = re.exec(auth);

  return res ? res[1] : null;
}

Client.prototype.processData = function(this: ClientInstance, blob: string, rawData: Buffer) {
  this.logLine?.('Receiving request:',this.hostip , rtsp_methods[this.status+1]);
  var response: AnyObject = parseResponse2(blob, this),
      headers: AnyObject = response.headers || {};
  if (this.debug) {
    try {
      if ((rawData.toString()).includes("bplist00")) {
        const buf = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']), rawData.length);
        const bplist = bplistParser.parseBuffer(buf);
        this.logLine?.("incoming-res:", JSON.stringify(bplist));
      } else {
        this.logLine?.("incoming-res:", { code: response.code, length: rawData.length });
      }
    } catch {
      this.logLine?.("incoming-res:", { code: response.code, length: rawData.length });
    }
  }
    if (this.status != OPTIONS && this.status != OPTIONS2 && this.mode == 0) {
    if(response.code === 401) {
      if(!this.password) {
          if (this.debug) this.logLine?.('nopass');
        if (this.status == OPTIONS3){
        this.emit('pair_failed');
        this.cleanup('no_password');}
        return;
    }

    if(response.code === 455) {

        return;
    }


    if(this.passwordTried) {
        if (this.debug) this.logLine?.('badpass');
      this.emit('pair_failed');
      this.cleanup('bad_password');

      return;
    } else
      this.passwordTried = true;

    var auth = headers['WWW-Authenticate'];

    var di = {
      realm: parseAuthenticate(auth, 'realm'),
      nonce: parseAuthenticate(auth, 'nonce'),
      username: 'iTunes',
      password: this.password
    };
      if (this.debug) this.logLine?.()
    this.sendNextRequest(di);
    return;
  }

  if(response.code === 453) {
      if (this.debug) this.logLine?.('busy');
    this.cleanup('busy');
    return;
  }

  if(response.code === 403 && this.status == ANNOUNCE && this.mode == 2) {
    this.status = AUTH_SETUP;
    this.sendNextRequest();
    return;
  }

  if(response.code !== 200) {
    if (this.status != SETVOLUME && (this.status != ANNOUNCE && this.mode == 2) && this.status != SETPEERS && this.status != FLUSH && this.status != RECORD && this.status != GETVOLUME && this.status != SETPROGRESS && this.status != SETDAAP && this.status != SETART) {
      if ([PAIR_VERIFY_1,
        PAIR_VERIFY_2,
        AUTH_SETUP,
        PAIR_PIN_START,
        PAIR_PIN_SETUP_1,
        PAIR_PIN_SETUP_2,
        PAIR_PIN_SETUP_3].includes(this.status)) {
        this.emit('pair_failed');
      }
      this.cleanup(response.status);
    return;
  }}
}
  else if (this.mode == 1){
        if(response.code === 401) {
          if(!this.password) {
              if (this.debug) this.logLine?.('nopass');
            this.emit('pair_failed');
            this.cleanup('no_password');
            return;
        }

        if(this.passwordTried) {
            if (this.debug) this.logLine?.('badpass');
          this.emit('pair_failed');
          this.cleanup('bad_password');

          return;
        } else
          this.passwordTried = true;

        var auth = headers['WWW-Authenticate'];

        var di = {
          realm: parseAuthenticate(auth, 'realm'),
          nonce: parseAuthenticate(auth, 'nonce'),
          username: 'iTunes',
          password: this.password
        };
          if (this.debug) this.logLine?.(di)
        this.sendNextRequest(di);
        return;
      }

      if(response.code === 453) {
          if (this.debug) this.logLine?.('busy');
        this.cleanup('busy');
        return;
      }

      if(response.code === 403 && this.status == ANNOUNCE && this.mode == 2) {
        this.status = AUTH_SETUP;
        this.sendNextRequest();
        return;
      }

      if(response.code !== 200) {
        if (this.debug) this.logLine?.(response.status);
        if (this.status != SETVOLUME && (this.status != ANNOUNCE && this.mode == 2) && this.status != SETPEERS && this.status != FLUSH && this.status != RECORD && this.status != GETVOLUME && this.status != SETPROGRESS && this.status != SETDAAP && this.status != SETART) {
          if ([PAIR_VERIFY_1,
            PAIR_VERIFY_2,
            AUTH_SETUP,
            PAIR_PIN_START,
            PAIR_PIN_SETUP_1,
            PAIR_PIN_SETUP_2,
            PAIR_PIN_SETUP_3].includes(this.status)) {
            this.emit('pair_failed');
          }
          this.cleanup(response.status);
          return;
      }}
  }


  // password was accepted (or not needed)
  this.passwordTried = false;

  switch(this.status) {
    case PAIR_PIN_START:
      if (!this.transient) {this.emit('need_password');}
      this.status = this.airplay2 ? PAIR_SETUP_1 : PAIR_PIN_SETUP_1;
      if (!this.transient) {return;}
    break;
    case PAIR_PIN_SETUP_1:
      this.srp = new LegacySRP(2048);
      this.P = this.password
      let bufa = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      const { pk, salt } = bplistParser.parseBuffer(bufa)[0];

      this.s = salt.toString('hex');
      this.B = pk.toString('hex');

      // SRP: Generate random auth_secret, 'a'; if pairing is successful, it'll be utilized in
      // subsequent session authentication(s).
      this.a = nodeCrypto.randomBytes(32).toString('hex');

      // SRP: Compute A and M1.
      this.A   = this.srp.A(this.a);
      this.M1  = this.srp.M1(this.I, this.P, this.s, this.a, this.B);
      this.status = PAIR_PIN_SETUP_2
    break;
    case PAIR_PIN_SETUP_2:
      const { epk, authTag } = ATVAuthenticator.confirm(this.a, this.srp.K(this.I, this.P, this.s, this.a, this.B));

      this.epk = epk;
      this.authTag = authTag;
      this.status = PAIR_PIN_SETUP_3

    break;
    case PAIR_PIN_SETUP_3:
      this.status = PAIR_VERIFY_1
      this.authSecret = this.a
    break;
    case PAIR_VERIFY_1:
      let buf1 = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      this.logLine?.('verify2',Buffer.byteLength(buf1))
      if (Buffer.byteLength(buf1) != 0) {
        const atv_pub   = buf1.slice(0, 32).toString('hex');
        const atv_data  = buf1.slice(32).toString('hex');

        const shared    = ATVAuthenticator.shared(this.pair_verify_1_verifier.v_pri, atv_pub);
        const signed    = ATVAuthenticator.signed(this.authSecret, this.pair_verify_1_verifier.v_pub, atv_pub);
        this.pair_verify_1_signature = Buffer.from(
            Buffer.from([0x00, 0x00, 0x00, 0x00]).toString('hex') +
            ATVAuthenticator.signature(shared, atv_data, signed),
            'hex'
        );
          if (this.debug) this.logLine?.('verify2', Buffer.byteLength(this.pair_verify_1_signature))
        this.status = PAIR_VERIFY_2
      } else {
        this.emit('pair_failed');
        this.cleanup('pair_failed');
        return;
      }
    break;
    case PAIR_VERIFY_2:

      this.status = OPTIONS
    break;
    case PAIR_SETUP_1:
      let buf2 = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      let databuf1: any = tlv.decode(buf2);
      if (this.debug) this.logLine?.(databuf1)
      if (databuf1[tlv.Tag.BackOff]) {
        let backOff: Buffer = databuf1[tlv.Tag.BackOff];
        this.logLine?.(backOff)
        let seconds = backOff.length >= 2 ? Buffer.from(backOff).readInt16LE(0) : 0;

        this.logLine?.("You've attempt to pair too recently. Try again in " + (seconds) + " seconds.");

      }
      if (databuf1[tlv.Tag.ErrorCode]) {
        let buffer = databuf1[tlv.Tag.ErrorCode];
        this.logLine?.("Device responded with error code " + Buffer.from(buffer).readIntLE(0, buffer.byteLength) + ". Try rebooting your Apple TV.");
      }
      if (databuf1[tlv.Tag.PublicKey]) {
        this._atv_pub_key = databuf1[tlv.Tag.PublicKey]
        this._atv_salt = databuf1[tlv.Tag.Salt]
      this._hap_genkey = nodeCrypto.randomBytes(32);
      if (this.password == null){
          this.password = 3939 // transient
      }
      this.srp = new SrpClient(SRP.params.hap,Buffer.from(this._atv_salt),Buffer.from("Pair-Setup"),Buffer.from(this.password.toString()),Buffer.from(this._hap_genkey),true)
      this.srp.setB(this._atv_pub_key)
      this.A = this.srp.computeA()
      this.M1 = this.srp.computeM1()
      this.status = PAIR_SETUP_2}
      else {
        this.emit('pair_failed');
        this.cleanup('pair_failed');
        return;
      }
    break;
    case PAIR_SETUP_2:
      let buf3 = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      let databuf2 = tlv.decode(buf3);
      this.deviceProof = databuf2[tlv.Tag.Proof];
      if (!this.deviceProof) {
        this.emit('pair_failed');
        this.cleanup('pair_failed');
        return;
      }
      // this.logLine?.("DEBUG: Device Proof=" + this.deviceProof.toString('hex'));
      this.srp.checkM2(this.deviceProof);
      if (this.transient == true) {
        this.credentials = new Credentials(
          "sdsds",
          "",
          "",
          "",
          this.seed
        );
        this.credentials.writeKey = enc.HKDF(
          "sha512",
          Buffer.from("Control-Salt"),
          this.srp.computeK(),
          Buffer.from("Control-Write-Encryption-Key"),
          32
        );
        this.credentials.readKey = enc.HKDF(
          "sha512",
          Buffer.from("Control-Salt"),
          this.srp.computeK(),
          Buffer.from("Control-Read-Encryption-Key"),
          32
        );
        this.encryptedChannel = true
        this.status = SETUP_AP2_1
      }
      else {
        this.status = PAIR_SETUP_3
      }
    break;
    case PAIR_SETUP_3:
      let buf4 = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      let encryptedData = tlv.decode(buf4)[tlv.Tag.EncryptedData];
      let cipherText = encryptedData.slice(0, -16);
      let hmac = encryptedData.slice(-16);
      let decrpytedData = enc.verifyAndDecrypt(cipherText, hmac, null, Buffer.from('PS-Msg06'), this.encryptionKey);
      let tlvData = tlv.decode(decrpytedData);
      this.credentials = new Credentials(
         "sdsds",
         tlvData[tlv.Tag.Username],
         this.pairingId,
         tlvData[tlv.Tag.PublicKey],
        this.seed
       );
       this.status = PAIR_VERIFY_HAP_1;
    break;
    case PAIR_VERIFY_HAP_1:
      let buf5 = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      let decodedData = tlv.decode(buf5);
      let sessionPublicKey = decodedData[tlv.Tag.PublicKey];
      let encryptedData1 = decodedData[tlv.Tag.EncryptedData];

      if (sessionPublicKey.length != 32) {
        throw new Error(`sessionPublicKey must be 32 bytes (but was ${sessionPublicKey.length})`);
      }

      let cipherText1 = encryptedData1.slice(0, -16);
      let hmac1 = encryptedData1.slice(-16);
      // let sharedSecret = curve25519.deriveSharedSecret(this.verifyPrivate, sessionPublicKey);
      let sharedSecret = curve25519_js.sharedKey(this.verifyPrivate,sessionPublicKey)
      let encryptionKey = enc.HKDF(
        "sha512",
        Buffer.from("Pair-Verify-Encrypt-Salt"),
        sharedSecret,
        Buffer.from("Pair-Verify-Encrypt-Info"),
        32
      );
      let decryptedData = enc.verifyAndDecrypt(cipherText1, hmac1, null, Buffer.from('PV-Msg02'), encryptionKey);
      this.verifier_hap_1 = {
        sessionPublicKey: sessionPublicKey,
        sharedSecret: sharedSecret,
        encryptionKey: encryptionKey,
        pairingData: decryptedData
      }
      this.status = PAIR_VERIFY_HAP_2;
      this.sharedSecret = sharedSecret;
    break;
    case PAIR_VERIFY_HAP_2:
      let buf6 = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      this.credentials.readKey = enc.HKDF(
        "sha512",
        Buffer.from("Control-Salt"),
        this.verifier_hap_1.sharedSecret,
        Buffer.from("Control-Read-Encryption-Key"),
        32
      );
      this.credentials.writeKey = enc.HKDF(
        "sha512",
        Buffer.from("Control-Salt"),
        this.verifier_hap_1.sharedSecret,
        Buffer.from("Control-Write-Encryption-Key"),
        32
      );
      if (this.debug) {this.logLine?.('write',this.credentials.writeKey)}
      if (this.debug) {this.logLine?.('buf6', buf6)}
      this.encryptedChannel = true
      this.status = SETUP_AP2_1
    break;
    case SETUP_AP2_1:
      this.logLine?.('timing port parsing')
      let buf7 = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      let sa1_bplist = bplistParser.parseBuffer(buf7)
      this.eventPort = sa1_bplist[0]['eventPort']
      if (sa1_bplist[0]['timingPort'])
          this.timingDestPort = sa1_bplist[0]['timingPort']
      this.logLine?.('timing port ok', sa1_bplist[0]['timingPort'])
      // let rtspConfig1 = {
      //   audioLatency: 50,
      //   requireEncryption: false,
      //   server_port : 22223,
      //   control_port : this.controlPort,
      //   timing_port : this.timingPort,
      //   event_port: this.eventPort,
      //   credentials : this.credentials
      // }
      // this.emit('config', rtspConfig1);

      // this.eventsocket.bind(3003, this.socket.address().address);
      this.status = SETPEERS
    break;
    case SETUP_AP2_2:
      let buf8 = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      let sa2_bplist = bplistParser.parseBuffer(buf8)
      let rtspConfig = {
        audioLatency: 50,
        requireEncryption: false,
        server_port : sa2_bplist[0]["streams"][0]["dataPort"],
        control_port : sa2_bplist[0]["streams"][0]["controlPort"],
        timing_port : this.timingDestPort ? this.timingDestPort : this.timingPort,
        credentials : this.credentials
      }
      this.timingsocket.close();
      this.controlsocket.close();
      this.emit('config', rtspConfig);
      this.logLine?.("goto info")
      // this.session = 1;
      this.status = RECORD;
      // this.emit('ready');
    break;
    case SETPEERS:
      this.status = SETUP_AP2_2;
    break;
    case FLUSH:
      this.status = PLAYING
      this.metadataReady = true;
      this.emit('pair_success');
      this.session = "1"
      this.logLine?.("flush")
      this.emit('ready');
      // this.logLine?.(sa2_bplist[0]["streams"][0]["controlPort"], sa2_bplist[0]["streams"][0]["dataPort"] )

    break;
    case INFO:
      let buf9 = Buffer.from(rawData).slice(rawData.length - parseInt(headers['Content-Length']),rawData.length)
      this.status = (this.credentials) ? RECORD : PAIR_SETUP_1
    break;
    case GETVOLUME:
      this.status = RECORD
    break;
    case AUTH_SETUP:
      this.status = OPTIONS
    break;
    case OPTIONS:
      /*
       * Devices like Apple TV and Zeppelin Air do not support encryption.
       * Only way of checking that: they do not reply to Apple-Challenge
       */
      if(headers['Apple-Response'])
        this.requireEncryption = true;
      // this.logLine?.("yeah22332",headers['WWW-Authenticate'],response.code)
      if (headers['WWW-Authenticate'] != null && response.code === 401) {
          let auth = headers['WWW-Authenticate'];
          let realm = parseAuthenticate(auth, 'realm');
          let nonce = parseAuthenticate(auth, 'nonce');
          let uri = "*"
          let user = "iTunes"
          let methodx = "OPTIONS"
          let pwd = this.password
          let ha1 = md5norm(`${user}:${realm}:${pwd}`);
          let ha2 = md5norm(`${methodx}:${uri}`);
          let di_response = md5(`${ha1}:${nonce}:${ha2}`);
          this.code_digest = `Authorization: Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${di_response}" \r\n\r\n`
          this.status = OPTIONS2;
      } else {
        
        this.status = this.session ? PLAYING: (this.airplay2 ? PAIR_PIN_START : ANNOUNCE);
        // if (this.status == ANNOUNCE && response.code === 200){this.emit('pair_success')};
      }

    break;
    case OPTIONS2:
        /*
         * Devices like Apple TV and Zeppelin Air do not support encryption.
         * Only way of checking that: they do not reply to Apple-Challenge
         */
        // if(headers['Apple-Response'])
        //   this.requireEncryption = true;
        if (headers['WWW-Authenticate'] != null && response.code === 401) {
          let auth = headers['WWW-Authenticate'];
          let realm = parseAuthenticate(auth, 'realm');
          let nonce = parseAuthenticate(auth, 'nonce');
          let uri = "*"
          let user = "iTunes"
          let methodx = "OPTIONS"
          let pwd = this.password
          let ha1 = md5(`${user}:${realm}:${pwd}`);
          let ha2 = md5(`${methodx}:${uri}`);
          let di_response = md5(`${ha1}:${nonce}:${ha2}`);
          this.code_digest = `Authorization: Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${di_response}" \r\n\r\n`
          this.status = OPTIONS3;
      } else {
        this.status = this.session? PLAYING: (this.airplay2 ? SETUP_AP2_1 :ANNOUNCE);
        // if (this.status == ANNOUNCE && response.code === 200){this.emit('pair_success')}
      }  ;


    break;
    case OPTIONS3:
      this.status = this.session? PLAYING: (this.airplay2 ? SETUP_AP2_1 :ANNOUNCE);
        // if (this.status == ANNOUNCE && response.code === 200){this.emit('pair_success')}
    break;     
    case ANNOUNCE:
      this.status = (this.airplay2 == true && this.mode == 2) ? PAIR_PIN_START : SETUP;
    break;

    case SETUP:
      this.status = RECORD;
      this.session = headers['Session'];
      this.parsePorts(headers);
      break;

    case RECORD:
        this.metadataReady = true;
        this.emit('pair_success')
        if (this.airplay2) {
          // AirPlay2 may not send FLUSH after SETPROGRESS; ensure session exists and start relay once.
          this.session = this.session ?? "1";
          if (!this.readySent) {
            this.readySent = true;
            this.emit('ready');
          }
        } else {
          this.session = this.session ?? "1";
          this.emit('ready');
        }
        this.status = SETVOLUME;
    break;

    case SETVOLUME:
      if (this.airplay2) {
        this.status = PLAYING;
      } else {
        if (!this.sentFakeProgess) {
          this.progress = 10;
          this.duration = 2000000;
          this.sentFakeProgess = true;
          this.status = SETPROGRESS;
        }
        else {
          this.status = PLAYING;
        };
      }
    break;
    case SETPROGRESS:
      // Keep PLAYING to avoid forcing FLUSH on every progress update.
      this.status = PLAYING;
    break;
    case SETDAAP:
      this.status = PLAYING;
      break;

    case SETART:
      this.status = PLAYING;
      break;
  }
  try{
  if (this.callback != null) {
    this.callback();
  }} catch(e){}

  this.sendNextRequest();
}

Client.prototype.parseObject = function(this: ClientInstance, plist: any){
    if (this.debug) this.logLine?.('plist', plist)
}
