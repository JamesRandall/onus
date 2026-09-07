// A local HTTP server for the `std.http` fixture (docs/CHANGES.md item 196):
// echoes a POST to /echo as JSON, answers 404 elsewhere; prints its URL.
import { createServer } from 'node:http';

const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, path: req.url, 'x-onus': req.headers['x-onus'] ?? null, body }));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such thing');
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}`);
});
