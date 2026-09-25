import http from 'node:http';
import net from 'node:net';
import { assertPublicUrl, isRecordableRequestMethod } from './policy.mjs';

function hostHeader(hostname, port, protocol) {
  const defaultPort = protocol === 'https:' ? 443 : 80;
  return port === defaultPort ? hostname : `${hostname}:${port}`;
}

export async function createPolicyProxy(options = {}) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const target = new URL(req.url);
      if (target.protocol !== 'http:') throw new Error('通常のproxy requestはhttpだけ許可します。');
      if (!isRecordableRequestMethod(req.method)) throw new Error('送信操作はproxyでも許可しません。');
      const checked = await assertPublicUrl(target.href, options.policyOptions);
      const port = Number(target.port || 80);
      const upstream = http.request({
        host: checked.addresses[0], port, method: req.method, path: `${target.pathname}${target.search}`,
        headers: { ...req.headers, host: hostHeader(target.hostname, port, target.protocol) },
        lookup: (_host, _options, callback) => callback(null, checked.addresses[0], net.isIP(checked.addresses[0]))
      }, (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      });
      upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    } catch (error) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error.message);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', async (req, clientSocket, head) => {
    try {
      const parsed = new URL(`https://${req.url}/`);
      const checked = await assertPublicUrl(parsed.href, options.policyOptions);
      const port = Number(parsed.port || 443);
      const upstream = net.connect({ host: checked.addresses[0], port });
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket); clientSocket.pipe(upstream);
      });
      upstream.once('error', () => clientSocket.destroy());
      clientSocket.once('error', () => upstream.destroy());
      upstream.once('close', () => clientSocket.destroy());
      clientSocket.once('close', () => upstream.destroy());
    } catch {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closed = false;
  return {
    port: server.address().port,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve) => {
        server.close(resolve);
        for (const socket of sockets) socket.destroy();
      });
    }
  };
}
