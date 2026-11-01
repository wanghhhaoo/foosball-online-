// 双人桌上足球 · 联机中转服务器
// 一个进程同时做两件事：
//   1. 提供 public/ 下的网页
//   2. 在 /ws 上做 WebSocket 中转：每个连接维护一份自己的"状态"，服务器把它转发给其他人
// 游戏规则和物理都在浏览器里（房主的浏览器是裁判），服务器不理解游戏，只负责转发。

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const miniws = require('./miniws');
const WebSocket = { OPEN: miniws.OPEN };

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 500;
const MAX_MSG = 4096;          // 单条状态最大字节数
const RATE = 60, BURST = 120;  // 每个连接每秒最多 60 条，可短暂突发到 120
const PUB = path.join(__dirname, 'public');
const ID_RE = /^[0-9a-f]{16}$/;
const CODE_RE = /^[A-Z0-9]{4}$/;

// ---------------- 静态网页 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8'
};
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, clients: clients.size }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.join(PUB, path.normalize(pathname));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

// ---------------- WebSocket 中转 ----------------
// clients: id -> { ws, id, presence, code, lobbyStr, tokens, last, alive }
const clients = new Map();

// 不在同一个房间的人，只需要知道"谁开了房间、房间里是谁"，用来显示大厅列表
function lobbyView(p) {
  if (!p) return null;
  const st = p.st && typeof p.st === 'object' ? p.st : null;
  return { nick: p.nick, code: p.code, role: p.role, st: st ? { g: st.g ?? null, gn: st.gn ?? '' } : null };
}
const sameRoom = (a, b) => !!a.code && a.code === b.code;
function viewFor(viewer, owner) { return sameRoom(viewer, owner) ? owner.presence : lobbyView(owner.presence); }
function send(c, obj) {
  const ws = c.ws;
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 256 * 1024) return; // 对方网络太慢：丢掉这一条，下一条会带上最新状态
  ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function syncTo(c) {
  const peers = [];
  for (const o of clients.values()) if (o !== c && o.presence) peers.push({ id: o.id, p: viewFor(c, o) });
  send(c, { t: 'sync', peers });
}

miniws.attach(server, { path: '/ws', maxPayload: MAX_MSG + 256 }, (ws, req) => {
  if (clients.size >= MAX_CLIENTS) { ws.close(1013, 'server full'); return; }
  let c = null;
  ws.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > MAX_MSG + 256) return;
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (!c) {
      // 第一条必须是 hi：客户端自带一个随机 id，断线重连时沿用，房主那边就不会把你当成新人
      if (m.t !== 'hi') return;
      const id = typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : null;
      if (!id) { ws.close(4002, 'bad id'); return; }
      if (clients.has(id)) {
        // 同一个 id 的旧连接还挂着（比如手机切了网络，旧连接还没超时）：新连接接替它
        const old = clients.get(id);
        old.replaced = true; try { old.ws.terminate(); } catch (e) {}
        clients.delete(id);
      }
      c = { ws, id, presence: null, code: null, lobbyStr: '', tokens: BURST, last: Date.now(), alive: true };
      clients.set(id, c);
      send(c, { t: 'hello', id });
      syncTo(c);
      return;
    }

    // 限流（令牌桶）
    const now = Date.now();
    c.tokens = Math.min(BURST, c.tokens + (now - c.last) * RATE / 1000);
    c.last = now;
    if (c.tokens < 1) return;
    c.tokens -= 1;

    if (m.t === 'p') {
      const p = m.p;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return;
      const oldCode = c.code;
      c.presence = p;
      c.code = typeof p.code === 'string' && CODE_RE.test(p.code) ? p.code : null;
      const lobbyStr = JSON.stringify(lobbyView(p));
      const lobbyChanged = lobbyStr !== c.lobbyStr;
      c.lobbyStr = lobbyStr;
      const full = JSON.stringify({ t: 'p', id: c.id, p });
      const lobby = JSON.stringify({ t: 'p', id: c.id, p: lobbyView(p) });
      const codeChanged = oldCode !== c.code;
      for (const o of clients.values()) {
        if (o === c) continue;
        if (sameRoom(o, c)) send(o, full);                                          // 同房间：完整状态
        else if (lobbyChanged || codeChanged && o.code && o.code === oldCode) send(o, lobby); // 其他人：只在大厅信息变了时更新
      }
      if (codeChanged) syncTo(c); // 换了房间：把新房间里的人的完整状态补给自己
    }
  });
  ws.on('pong', () => { if (c) c.alive = true; });
  ws.on('close', () => {
    if (!c || c.replaced) return;
    clients.delete(c.id);
    const msg = JSON.stringify({ t: 'leave', id: c.id });
    for (const o of clients.values()) send(o, msg);
  });
  ws.on('error', () => {});
});

// 心跳：每 10 秒 ping 一次，连续没回应的连接直接断开；同时给客户端发一条 b，让它也能发现死连接
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { try { c.ws.terminate(); } catch (e) {} continue; }
    c.alive = false;
    try { c.ws.ping(); } catch (e) {}
    send(c, '{"t":"b"}');
  }
}, 10000);

server.listen(PORT, HOST, () => {
  console.log(`桌上足球已启动：http://localhost:${PORT}  （联机地址 /ws）`);
});
