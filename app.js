// app.js — the mesh. Uses the browser's RTCPeerConnection for DTLS/ICE/SRTP
// (the transport the spikes intentionally didn't reimplement), and our own
// verified logic for signaling, mesh roles, and E2E media.
import { roleFor, mqttConnect, mqttSubscribe, mqttPublish, mqttParse, mqttPingReq } from './signaling.js';
import { deriveKey, SFrame, installSenderTransform, installReceiverTransform } from './sframe.js';

const RTC_CONFIG = { encodedInsertableStreams: true,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

const el = (id) => document.getElementById(id);
const log = (m) => { const p = el('log'); p.textContent += m + '\n'; p.scrollTop = p.scrollHeight; };

const myId = 'p' + Math.random().toString(36).slice(2, 8);
let params = new URLSearchParams(location.hash.slice(1));
let room = params.get('room');
let secret = params.get('k') || room || 'demo';
const useLocal = params.has('local');   // BroadcastChannel mode for same-machine testing

const peers = new Map();     // peerId -> { pc, dc }
let localStream = null;
let sframeKey = null;
let bus = null;              // signaling transport

async function start() {
  if (!room) { room = Math.random().toString(36).slice(2, 8); location.hash = `room=${room}`; params = new URLSearchParams(location.hash.slice(1)); secret = room; }
  el('roomLink').value = location.href.includes('room=') ? location.href : `${location.origin}${location.pathname}#room=${room}`;
  el('me').textContent = myId;
  sframeKey = await deriveKey(secret);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    addVideo(myId, localStream, true);
  } catch (e) {
    log('no camera/mic (' + e.name + ') — joining as data-only'); localStream = new MediaStream();
  }

  bus = useLocal ? localBus(room) : mqttBus(room);
  await bus.ready;
  bus.onMessage(onSignal);
  bus.send({ from: myId, hello: true });   // announce presence
  log(`joined room ${room} as ${myId} via ${useLocal ? 'BroadcastChannel' : 'public MQTT'}`);
  log('share the invite link (top bar) — others who open it join this room');
}

function onSignal(msg) {
  if (msg.from === myId) return;
  if (msg.to && msg.to !== myId) return;
  if (msg.bye) { const p = peers.get(msg.from); if (p) { p.pc.close(); peers.delete(msg.from); removeVideo(msg.from); log(`${msg.from} left`); } return; }
  if (msg.hello) {
    const known = peers.has(msg.from);
    ensurePeer(msg.from);
    if (!known && !msg.ack) greet(msg.from);  // greet a new peer exactly once
    return;
  }
  const peer = ensurePeer(msg.from);
  if (msg.description) handleDescription(peer, msg.from, msg.description);
  else if (msg.candidate) peer.pc.addIceCandidate(msg.candidate).catch(() => {});
}

function greet(other) {                 // one ack so the peer learns about us; no re-echo
  bus.send({ from: myId, to: other, hello: true, ack: true });
}

