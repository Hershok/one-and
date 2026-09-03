const MIN_BPM = 30;
const MAX_BPM = 200;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

const els = {
  status: document.getElementById("status"),
  display: document.getElementById("display"),
  beatBoard: document.getElementById("beatBoard"),
  subline: document.getElementById("subline"),
  bpm: document.getElementById("bpm"),
  bpmRead: document.getElementById("bpmRead"),
  bpmDown: document.getElementById("bpmDown"),
  bpmUp: document.getElementById("bpmUp"),
  meterSeg: document.getElementById("meterSeg"),
  subSeg: document.getElementById("subSeg"),
  clickToggle: document.getElementById("clickToggle"),
  voiceToggle: document.getElementById("voiceToggle"),
  start: document.getElementById("start"),
};

const settings = {
  bpm: 80,
  meter: 4,
  subdivision: 2,
  click: true,
  voice: true,
};

let audioCtx = null;
let masterGain = null;
let buffers = {};
let timerId = null;
let running = false;
let nextTime = 0;
let step = 0;
let wakeLock = null;
let numEls = [];
let andEls = [];

function stepsPerBar() {
  return settings.meter * settings.subdivision;
}

function labelFor(globalStep) {
  const perBar = stepsPerBar();
  const stepInBar = ((globalStep % perBar) + perBar) % perBar;
  const beat = Math.floor(stepInBar / settings.subdivision);
  const part = stepInBar % settings.subdivision;
  const num = String(beat + 1);
  if (settings.subdivision === 2) return part === 0 ? num : "&";
  return [num, "e", "&", "a"][part];
}

function isDownbeat(globalStep) {
  const perBar = stepsPerBar();
  const stepInBar = ((globalStep % perBar) + perBar) % perBar;
  return stepInBar % settings.subdivision === 0;
}

function isBarOne(globalStep) {
  const perBar = stepsPerBar();
  const stepInBar = ((globalStep % perBar) + perBar) % perBar;
  return stepInBar === 0;
}

function voiceKey(label) {
  return {
    "1": "one",
    "2": "two",
    "3": "three",
    "4": "four",
    "&": "and",
    e: "ee",
    a: "uh",
  }[label];
}

function setStatus(text) {
  els.status.textContent = text;
}

function updateSubline() {
  const countName = settings.subdivision === 2 ? "eighths" : "sixteenths";
  els.subline.textContent = `${settings.meter}/4 · ${countName}`;
}

function buildBoard() {
  const cols = settings.meter * 2;
  els.beatBoard.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  els.beatBoard.innerHTML = "";
  numEls = [];
  andEls = [];

  for (let i = 0; i < cols; i += 1) {
    const cell = document.createElement("div");
    cell.className = "syll and";
    if (i % 2 === 1) {
      cell.textContent = "&";
      andEls.push(cell);
    }
    els.beatBoard.appendChild(cell);
  }
  for (let i = 0; i < cols; i += 1) {
    const cell = document.createElement("div");
    cell.className = "syll num";
    if (i % 2 === 0) {
      cell.textContent = String(i / 2 + 1);
      numEls.push(cell);
    }
    els.beatBoard.appendChild(cell);
  }
}

function clearActive() {
  numEls.forEach((el) => el.classList.remove("on"));
  andEls.forEach((el) => el.classList.remove("on"));
}

function showLabel(label, atStep) {
  clearActive();
  if (/^[1-4]$/.test(label)) {
    const el = numEls[Number(label) - 1];
    if (el) el.classList.add("on");
  } else if (label === "&") {
    const perBar = stepsPerBar();
    const stepInBar = ((atStep % perBar) + perBar) % perBar;
    const andIndex = Math.floor(stepInBar / settings.subdivision);
    const el = andEls[andIndex];
    if (el) el.classList.add("on");
  }
  setStatus("Playing");
}

function setBpm(value) {
  settings.bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, value));
  els.bpm.value = String(settings.bpm);
  els.bpmRead.textContent = String(settings.bpm);
  saveSettings();
}

function saveSettings() {
  localStorage.setItem("one-and-settings", JSON.stringify(settings));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem("one-and-settings");
    if (raw) {
      const parsed = JSON.parse(raw);
      settings.bpm = parsed.bpm ?? settings.bpm;
      settings.meter = parsed.meter ?? settings.meter;
      settings.subdivision = parsed.subdivision ?? settings.subdivision;
      settings.click = parsed.click ?? settings.click;
      settings.voice = parsed.voice ?? settings.voice;
    }
  } catch {
    /* ignore */
  }
  els.bpm.value = String(settings.bpm);
  els.bpmRead.textContent = String(settings.bpm);
  syncSeg(els.meterSeg, "[data-meter]", String(settings.meter));
  syncSeg(els.subSeg, "[data-sub]", String(settings.subdivision));
  setToggle(els.clickToggle, settings.click);
  setToggle(els.voiceToggle, settings.voice);
  updateSubline();
  buildBoard();
}

