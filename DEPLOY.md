# Live deployment & setup guide

**Live now:** https://lmno100.github.io/serverless-group-chat/

HTTPS is served by GitHub Pages (required for camera/mic access). Signaling
rides a public MQTT broker; media is peer-to-peer WebRTC. No server of ours.

---

## For users — just join a call (nothing to install)

1. Open **https://lmno100.github.io/serverless-group-chat/** in Chrome, Edge,
   or Firefox (desktop or Android). Safari/iOS works too.
2. Your browser asks for **camera + microphone** — click **Allow**. (Deny and
   you still join as text/data-only.)
3. Click **copy invite link** in the top bar and send it to whoever you want in
   the call — SMS, email, chat, anything.
4. Everyone who opens that same link lands in the same room and connects
   automatically. Video tiles appear as people join; the box on the right is
   group text chat.

**That's it.** Up to ~6–8 people works smoothly (it's a full mesh — every
person connects directly to every other person, so each added person costs
everyone a little bandwidth).

### If you don't see someone
- Make sure you both opened the **exact same link** (same `#room=...`).
- Some strict corporate/university networks block WebRTC or the signaling
  broker. Try another network (or phone hotspot). A symmetric-NAT network may
  need a TURN relay — see "self-hosting" below to add one.
- The log strip at the bottom shows connection state (`connecting` →
  `connected`) and any errors.

### Privacy
Media frames are end-to-end encrypted (AES-GCM / SFrame) with a key derived
from the room id, so nothing in the network path — including the public
broker — can read your audio/video. Anyone who has the link can join the
room, so treat the link like a password: share it privately, and start a new
room (new link) for a new private call.

---

## For developers — run or host your own

**Run locally** (no deploy needed):
```bash
git clone https://github.com/lmno100/serverless-group-chat
cd serverless-group-chat
# any static server works; e.g.:
python -m http.server 8099    # or: npx serve .
# open http://localhost:8099/  (localhost is treated as secure, camera works)
```
Two tabs on one machine: add `#room=test&local` to use BroadcastChannel
instead of the network broker.

**Host your own copy** (GitHub Pages, the way this one is hosted):
```bash
# fork or create a repo with these 4 files at the root:
#   index.html  app.js  signaling.js  sframe.js
gh repo create my-chat --public --source=. --push
gh api -X POST repos/<you>/my-chat/pages -f "source[branch]=main" -f "source[path]=/"
# live at https://<you>.github.io/my-chat/ in ~1 minute
```
Any static host works identically — Netlify, Cloudflare Pages, S3+CloudFront,
your own nginx with a TLS cert. There is no backend to run.

**Run the tests:**
```bash
node test.mjs   # roster/mesh, SDP↔URL codec, SFrame AES-GCM, MQTT framing
```

### Configuration knobs (all in `app.js`)
- **Signaling broker** — `wss://broker.emqx.io:8084/mqtt`. Swap for another
  public MQTT-over-WSS broker (e.g. `wss://test.mosquitto.org:8081/mqtt`) or
  your own. The topic is `rfccypher/sgc/<room>`.
- **STUN servers** — Google's public STUN. Fine for most NATs.
- **TURN relay** (needed only for symmetric NAT / very locked-down networks):
  add to `iceServers`:
  ```js
  { urls: 'turn:your.turn.server:3478', username: 'u', credential: 'p' }
  ```
  A free option to test with is a self-hosted `coturn`, or a metered TURN
  provider. This is the one piece that may need infrastructure if peers are
  behind hostile NATs — pure STUN can't punch through those.

### How it works (the short version)
`RTCPeerConnection` (the browser) does DTLS/ICE/SRTP. Our code does: mesh role
assignment (smaller peer-id offers — glare-free perfect negotiation), SDP +
ICE candidate exchange over the broker, and AES-GCM media encryption via
insertable streams. See `../SERVERLESS_GROUP_CHAT.md` for the full architecture
and which RFC each piece implements.
