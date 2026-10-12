// Builds a static, serverless version of yoink! into dist/ (for Vercel, Netlify,
// GitHub Pages...). The server modules run inside the page: bots only, no accounts,
// progress saved in the browser. Usage: npm run build:static
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const from = (...p) => path.join(ROOT, ...p);
const to = (...p) => path.join(OUT, ...p);
const copy = (src, dest, filter) => fs.cpSync(src, dest, { recursive: true, filter });

fs.rmSync(OUT, { recursive: true, force: true });
copy(from('client'), OUT);
copy(from('shared'), to('shared'));
// everything but the Node entry point (http server, Express, Socket.IO)
copy(from('server'), to('server'), (src) => src !== from('server', 'index.js'));
copy(from('node_modules', 'three', 'build'), to('vendor', 'three', 'build'));
copy(from('node_modules', 'three', 'examples', 'jsm'), to('vendor', 'three', 'examples', 'jsm'));
for (const f of ['sql-wasm-browser.js', 'sql-wasm-browser.wasm']) copy(from('node_modules', 'sql.js', 'dist', f), to('vendor', 'sql.js', f));

// index.html: point the server's Node-only imports at browser versions, and load
// the in-page server instead of the Socket.IO client.
const htmlPath = to('index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const replace = (a, b) => {
  if (!html.includes(a)) throw new Error(`build-static: index.html no longer contains ${JSON.stringify(a)}`);
  html = html.replace(a, b);
};
replace('"three/addons/": "/vendor/three/examples/jsm/"',
  '"three/addons/": "/vendor/three/examples/jsm/",\n' +
  '        "node:crypto": "/js/local/node-crypto.js",\n' +
  '        "/server/db.js": "/js/local/db.js"');
replace('<script src="/socket.io/socket.io.js"></script>',
  '<script src="/vendor/sql.js/sql-wasm-browser.js"></script>\n' +
  '  <script type="module" src="/js/local/server.js"></script>');
fs.writeFileSync(htmlPath, html);

console.log(`Static build written to ${path.relative(ROOT, OUT)}/`);
