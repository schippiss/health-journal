import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
http.createServer(async (req, res) => {
    try { const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); const file = path.resolve(root, '.' + (name === '/' ? '/demo.html' : name)); if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; } const data = await readFile(file); res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream'); res.end(data); } catch { res.writeHead(404).end(); }
}).listen(8765, '127.0.0.1', () => console.log('Demo: http://127.0.0.1:8765/demo.html?demo'));
