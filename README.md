# lox-airplay-sender

AirPlay sender (RAOP/AirPlay 1 + AirPlay 2 auth) refactored from node_airtunes2 into a modern, typed TypeScript module. It owns the RTSP/UDP pipeline, ALAC encoding, and metadata handling with no native dependencies.

## Requirements
- Node.js 18+
- PCM input: 16-bit little-endian, stereo, 44.1kHz (ALAC encoding is handled internally)

## Installation
```bash
npm install lox-airplay-sender
```

## Quick start
```ts
import { start } from "lox-airplay-sender";

const sender = start(
  {
    host: "192.168.1.162",
    port: 7000,          // defaults to 5000
    airplay2: true,      // set to true for AirPlay 2 devices
    log: (level, msg, data) => console.log(`[${level}]`, msg, data),
  },
  (event) => console.log("event", event)
);

sender.setMetadata({
  title: "Track",
  artist: "Artist",
  album: "Album",
  coverUrl: "https://example.com/cover.jpg",
  durationMs: 180_000,
  elapsedMs: 0,
});

// Write raw PCM chunks as they arrive
sender.sendPcm(Buffer.from(/* pcm data */));
```

## API
### `start(options, onEvent?) => LoxAirplaySender`
Creates and starts a sender for one AirPlay device. Returns the instance so you can call methods directly.

**Options**
- `host` (string, required) AirPlay device hostname/IP.
- `port` (number) RAOP port, default 5000.
- `name` (string) Sender name shown on receiver.
- `password` (string | null) AirPlay 1 password.
- `volume` (number) Initial volume (0–100), default 50.
- `mode` (number) RAOP mode; defaults to 2 when `airplay2` is true, else 0.
- `txt` (string[]) Custom TXT records.
- `forceAlac` (boolean) Encode ALAC even when input is ALAC; default true.
- `alacEncoding` (boolean) Enable ALAC encoding; default true.
- `inputCodec` (`"pcm"` | `"alac"`) Defaults to `"pcm"`.
- `airplay2` (boolean) Enable AirPlay 2 auth/flags; default false.
- `startTimeMs` (number) Unix ms to align playback across devices.
- `debug` (boolean) Verbose logging from the transport stack.
- `log` `(level, message, data?) => void` Hook for library logs.
- `config` (partial) Override buffer/sync/RTSP tuning at runtime (see `src/utils/config.ts` for keys like `packets_in_buffer`, `stream_latency`, `sync_period`, retry/backoff, etc.).

**Events** (sent to `onEvent` callback)
- `device`: `{ event: "device", message: status, detail: { key, desc } }`
- `session-ended`: `{ event: "session-ended", message: reason, detail: { key, reason } }`
- `buffer`: `{ event: "buffer", message: status }` where status is `buffering|playing|drain|end`
- `error`: `{ event: "error", message }`
- `metrics`: `{ event: "metrics", detail }` sync drift snapshots emitted on each sync tick when enabled.

### `LoxAirplaySender` methods
- `sendPcm(chunk: Buffer)`: Push raw PCM audio. If `inputCodec` is `"alac"` you can push ALAC frames.
- `pipeStream(stream: Readable)`: Convenience to pipe a Node stream into `sendPcm`; auto-stops on `end`/`error`.
- `setMetadata({ title, artist, album, cover, coverUrl, elapsedMs, durationMs })`: Updates track info, cover art (Buffer or URL), and progress. Cover URLs are fetched with a short timeout and deduplicated.
- `setTrackInfo(title, artist?, album?)`: Direct track update.
- `setArtwork(buffer, mime?)`: Send cover art immediately.
- `setProgress(elapsedSec, durationSec)`: Manual progress update.
- `setVolume(volume)`: Adjust volume (0–100).
- `setPasscode(passcode)`: Provide a passcode when the receiver requests it.
- `stop()`: Stop the sender, close sockets/streams, and clear state.

## Sync playback
Use `startTimeMs` to align multiple senders to the same start clock (Unix ms). Feed each sender PCM in lockstep; they will start at the scheduled time.

## Development
```bash
npm install
npm run build
npm run clean   # remove dist
```
