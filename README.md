# serverless group chat — the browser wiring, working

A group video+audio+data chat on a URL, with **no server of ours**. This is
the capstone that turns the media spikes' protocol logic into a real app the
browser runs. Verified end-to-end in a real Chrome: three peers formed a full
mesh over real WebRTC and exchanged group chat.

## What runs where

| Layer | Who does it |
|-------|-------------|
| DTLS / ICE / SRTP transport | the browser's `RTCPeerConnection` (native) |
| Signaling (offer/answer/candidates) | **our** code, over a channel that isn't our server |
| Mesh roles + glare-free negotiation | `signaling.js` `roleFor` — port of the verified `roster` spike |
| SDP ↔ URL fragment | `signaling.js` — port of the verified `linkoffer` spike |
| End-to-end media encryption | `sframe.js` — port of the `sframe` spike, **real AES-GCM** via WebCrypto |
| Signaling transport | public MQTT broker (WSS) **or** BroadcastChannel (`&local`) |

"Serverless" = we operate nothing. Cross-network peers rendezvous through a
public MQTT broker (`broker.emqx.io`, shared infra we don't run), keyed on the
room id in the URL. Same-machine testing uses BroadcastChannel.

## Run it

```
node -e "const h=require('http'),f=require('fs'),p=require('path');const t={'.html':'text/html','.js':'text/javascript'};h.createServer((q,r)=>{let x=q.url==='/'?'/index.html':q.url.split('?')[0];f.readFile(p.join(process.cwd(),x),(e,d)=>{r.writeHead(e?404:200,{'content-type':t[p.extname(x)]||'text/plain'});r.end(d)})}).listen(8099)"
```
Open `http://localhost:8099/#room=myroom` in two browsers/devices and share the
link. Add `&local` to test two tabs on one machine (BroadcastChannel). HTTPS is
required for camera access on non-localhost origins.

## Verified

- **Node logic tests** (`node test.mjs`): roster mesh roles glare-free; SDP↔URL
  fragment round-trip; SFrame header codec matches the Python spike; **SFrame
  AES-GCM protects 4 frames E2E, tamper + outsider rejected**; MQTT
  CONNECT/SUBSCRIBE/PUBLISH encode + a stream parser that handles concatenated
  packets and a partial tail.
- **Real browser (Chrome DevTools)**: 3 tabs in one room → full mesh (3
  connections), every `RTCPeerConnection` reached `connected` over real
  DTLS/ICE, every data channel `open`, and a group chat broadcast from peer 3
  arrived at the others. (No camera in the test box → data-only; the media
  path is the same `addTrack` + sframe-transform code, unit-tested separately.)

## Two real bugs found during browser bring-up (see FINDINGS)

1. **hello/greet echo storm** — every presence hello triggered a greeting that
   sent another hello: 24,843 messages in 1.5 s, drowning out SDP. Fix: greet
   each new peer exactly once, never re-echo an ack.
2. **`RTCIceCandidate`/`RTCSessionDescription` are not structured-cloneable and
   don't survive JSON** — `postMessage` threw `DataCloneError` and the answer
   silently never applied (offerer stuck at `have-local-offer`). Fix: send
   `candidate.toJSON()` and `{type, sdp}` plain objects. This is *the* classic
   WebRTC signaling footgun and it bit exactly as documented.

## Honest gaps

- Camera video + sframe on live media tracks weren't exercised (no camera in
  CI); the code path is present and the crypto is unit-tested.
- The public-MQTT transport works but depends on third-party uptime; swap the
  broker URL in `app.js` or use `&local` for a hard guarantee.
- Full mesh is O(N²) connections — fine to ~8 peers; beyond that an SFU (a
  server) is the usual answer, which this deliberately avoids.
