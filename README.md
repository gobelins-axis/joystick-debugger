# 🕹️ Axis Joystick Debugger

A single-page tool to inspect what the Axis machine's joysticks and buttons are sending, both on the machine itself and in browser emulation mode.

Plain HTML/CSS/JS bundled with [Vite](https://vite.dev). [axis-api](https://github.com/gobelins-axis/axis-api) is installed from GitHub through npm.

## What it shows

For each joystick (1 and 2):

- **2D view**: normalized position (blue dot + trail), raw ADC position (gray ring), deadzone (red circle), quickmove zones (yellow bands), unit circle.
- **Normalized values**: x, y, magnitude, angle. This is exactly what `joystick:move` gives to a game.
- **Raw ADC values** (machine only): current x/y, rest value, observed min/max. The API expects x 18–840 and y 36–867 (Ultra Stick 360 calibration). If the observed range goes outside those bounds, it is flagged `⚠ out of cal`, which means the normalized value clips at ±1 before the stick reaches its physical edge.
- **Quickmove events**: left/right/up/down flash and count.
- **Strip chart**: raw x/y over the last ~5 seconds (normalized when raw is unavailable) with the calibration bounds as dashed lines. Handy to spot noise, jitter, or a drifting rest value.
- **Event rate** in Hz. The V6 firmware sends at most 100 msg/s and at least one every 50 ms.

Also:

- **Buttons**: A X I S W for both groups plus Home, with press counts.
- **Header pills**: source (machine vs browser), ipcRenderer attached, gamepads connected, serial state (receiving / stalled), sleep/awake.
- **Live settings**: deadzone and quickmove threshold are written straight onto `Axis.joystick1` / `joystick2`, so you can find good values for the API config.
- **Event log**: keydown/keyup, quickmove, sleep/awake, exit, gamepad connection, serial stalls.

## Run locally

```bash
npm install
npm run dev
```

`npm run build` writes the static site to `dist/`, `npm run preview` serves it.
The build targets Chromium 98, which is what the launcher's Electron 17 ships.

Browser emulation:

| Machine input | Keyboard | Gamepad |
| --- | --- | --- |
| Joystick 1 | – | left stick |
| Joystick 2 | – | right stick |
| Group 1: A X I S W | Q D Z S Space | buttons 0 1 2 3 |
| Group 2: A X I S W | ← → ↑ ↓ Enter | buttons 4 5 6 7 |

Raw ADC values only exist on the machine, where the Electron launcher forwards the Arduino serial stream through `ipcRenderer`.

## Deploy to Netlify

`netlify.toml` already sets the build command (`npm run build`), the publish directory (`dist`) and Node 22.

1. Push this repo to GitHub / GitLab.
2. In Netlify: **Add new site → Import an existing project**, pick the repo, keep the detected settings, deploy.

Or build locally and drag and drop the `dist` folder on https://app.netlify.com/drop.

## Open it on the machine

The launcher opens games by URL (`url:changed` IPC from the launcher front). Add the Netlify URL as a game in the hub, or point the launcher's `WindowManager` URL at it in `axis-launcher-electron/src/main.js` for a quick test.

## Updating the API

```bash
npm update axis-api
```

The package is pinned to the `main` branch of `gobelins-axis/axis-api`, whose `build/bundle.js` is committed by the repo's GitHub Action.