function ensurePeer(other) {
  if (peers.has(other)) return peers.get(other);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const state = { pc, dc: null, makingOffer: false, polite: roleFor(myId, other).polite };
  peers.set(other, state);

  for (const track of localStream.getTracks()) {
    const sender = pc.addTrack(track, localStream);
    if (track.kind) installSenderTransform(sender, new SFrame(1, sframeKey));
  }
  pc.ontrack = (e) => {
    installReceiverTransform(e.receiver, new SFrame(1, sframeKey));
    addVideo(other, e.streams[0], false);
  };
  // RTCIceCandidate/RTCSessionDescription are NOT structured-cloneable and do
  // not survive JSON — send plain objects over both BroadcastChannel and MQTT.
  pc.onicecandidate = (e) => { if (e.candidate) bus.send({ from: myId, to: other, candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => { log(`${other}: ${pc.connectionState}`); if (pc.connectionState === 'failed') pc.restartIce(); };

  // perfect negotiation (RFC 8829): impolite peer drives the offer
  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      bus.send({ from: myId, to: other, description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } finally { state.makingOffer = false; }
  };

  if (roleFor(myId, other).role === 'offer') {
    const dc = pc.createDataChannel('chat');
    wireChannel(other, dc); state.dc = dc;
  } else {
    pc.ondatachannel = (e) => { wireChannel(other, e.channel); state.dc = e.channel; };
  }
  return state;
}

async function handleDescription(peer, other, description) {
  const { pc } = peer;
  const offerCollision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
  if (offerCollision && !peer.polite) return;   // impolite peer ignores; polite rolls back
  if (offerCollision) await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
  await pc.setRemoteDescription(description);
  if (description.type === 'offer') {
    await pc.setLocalDescription();
    bus.send({ from: myId, to: other, description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  }
}

function wireChannel(other, dc) {
  dc.onopen = () => log(`data channel to ${other} open`);
  dc.onmessage = (e) => appendChat(other, e.data);
}

el('sendBtn').onclick = () => {
  const text = el('msg').value; if (!text) return;
  appendChat(myId, text); el('msg').value = '';
  for (const { dc } of peers.values()) if (dc && dc.readyState === 'open') dc.send(text);
};
el('copyBtn').onclick = () => { el('roomLink').select(); (navigator.clipboard && navigator.clipboard.writeText(el('roomLink').value)) || document.execCommand('copy'); log('room link copied'); };

function addVideo(id, stream, muted) {
  let v = el('v-' + id);
  if (!v) {
    const wrap = document.createElement('div'); wrap.className = 'tile';
    v = document.createElement('video'); v.id = 'v-' + id; v.autoplay = true; v.playsInline = true; v.muted = muted;
    const label = document.createElement('span'); label.textContent = id + (muted ? ' (you)' : '');
    wrap.append(v, label); el('grid').append(wrap);
  }
  v.srcObject = stream;
}
function removeVideo(id) { const v = el('v-' + id); if (v && v.parentElement) v.parentElement.remove(); }
function appendChat(from, text) { const c = el('chat'); c.textContent += `${from}: ${text}\n`; c.scrollTop = c.scrollHeight; }

// ------------------------- signaling transports

function localBus(room) {
  const ch = new BroadcastChannel('sgc-' + room);
  const handlers = [];
  ch.onmessage = (e) => handlers.forEach((h) => h(e.data));
  return { ready: Promise.resolve(), onMessage: (h) => handlers.push(h), send: (m) => ch.postMessage(m) };
}

function mqttBus(room) {
  const topic = 'rfccypher/sgc/' + room;
  const ws = new WebSocket('wss://broker.emqx.io:8084/mqtt', 'mqtt');
  ws.binaryType = 'arraybuffer';
  const handlers = [];
  let buf = new Uint8Array(0);
  const ready = new Promise((resolve) => {
    ws.onopen = () => ws.send(mqttConnect(myId));
    ws.onerror = () => log('signaling socket error — broker may be blocked on this network');
    ws.onmessage = (e) => {
      const chunk = new Uint8Array(e.data);
      const cat = new Uint8Array(buf.length + chunk.length); cat.set(buf); cat.set(chunk, buf.length);
      if (cat[0] >> 4 === 2) { ws.send(mqttSubscribe(topic)); resolve(); buf = cat.slice(4); return; } // CONNACK
      const { publishes, rest } = mqttParse(cat); buf = rest;
      for (const p of publishes) try { handlers.forEach((h) => h(JSON.parse(p.message))); } catch {}
    };
  });
  setInterval(() => ws.readyState === 1 && ws.send(mqttPingReq()), 30000);
  return { ready, onMessage: (h) => handlers.push(h), send: (m) => ws.readyState === 1 && ws.send(mqttPublish(topic, JSON.stringify(m))) };
}

window.__sgc = { peers, get myId() { return myId; } };  // debug hook (harmless)
window.addEventListener('beforeunload', () => bus && bus.send({ from: myId, bye: true }));
start();
