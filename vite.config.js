import { defineConfig } from 'vite'

export default defineConfig({
    root: './',
    server: {
        open: true, // Automatically opens the browser
    },
   test: {
     environment: 'jsdom', // or 'node', 'happy-dom'
   },
});
