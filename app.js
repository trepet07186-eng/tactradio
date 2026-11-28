const FB_URL = "https://" + "nebo22-default-rtdb." + "firebaseio." + "com/ptt_rooms/";
const MAX_REC_SEC = 20;
const MAX_HISTORY = 15;

let callsign = "", roomCode = "", roomHash = "", online = false;
let pollTimer = null, isPolling = false, lastResetTs = 0;
let mediaStream = null, mediaRecorder = null, audioChunks = [], recStartTs = 0, recTimer = null;
let audioCtx = null, analyser = null, vuAnim = null, wakeLock = null, silentAudio = null;
let playedIds = new Set(), playQueue = [], isPlaying = false, firstSync = true;

const elCall = document.getElementById("inCall");
const elRoom = document.getElementById("inRoom");
const btnConnect = document.getElementById("btnConnect");
const btnClear = document.getElementById("btnClear");
const btnPtt = document.getElementById("btnPtt");
const pttMainTxt = document.getElementById("pttMainTxt");
const pttSubTxt = document.getElementById("pttSubTxt");
const netBadge = document.getElementById("netBadge");
const statusHint = document.getElementById("statusHint");
const logList = document.getElementById("logList");
const vuBar = document.getElementById("vuBar");

try {
  const saved = JSON.parse(localStorage.getItem("ptt_cfg") || "null");
  if (saved) { if (saved.c) elCall.value = saved.c; if (saved.r) elRoom.value = saved.r; }
} catch (e) {}

const CryptoPTT = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const SALT = enc.encode("PTT_PVO_SALT_2026_V1");
  async function hashRoom(secret) {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode("PTT_" + secret));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }
  async function deriveKey(secret) {
    const base = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: SALT, iterations: 10000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encrypt(obj, secret) {
    const key = await deriveKey(secret), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
    const comb = new Uint8Array(iv.length + ct.byteLength);
    comb.set(iv, 0); comb.set(new Uint8Array(ct), iv.length);
    let bin = ""; for (let i = 0; i < comb.length; i++) bin += String.fromCharCode(comb[i]);
    return btoa(bin);
  }
  async function decrypt(b64Str, secret) {
    try {
      const bin = atob(b64Str), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const key = await deriveKey(secret);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
      return JSON.parse(dec.decode(plain));
    } catch (e) { return null; }
  }
  return { hashRoom, encrypt, decrypt };
})();

function playTone(freq1, freq2, durSec = 0.12) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq1, audioCtx.currentTime);
    if (freq2) osc.frequency.setValueAtTime(freq2, audioCtx.currentTime + durSec * 0.5);
    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durSec);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + durSec + 0.01);
  } catch (e) {}
}
async function enableKeepAwake() {
  try { if ("wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
  try {
    if (!silentAudio) {
      const sr = 8000, buf = new ArrayBuffer(44 + sr), v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, "RIFF"); v.setUint32(4, 36 + sr, true); w(8, "WAVE"); w(12, "fmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
      w(36, "data"); v.setUint32(40, sr, true); new Uint8Array(buf, 44).fill(128);
      silentAudio = document.createElement("audio");
      silentAudio.src = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      silentAudio.loop = true; silentAudio.volume = 0.01;
    }
    silentAudio.play().catch(() => {});
  } catch (e) {}
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && online) enableKeepAwake(); });

btnConnect.onclick = async () => {
  const c = elCall.value.trim().toUpperCase();
  const r = elRoom.value.trim().toUpperCase().replace(/[^A-ZА-Я0-9_-]/g, "");
  if (!c || !r) { statusHint.textContent = "Укажите позывной и код канала!"; return; }

  playTone(900, 1200, 0.12);
  await enableKeepAwake();

  try {
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
    }
  } catch (err) {
    alert("Нет доступа к микрофону! Разрешите микрофон в настройках браузера (требуется HTTPS).");
    return;
  }

  callsign = c; roomCode = r;
  roomHash = await CryptoPTT.hashRoom(r);
  localStorage.setItem("ptt_cfg", JSON.stringify({ c: callsign, r: roomCode }));

  playedIds.clear(); playQueue = []; firstSync = true;
  logList.innerHTML = "";
  btnPtt.disabled = false;
  online = true;
  netBadge.className = "badge online";
  netBadge.textContent = "ЭФИР: " + roomCode;
  statusHint.textContent = "Нажмите и удерживайте кнопку для передачи";

  if (pollTimer) clearInterval(pollTimer);
  await pollChannel();
  pollTimer = setInterval(pollChannel, 1200);
};