function syncSeg(root, selector, value) {
  root.querySelectorAll(selector).forEach((btn) => {
    const key = Object.keys(btn.dataset)[0];
    btn.classList.toggle("on", btn.dataset[key] === value);
  });
}

function setToggle(btn, on) {
  btn.classList.toggle("on", on);
  btn.textContent = on ? "On" : "Off";
}

async function decodeDataUri(ctx, dataUri) {
  const res = await fetch(dataUri);
  const arr = await res.arrayBuffer();
  return ctx.decodeAudioData(arr.slice(0));
}

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();
  if (Object.keys(buffers).length) return;

  const samples = window.VOICE_SAMPLES || {};
  const names = ["one", "two", "three", "four", "and", "ee", "uh"];
  for (const name of names) {
    if (!samples[name]) throw new Error(`Missing sample ${name}`);
    buffers[name] = await decodeDataUri(audioCtx, samples[name]);
  }
}

function playClick(time, accent) {
  const dest = masterGain || audioCtx.destination;
  const makeTick = (freq, gainVal, dur) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, time);
    gain.gain.setValueAtTime(gainVal, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(gain).connect(dest);
    osc.start(time);
    osc.stop(time + dur);
  };
  if (accent) {
    makeTick(1760, 0.28, 0.07);
    makeTick(880, 0.16, 0.05);
  } else {
    makeTick(980, 0.18, 0.045);
  }
}

function playVoice(label, time) {
  const key = voiceKey(label);
  const buffer = buffers[key];
  if (!buffer) return;
  const src = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  src.buffer = buffer;
  const stepDur = 60 / settings.bpm / settings.subdivision;
  if (buffer.duration > stepDur * 0.92) {
    src.playbackRate.value = Math.min(1.65, buffer.duration / (stepDur * 0.9));
  }
  const lifted = label === "&" || label === "e" || label === "a";
  gain.gain.setValueAtTime(lifted ? 1.35 : 1.2, time);
  src.connect(gain).connect(masterGain || audioCtx.destination);
  src.start(time);
}

function schedulerTick() {
  if (!running || !audioCtx) return;
  const stepDur = 60 / settings.bpm / settings.subdivision;
  while (nextTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
    const label = labelFor(step);
    const t = nextTime;
    if (settings.click && isDownbeat(step)) playClick(t, isBarOne(step));
    if (settings.voice) playVoice(label, t);
    const wait = Math.max(0, (t - audioCtx.currentTime) * 1000);
    const captured = label;
    const capturedStep = step;
    window.setTimeout(() => {
      if (running) showLabel(captured, capturedStep);
    }, wait);
    nextTime += stepDur;
    step += 1;
  }
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

async function start() {
  try {
    await ensureAudio();
  } catch (err) {
    setStatus("Voice failed to load");
    console.error(err);
    return;
  }
  running = true;
  step = 0;
  clearActive();
  nextTime = audioCtx.currentTime + 0.06;
  els.start.textContent = "Stop";
  els.start.classList.add("running");
  setStatus("Playing");
  await requestWakeLock();
  schedulerTick();
  timerId = window.setInterval(schedulerTick, LOOKAHEAD_MS);
}

function stop() {
  running = false;
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  els.start.textContent = "Start";
  els.start.classList.remove("running");
  clearActive();
  setStatus("Ready");
}

els.start.addEventListener("click", async () => {
  if (running) stop();
  else await start();
});

els.bpm.addEventListener("input", (e) => setBpm(Number(e.target.value)));
els.bpmDown.addEventListener("click", () => setBpm(settings.bpm - 1));
els.bpmUp.addEventListener("click", () => setBpm(settings.bpm + 1));

els.meterSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-meter]");
  if (!btn) return;
  settings.meter = Number(btn.dataset.meter);
  syncSeg(els.meterSeg, "[data-meter]", btn.dataset.meter);
  updateSubline();
  buildBoard();
  saveSettings();
});

els.subSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-sub]");
  if (!btn) return;
  settings.subdivision = Number(btn.dataset.sub);
  syncSeg(els.subSeg, "[data-sub]", btn.dataset.sub);
  updateSubline();
  saveSettings();
});

els.clickToggle.addEventListener("click", () => {
  settings.click = !settings.click;
  setToggle(els.clickToggle, settings.click);
  saveSettings();
});

els.voiceToggle.addEventListener("click", () => {
  settings.voice = !settings.voice;
  setToggle(els.voiceToggle, settings.voice);
  saveSettings();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) requestWakeLock();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

loadSettings();
