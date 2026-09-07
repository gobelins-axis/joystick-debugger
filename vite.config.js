import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        // The Axis launcher runs Electron 17 (Chromium 98).
        target: 'chrome98',
    },
});