function enqueuePlayback(msgObj, domEl) {
  playQueue.push({ msg: msgObj, el: domEl });
  processPlayQueue();
}

function processPlayQueue() {
  if (isPlaying || playQueue.length === 0) return;
  isPlaying = true;
  const { msg, el } = playQueue.shift();

  netBadge.className = "badge rx";
  netBadge.textContent = "ПРИЁМ: " + msg.sender;
  btnPtt.classList.add("receiving");
  statusHint.textContent = "🔊 Говорит " + msg.sender + " (" + msg.dur + " сек)...";
  if (el) el.classList.add("playing");

  playTone(1100, 850, 0.09);

  const audio = new Audio("data:" + (msg.mime || "audio/webm") + ";base64," + msg.audio);
  const finish = () => {
    if (el) el.classList.remove("playing");
    btnPtt.classList.remove("receiving");
    isPlaying = false;
    if (playQueue.length === 0) {
      netBadge.className = "badge online";
      netBadge.textContent = "ЭФИР: " + roomCode;
      statusHint.textContent = "Нажмите и удерживайте кнопку для передачи";
    }
    processPlayQueue();
  };
  audio.onended = finish;
  audio.onerror = finish;
  setTimeout(() => { audio.play().catch(finish); }, 110);
}
async function pollChannel() {
  if (!roomHash || isPolling) return;
  isPolling = true;
  try {
    const res = await fetch(FB_URL + roomHash + ".json?t=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    if (data && data.resetTs && data.resetTs > lastResetTs) {
      lastResetTs = data.resetTs;
      playedIds.clear(); playQueue = [];
      logList.innerHTML = '<div style="color:#64748b;font-size:12px;text-align:center;">Эфир очищен.</div>';
    }

    const msgsObj = (data && data.msgs) ? data.msgs : {};
    const keys = Object.keys(msgsObj).sort();

    for (const k of keys) {
      if (playedIds.has(k)) continue;
      playedIds.add(k);
      const dec = await CryptoPTT.decrypt(msgsObj[k], roomCode);
      if (!dec || !dec.audio) continue;

      const isMine = (dec.sender === callsign);
      const item = document.createElement("div");
      item.className = "msg-item" + (isMine ? " mine" : "");
      item.innerHTML = '<div><b>' + dec.sender + '</b> <span style="color:#94a3b8;font-size:11px;">' + dec.time + ' • ' + dec.dur + 'с</span></div>';
      const btnRep = document.createElement("button");
      btnRep.className = "btn"; btnRep.style.padding = "4px 8px"; btnRep.textContent = "▶";
      btnRep.onclick = () => enqueuePlayback(dec, item);
      item.appendChild(btnRep);
      logList.appendChild(item);
      logList.scrollTop = logList.scrollHeight;

      if (!firstSync && !isMine) enqueuePlayback(dec, item);
    }
    firstSync = false;
  } catch (e) {
    netBadge.className = "badge";
    netBadge.textContent = "НЕТ СВЯЗИ";
  } finally {
    isPolling = false;
  }
}

async function sendVoicePacket(blob, durSec, mimeType) {
  statusHint.textContent = "⏳ Шифрование и отправка (" + durSec + "с)...";
  const b64 = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.readAsDataURL(blob);
  });
  const now = new Date();
  const timeStr = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0");
  const msgId = Date.now() + "_" + Math.floor(100 + Math.random() * 900);
  const encStr = await CryptoPTT.encrypt({ sender: callsign, time: timeStr, dur: durSec, mime: mimeType, audio: b64 }, roomCode);

  try {
    await fetch(FB_URL + roomHash + "/msgs/" + msgId + ".json", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(encStr)
    });
    statusHint.textContent = "✅ Передано (" + durSec + " сек)";
    const rList = await fetch(FB_URL + roomHash + "/msgs.json?shallow=true");
    const keysObj = await rList.json();
    if (keysObj) {
      const ks = Object.keys(keysObj).sort();
      while (ks.length > MAX_HISTORY) {
        const oldK = ks.shift();
        fetch(FB_URL + roomHash + "/msgs/" + oldK + ".json", { method: "DELETE" }).catch(() => {});
      }
    }
    pollChannel();
  } catch (e) {
    statusHint.textContent = "❌ Ошибка отправки: " + e.message;
  }
}

