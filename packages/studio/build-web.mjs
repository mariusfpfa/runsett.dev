import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const path = (name) => fileURLToPath(new URL(name, import.meta.url));
await build({
  entryPoints: [path('./web/main.tsx')],
  outfile: path('./dist/public/app.js'),
  bundle: true,
  minify: true,
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff2': 'file' },
  assetNames: '[name]-[hash]',
  publicPath: '/assets',
});
for (const file of ['index.html', 'mark.svg'])
  await copyFile(path('./web/' + file), path('./dist/public/' + file));
