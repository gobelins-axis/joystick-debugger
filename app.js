import { Axis } from 'axis-api';
import 'axis-api/build/bundle.css';

// Hand over the ipcRenderer if the preload ran before this module (see index.html shim).
if (window.__axis_pending_ipc__) {
    window.__axis__.set_ipc_renderer(window.__axis_pending_ipc__);
    delete window.__axis_pending_ipc__;
}

// API calibration (see axis-api/src/utils/normalizeJoystickSignal.js)
const CALIBRATION = {
    x: { min: 18, max: 840 },
    y: { min: 36, max: 867 },
};
const ADC_MAX = 1023;
const CHART_SAMPLES = 300;
const SERIAL_STALL_MS = 1000;

const settings = {
    trail: 60,
};

/* ------------------------------------------------------------------ */
/* Utils                                                              */
/* ------------------------------------------------------------------ */

const logEl = document.getElementById('log');
const logLines = [];

function log(message) {
    const d = new Date();
    const t = `${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    logLines.unshift(`${t}  ${message}`);
    if (logLines.length > 200) logLines.pop();
    logEl.textContent = logLines.join('\n');
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function fmt(n, digits = 3) {
    return (n === undefined || n === null || Number.isNaN(n)) ? '–' : n.toFixed(digits);
}

function setPill(id, text, state) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.classList.remove('ok', 'warn');
    if (state) el.classList.add(state);
}

/* ------------------------------------------------------------------ */
/* Emulation: keyboard + gamepad                                       */
/* ------------------------------------------------------------------ */

Axis.registerKeys('q', 'a', 1);
Axis.registerKeys('d', 'x', 1);
Axis.registerKeys('z', 'i', 1);
Axis.registerKeys('s', 's', 1);
Axis.registerKeys(' ', 'w', 1);

Axis.registerKeys('ArrowLeft', 'a', 2);
Axis.registerKeys('ArrowRight', 'x', 2);
Axis.registerKeys('ArrowUp', 'i', 2);
Axis.registerKeys('ArrowDown', 's', 2);
Axis.registerKeys('Enter', 'w', 2);

const gamepadEmulator = Axis.createGamepadEmulator(0);
Axis.joystick1.setGamepadEmulatorJoystick(gamepadEmulator, 0);
Axis.joystick2.setGamepadEmulatorJoystick(gamepadEmulator, 1);

['a', 'x', 'i', 's'].forEach((key, i) => {
    Axis.registerGamepadEmulatorKeys(gamepadEmulator, i, key, 1);
    Axis.registerGamepadEmulatorKeys(gamepadEmulator, i + 4, key, 2);
});

window.addEventListener('gamepadconnected', (e) => log(`gamepad ${e.gamepad.index} connected: ${e.gamepad.id}`));
window.addEventListener('gamepaddisconnected', (e) => log(`gamepad ${e.gamepad.index} disconnected`));

/* ------------------------------------------------------------------ */
/* Joystick views                                                     */
/* ------------------------------------------------------------------ */

const template = document.getElementById('joystick-template');
const joysticksEl = document.getElementById('joysticks');

function createJoystickView(joystick) {
    const root = template.content.firstElementChild.cloneNode(true);
    joysticksEl.appendChild(root);

    const q = (sel) => root.querySelector(sel);

    const view = {
        joystick,
        id: joystick.id,
        root,
        canvas: q('.js-canvas'),
        chart: q('.js-chart'),
        el: {
            id: q('.js-id'),
            rate: q('.js-rate'),
            nx: q('.js-nx'),
            ny: q('.js-ny'),
            nmag: q('.js-nmag'),
            nangle: q('.js-nangle'),
            rx: q('.js-rx'),
            ry: q('.js-ry'),
            rest: q('.js-rest'),
            rminmaxx: q('.js-rminmaxx'),
            rminmaxy: q('.js-rminmaxy'),
            qm: {
                left: q('.js-qm-left'),
                right: q('.js-qm-right'),
                up: q('.js-qm-up'),
                down: q('.js-qm-down'),
            },
        },
        normalized: { x: 0, y: 0, magnitude: 0 },
        raw: null,
        rest: null,
        range: null,
        trail: [],
        samples: [],
        quickmoveCounts: { left: 0, right: 0, up: 0, down: 0 },
        quickmoveTimers: {},
        eventCount: 0,
        rate: 0,
        lastRateTime: performance.now(),
    };

    view.el.id.textContent = joystick.id;

    q('.js-reset-range').addEventListener('click', () => { view.range = null; });
    q('.js-recenter').addEventListener('click', () => {
        if (view.raw) view.rest = { ...view.raw };
    });

    joystick.addEventListener('joystick:move', (e) => onMove(view, e));
    joystick.addEventListener('joystick:quickmove', (e) => onQuickmove(view, e));

    return view;
}

function onMove(view, e) {
    view.normalized = {
        x: e.position.x,
        y: e.position.y,
        magnitude: e.position.magnitude !== undefined
            ? e.position.magnitude
            : Math.sqrt(e.position.x * e.position.x + e.position.y * e.position.y),
    };
    view.eventCount++;

    view.trail.push({ x: e.position.x, y: e.position.y });
    while (view.trail.length > settings.trail) view.trail.shift();

    view.samples.push({
        nx: e.position.x,
        ny: e.position.y,
        rx: view.raw ? view.raw.x : null,
        ry: view.raw ? view.raw.y : null,
    });
    while (view.samples.length > CHART_SAMPLES) view.samples.shift();
}

function onRaw(view, position) {
    view.raw = { x: position.x, y: position.y };

    if (!view.rest) view.rest = { ...view.raw };

    if (!view.range) {
        view.range = { minX: position.x, maxX: position.x, minY: position.y, maxY: position.y };
    } else {
        view.range.minX = Math.min(view.range.minX, position.x);
        view.range.maxX = Math.max(view.range.maxX, position.x);
        view.range.minY = Math.min(view.range.minY, position.y);
        view.range.maxY = Math.max(view.range.maxY, position.y);
    }

    // The API dispatches the normalized event before we get the raw one,
    // so attach the raw value to the sample that was just recorded.
    const last = view.samples[view.samples.length - 1];
    if (last && last.rx === null) {
        last.rx = position.x;
        last.ry = position.y;
    }
}

function onQuickmove(view, e) {
    view.quickmoveCounts[e.direction]++;
    const el = view.el.qm[e.direction];
    el.querySelector('b').textContent = view.quickmoveCounts[e.direction];
    el.classList.add('active');
    clearTimeout(view.quickmoveTimers[e.direction]);
    view.quickmoveTimers[e.direction] = setTimeout(() => el.classList.remove('active'), 150);
    log(`joystick ${view.id} quickmove ${e.direction}`);
}

const views = [createJoystickView(Axis.joystick1), createJoystickView(Axis.joystick2)];

/* ------------------------------------------------------------------ */
/* Drawing                                                            */
/* ------------------------------------------------------------------ */

function drawJoystick(view) {
    const ctx = view.canvas.getContext('2d');
    const W = view.canvas.width;
    const H = view.canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = W / 2 - 20;
    const deadzone = view.joystick.deadzone;
    const threshold = view.joystick.threshold;

    ctx.clearRect(0, 0, W, H);

    // Quickmove bands (edges of the ±1 square)
    ctx.fillStyle = 'rgba(255, 213, 79, 0.35)';
    const band = R * threshold;
    ctx.fillRect(cx - R, cy - R, band, 2 * R);          // left
    ctx.fillRect(cx + R - band, cy - R, band, 2 * R);   // right
    ctx.fillRect(cx - R, cy - R, 2 * R, band);          // up
    ctx.fillRect(cx - R, cy + R - band, 2 * R, band);   // down

    // ±1 square
    ctx.strokeStyle = '#ccc';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.setLineDash([]);

    // Unit circle (magnitude is clamped to 1 by the API)
    ctx.strokeStyle = '#999';
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // Deadzone
    ctx.fillStyle = 'rgba(211, 47, 47, 0.12)';
    ctx.strokeStyle = 'rgba(211, 47, 47, 0.6)';
    ctx.beginPath();
    ctx.arc(cx, cy, R * deadzone, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Crosshair
    ctx.strokeStyle = '#ddd';
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // Raw position (full ADC range mapped to the square), hollow gray
    if (view.raw) {
        const rx = cx + ((view.raw.x / ADC_MAX) * 2 - 1) * R;
        const ry = cy - ((view.raw.y / ADC_MAX) * 2 - 1) * R;
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(rx, ry, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
    }

    // Trail
    if (view.trail.length > 1) {
        for (let i = 1; i < view.trail.length; i++) {
            const a = view.trail[i - 1];
            const b = view.trail[i];
            ctx.strokeStyle = `rgba(25, 118, 210, ${(i / view.trail.length) * 0.6})`;
            ctx.beginPath();
            ctx.moveTo(cx + a.x * R, cy - a.y * R);
            ctx.lineTo(cx + b.x * R, cy - b.y * R);
            ctx.stroke();
        }
    }

    // Normalized position
    const nx = cx + view.normalized.x * R;
    const ny = cy - view.normalized.y * R;
    ctx.strokeStyle = '#1976d2';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.stroke();
    ctx.fillStyle = '#1976d2';
    ctx.beginPath();
    ctx.arc(nx, ny, 6, 0, Math.PI * 2);
    ctx.fill();

    // Legend
    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    ctx.fillText('blue = normalized   gray ring = raw ADC', 6, H - 6);
}

function drawChart(view) {
    const ctx = view.chart.getContext('2d');
    const W = view.chart.width;
    const H = view.chart.height;
    const hasRaw = view.samples.some((s) => s.rx !== null);

    ctx.clearRect(0, 0, W, H);

    const toY = hasRaw
        ? (v) => H - (v / ADC_MAX) * H
        : (v) => H / 2 - v * (H / 2 - 4);

    // Reference lines
    ctx.setLineDash([3, 3]);
    if (hasRaw) {
        ctx.strokeStyle = 'rgba(25, 118, 210, 0.5)';
        hline(ctx, toY(CALIBRATION.x.min), W);
        hline(ctx, toY(CALIBRATION.x.max), W);
        ctx.strokeStyle = 'rgba(211, 47, 47, 0.5)';
        hline(ctx, toY(CALIBRATION.y.min), W);
        hline(ctx, toY(CALIBRATION.y.max), W);
    } else {
        ctx.strokeStyle = '#ccc';
        hline(ctx, toY(1), W);
        hline(ctx, toY(-1), W);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ddd';
    hline(ctx, toY(hasRaw ? ADC_MAX / 2 : 0), W);

    // Series
    const n = view.samples.length;
    if (n < 2) return;
    const step = W / (CHART_SAMPLES - 1);
    const offset = W - (n - 1) * step;

    plot(ctx, view.samples, hasRaw ? 'rx' : 'nx', '#1976d2', step, offset, toY);
    plot(ctx, view.samples, hasRaw ? 'ry' : 'ny', '#d32f2f', step, offset, toY);

    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    ctx.fillText(hasRaw ? 'raw 0–1023' : 'normalized -1..1', 4, 10);
}

function hline(ctx, y, W) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
}

function plot(ctx, samples, key, color, step, offset, toY) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < samples.length; i++) {
        const v = samples[i][key];
        if (v === null || v === undefined) { started = false; continue; }
        const x = offset + i * step;
        if (!started) { ctx.moveTo(x, toY(v)); started = true; } else ctx.lineTo(x, toY(v));
    }
    ctx.stroke();
    ctx.lineWidth = 1;
}

function updateReadouts(view) {
    const n = view.normalized;
    view.el.nx.textContent = fmt(n.x);
    view.el.ny.textContent = fmt(n.y);
    view.el.nmag.textContent = fmt(n.magnitude);
    view.el.nangle.textContent = n.magnitude > 0
        ? `${Math.round((Math.atan2(n.y, n.x) * 180) / Math.PI)}°`
        : '–';

    if (view.raw) {
        view.el.rx.textContent = view.raw.x;
        view.el.ry.textContent = view.raw.y;
        view.el.rest.textContent = view.rest ? `${view.rest.x} / ${view.rest.y}` : '–';
        if (view.range) {
            view.el.rminmaxx.textContent = rangeText(view.range.minX, view.range.maxX, CALIBRATION.x);
            view.el.rminmaxy.textContent = rangeText(view.range.minY, view.range.maxY, CALIBRATION.y);
        }
    }

    view.el.rate.textContent = `${view.rate} Hz`;
}

function rangeText(min, max, cal) {
    const flag = (min < cal.min || max > cal.max) ? ' ⚠ out of cal' : '';
    return `${min} / ${max}${flag}`;
}

/* ------------------------------------------------------------------ */
/* Buttons                                                            */
/* ------------------------------------------------------------------ */

const buttonEls = {};

function createButtonEl(key, id) {
    const el = document.createElement('div');
    el.className = 'btn';
    el.innerHTML = `<span class="key">${key.toUpperCase()}</span><span class="count">0</span>`;
    el.dataset.count = '0';
    document.querySelector(`.buttons[data-group="${id}"]`).appendChild(el);
    buttonEls[`${key}-${id}`] = el;
}

[1, 2].forEach((id) => ['a', 'x', 'i', 's', 'w'].forEach((key) => createButtonEl(key, id)));
createButtonEl('home', 0);

function buttonDown(key, id) {
    const el = buttonEls[`${key}-${id}`];
    if (!el) return;
    el.classList.add('down');
    el.dataset.count = String(Number(el.dataset.count) + 1);
    el.querySelector('.count').textContent = el.dataset.count;
    log(`keydown  ${key.toUpperCase()} (group ${id})`);
}

function buttonUp(key, id) {
    const el = buttonEls[`${key}-${id}`];
    if (!el) return;
    el.classList.remove('down');
    log(`keyup    ${key.toUpperCase()} (group ${id})`);
}

Axis.addEventListener('keydown', (e) => buttonDown(e.key, e.id));
Axis.addEventListener('keyup', (e) => buttonUp(e.key, e.id));
Axis.buttonManager.buttonHome.addEventListener('keydown', () => buttonDown('home', 0));
Axis.buttonManager.buttonHome.addEventListener('keyup', () => buttonUp('home', 0));

Axis.addEventListener('sleep', () => { setPill('pill-sleep', 'Sleep', 'warn'); log('machine: sleep'); });
Axis.addEventListener('awake', () => { setPill('pill-sleep', 'Awake', 'ok'); log('machine: awake'); });
Axis.addEventListener('exit:attempted', () => log('exit attempted'));
Axis.addEventListener('exit:canceled', () => log('exit canceled'));
Axis.addEventListener('exit:completed', () => log('exit completed'));

/* ------------------------------------------------------------------ */
/* Machine (ipcRenderer) raw data                                     */
/* ------------------------------------------------------------------ */

let lastSerialTime = 0;
let serialState = 'none';

function attachIpc(ipc) {
    setPill('pill-ipc', 'ipcRenderer: yes', 'ok');
    setPill('pill-source', 'Source: machine', 'ok');
    log('ipcRenderer attached, listening to raw joystick:move');

    ipc.on('joystick:move', (_event, data) => {
        const view = views[data.id - 1];
        if (view) onRaw(view, data.position);
        lastSerialTime = performance.now();
    });

    ipc.on('altenative:move', (_event, data) => {
        log(`alternative-analog ${data.id}: ${data.position}`);
    });
}

const ipcPoll = setInterval(() => {
    if (!Axis.ipcRenderer) return;
    clearInterval(ipcPoll);
    attachIpc(Axis.ipcRenderer);
}, 100);

setTimeout(() => {
    if (!Axis.ipcRenderer) log('no ipcRenderer after 3s: running in browser emulation mode (keyboard + gamepad)');
}, 3000);

function updateSerialPill(now) {
    let next;
    if (lastSerialTime === 0) next = 'none';
    else if (now - lastSerialTime > SERIAL_STALL_MS) next = 'stalled';
    else next = 'ok';

    if (next === serialState) return;
    serialState = next;
    if (next === 'ok') { setPill('pill-serial', 'Serial: receiving', 'ok'); log('serial: receiving joystick data'); }
    if (next === 'stalled') { setPill('pill-serial', 'Serial: stalled', 'warn'); log('serial: no joystick data for 1s (firmware keepalive is 50ms)'); }
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

function bindRange(id, onChange) {
    const input = document.getElementById(id);
    const value = document.getElementById(`${id}-value`);
    const apply = () => {
        const v = parseFloat(input.value);
        value.textContent = Number.isInteger(v) ? String(v) : v.toFixed(2);
        onChange(v);
    };
    input.addEventListener('input', apply);
    apply();
}

bindRange('deadzone', (v) => { Axis.joystick1.deadzone = v; Axis.joystick2.deadzone = v; });
bindRange('threshold', (v) => { Axis.joystick1.threshold = v; Axis.joystick2.threshold = v; });
bindRange('trail', (v) => { settings.trail = v; });

document.getElementById('clear-log').addEventListener('click', () => {
    logLines.length = 0;
    logEl.textContent = '';
});

/* ------------------------------------------------------------------ */
/* Main loop                                                          */
/* ------------------------------------------------------------------ */

function update() {
    const now = performance.now();

    gamepadEmulator.update();

    const gamepads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    setPill('pill-gamepads', `Gamepads: ${gamepads.length}`, gamepads.length ? 'ok' : null);

    updateSerialPill(now);

    for (const view of views) {
        if (now - view.lastRateTime >= 500) {
            view.rate = Math.round(view.eventCount / ((now - view.lastRateTime) / 1000));
            view.eventCount = 0;
            view.lastRateTime = now;
        }
        drawJoystick(view);
        drawChart(view);
        updateReadouts(view);
    }

    requestAnimationFrame(update);
}

if (document.documentElement.classList.contains('is-axis-machine')) {
    setPill('pill-source', 'Source: machine', 'ok');
}

log('debugger ready');
update();