function getSupportedMime() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const t of types) { if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t; }
  return "";
}

function updateVuMeter() {
  if (!analyser || !mediaRecorder || mediaRecorder.state !== "recording") { vuBar.style.width = "0%"; return; }
  const arr = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(arr);
  let sum = 0; for (let i = 0; i < arr.length; i++) sum += arr[i];
  const pct = Math.min(100, Math.round((sum / arr.length) * 1.6));
  vuBar.style.width = pct + "%";
  vuAnim = requestAnimationFrame(updateVuMeter);
}

function startTransmit(e) {
  if (e) e.preventDefault();
  if (!online || !mediaStream || (mediaRecorder && mediaRecorder.state === "recording")) return;

  playTone(880, 1320, 0.09);
  if (navigator.vibrate) navigator.vibrate(40);

  audioChunks = [];
  const mime = getSupportedMime();
  mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 24000 }) : new MediaRecorder(mediaStream);

  mediaRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) audioChunks.push(ev.data); };
  mediaRecorder.onstop = () => {
    const dur = Math.max(1, Math.round((Date.now() - recStartTs) / 1000));
    if (audioChunks.length > 0 && (Date.now() - recStartTs) >= 450) {
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      sendVoicePacket(blob, dur, mediaRecorder.mimeType || "audio/webm");
    } else {
      statusHint.textContent = "Слишком короткое нажатие (отменено)";
    }
  };

  recStartTs = Date.now();
  mediaRecorder.start(150);

  btnPtt.classList.add("active");
  netBadge.className = "badge tx";
  netBadge.textContent = "ПЕРЕДАЧА...";
  pttMainTxt.textContent = "В ЭФИРЕ";
  pttSubTxt.textContent = "00:00 / 00:" + MAX_REC_SEC;
  updateVuMeter();

  recTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - recStartTs) / 1000);
    pttSubTxt.textContent = "00:" + String(sec).padStart(2, "0") + " / 00:" + MAX_REC_SEC;
    if (sec >= MAX_REC_SEC) stopTransmit();
  }, 250);
}

function stopTransmit(e) {
  if (e) e.preventDefault();
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  if (vuAnim) { cancelAnimationFrame(vuAnim); vuAnim = null; }
  vuBar.style.width = "0%";

  btnPtt.classList.remove("active");
  pttMainTxt.textContent = "ПЕРЕДАЧА";
  pttSubTxt.textContent = "УДЕРЖИВАТЬ";
  if (online) { netBadge.className = "badge online"; netBadge.textContent = "ЭФИР: " + roomCode; }

  if (mediaRecorder && mediaRecorder.state === "recording") {
    playTone(1040, 780, 0.09);
    mediaRecorder.stop();
  }
}

btnPtt.addEventListener("pointerdown", startTransmit);
btnPtt.addEventListener("pointerup", stopTransmit);
btnPtt.addEventListener("pointercancel", stopTransmit);
btnPtt.addEventListener("pointerleave", (e) => { if (e.buttons === 0 && mediaRecorder && mediaRecorder.state === "recording") stopTransmit(e); });

btnClear.onclick = async () => {
  if (!roomHash) return;
  if (!confirm("Удалить все голосовые сообщения с устройств и из облака?")) return;
  const ts = Date.now();
  lastResetTs = ts;
  playedIds.clear(); playQueue = [];
  logList.innerHTML = '<div style="color:#64748b;font-size:12px;text-align:center;">Эфир полностью очищен.</div>';
  try {
    await fetch(FB_URL + roomHash + ".json", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resetTs: ts }) });
    await new Promise(r => setTimeout(r, 2500));
    await fetch(FB_URL + roomHash + ".json", { method: "DELETE" });
    statusHint.textContent = "🧹 Облако и эфир полностью зачищены.";
  } catch (e) {}
};
