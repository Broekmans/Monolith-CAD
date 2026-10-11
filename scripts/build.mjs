import * as esbuild from 'esbuild';
import fs from 'node:fs';
fs.mkdirSync('renderer/dist', { recursive: true });
fs.copyFileSync('node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm', 'renderer/planegcs.wasm');
await esbuild.build({
  entryPoints: ['renderer/src/main.js'], bundle: true, outfile: 'renderer/dist/app.js',
  format: 'iife', platform: 'browser', target: 'chrome120', sourcemap: true, minify: process.argv.includes('--min'),
  external: ['fs', 'path', 'module', 'url', 'node:*'], logLevel: 'warning',
});
console.log('renderer built', (fs.statSync('renderer/dist/app.js').size / 1024).toFixed(0) + ' KB');
