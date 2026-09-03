const MIN_BPM = 30;
const MAX_BPM = 200;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

const els = {
  status: document.getElementById("status"),
  display: document.getElementById("display"),
  count: document.getElementById("count"),
  subline: document.getElementById("subline"),
  bpm: document.getElementById("bpm"),
  bpmRead: document.getElementById("bpmRead"),
  bpmDown: document.getElementById("bpmDown"),
  bpmUp: document.getElementById("bpmUp"),
  meterSeg: document.getElementById("meterSeg"),
  subSeg: document.getElementById("subSeg"),
  clickToggle: document.getElementById("clickToggle"),
  voiceToggle: document.getElementById("voiceToggle"),
  countInSeg: document.getElementById("countInSeg"),
  start: document.getElementById("start"),
};

const settings = {
  bpm: 80,
  meter: 4,
  subdivision: 2,
  click: true,
  voice: true,
  countIn: "short",
};

let audioCtx = null;
let buffers = {};
let timerId = null;
let running = false;
let nextTime = 0;
let step = 0;
let introStepsLeft = 0;
let wakeLock = null;

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

function introLength() {
  if (settings.countIn === "off") return 0;
  if (settings.countIn === "bars") return stepsPerBar() * 2;
  return settings.subdivision * 2; // last two beats: 3 & 4 & or 2 & 3 &
}

function shortCountStartStep() {
  // Begin at beat (meter - 1) of a virtual previous bar.
  return (settings.meter - 2) * settings.subdivision;
}

function setStatus(text) {
  els.status.textContent = text;
}

function updateSubline() {
  const countName = settings.subdivision === 2 ? "eighths" : "sixteenths";
  els.subline.textContent = `${settings.meter}/4 · ${countName}`;
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
    if (!raw) return;
    Object.assign(settings, JSON.parse(raw));
  } catch {
    /* ignore */
  }
  els.bpm.value = String(settings.bpm);
  els.bpmRead.textContent = String(settings.bpm);
  syncSeg(els.meterSeg, "[data-meter]", String(settings.meter));
  syncSeg(els.subSeg, "[data-sub]", String(settings.subdivision));
  syncSeg(els.countInSeg, "[data-countin]", settings.countIn);
  setToggle(els.clickToggle, settings.click);
  setToggle(els.voiceToggle, settings.voice);
  updateSubline();
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

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();
  if (Object.keys(buffers).length) return;
  const names = ["one", "two", "three", "four", "and", "ee", "uh"];
  await Promise.all(
    names.map(async (name) => {
      const res = await fetch(`./audio/${name}.mp3`);
      const arr = await res.arrayBuffer();
      buffers[name] = await audioCtx.decodeAudioData(arr);
    })
  );
}

function playClick(time, accent) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(accent ? 1320 : 880, time);
  gain.gain.setValueAtTime(accent ? 0.22 : 0.12, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(time);
  osc.stop(time + 0.06);
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
  gain.gain.setValueAtTime(lifted ? 1 : 0.86, time);
  src.connect(gain).connect(audioCtx.destination);
  src.start(time);
}

function showLabel(label, inCountIn) {
  els.count.textContent = label;
  els.count.classList.toggle("upbeat", label === "&" || label === "e" || label === "a");
  els.display.classList.remove("pulse-down", "pulse-up");
  void els.display.offsetWidth;
  els.display.classList.add(label === "&" || label === "e" || label === "a" ? "pulse-up" : "pulse-down");
  setStatus(inCountIn ? "Count-in" : "Playing");
}

function schedulerTick() {
  if (!running || !audioCtx) return;
  const stepDur = 60 / settings.bpm / settings.subdivision;
  while (nextTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
    const label = labelFor(step);
    const countIn = introStepsLeft > 0;
    const t = nextTime;
    if (settings.click && isDownbeat(step)) playClick(t, isBarOne(step));
    if (settings.voice) playVoice(label, t);
    const wait = Math.max(0, (t - audioCtx.currentTime) * 1000);
    window.setTimeout(() => {
      if (running) showLabel(label, countIn);
    }, wait);
    nextTime += stepDur;
    step += 1;
    if (introStepsLeft > 0) introStepsLeft -= 1;
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
  await ensureAudio();
  running = true;
  introStepsLeft = introLength();
  step = settings.countIn === "short" ? shortCountStartStep() : 0;
  nextTime = audioCtx.currentTime + 0.06;
  els.start.textContent = "Stop";
  els.start.classList.add("running");
  setStatus(introStepsLeft ? "Count-in" : "Playing");
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
  els.count.textContent = "1";
  els.count.classList.remove("upbeat");
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

els.countInSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-countin]");
  if (!btn) return;
  settings.countIn = btn.dataset.countin;
  syncSeg(els.countInSeg, "[data-countin]", settings.countIn);
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
updateSubline();
