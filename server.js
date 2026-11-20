'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4e6 });

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ---------------- lưu trữ ---------------- */
let rooms = {};
try { rooms = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { rooms = {}; }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(rooms), (err) => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 3000);
}
function flushSync() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(rooms)); } catch (e) { /* ignore */ }
}
process.on('SIGINT', () => { flushSync(); process.exit(0); });
process.on('SIGTERM', () => { flushSync(); process.exit(0); });

/* dữ liệu chỉ tồn tại khi đang chạy: chat, giơ tay, người online, mic */
const live = {};
function getLive(code) {
  return live[code] || (live[code] = { chat: [], hands: new Map(), users: new Map(), voice: false, voiceSock: null });
}
const usersList = (lv) => [...lv.users].map(([id, u]) => ({ id, name: u.name, role: u.role }));
const handsList = (lv) => [...lv.hands].map(([id, name]) => ({ id, name }));

/* ---------------- tiện ích ---------------- */
const uid = () => crypto.randomBytes(6).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}
function safeEq(a, b) {
  a = Buffer.from(String(a)); b = Buffer.from(String(b));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const BGS = ['blank', 'grid', 'lined', 'dots'];
function newPage(name, bg) {
  return { id: uid(), name: String(name || 'Trang').slice(0, 20), bg: BGS.includes(bg) ? bg : 'blank', items: [] };
}
const meta = (r) => ({ pages: r.pages.map((p) => ({ id: p.id, name: p.name, bg: p.bg })), current: r.current });

const num = (v, min, max, d = 0) => {
  v = Number(v);
  if (!isFinite(v)) return d;
  return Math.min(max, Math.max(min, v));
};
const col = (v) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : '#111111');

function sanitizeItem(it, author) {
  if (!it || typeof it !== 'object') return null;
  const id = String(it.id || '').slice(0, 24);
  if (!id) return null;
  const base = { id, author };
  switch (it.t) {
    case 'pen':
    case 'eraser': {
      const pts = Array.isArray(it.pts) ? it.pts.slice(0, 20000).map((n) => num(n, -1000, 21000)) : [];
      if (pts.length < 2) return null;
      return { ...base, t: it.t, c: col(it.c), w: num(it.w, 1, 120, 4), pts };
    }
    case 'line':
    case 'arrow':
    case 'rect':
    case 'ellipse':
      return {
        ...base, t: it.t, c: col(it.c), w: num(it.w, 1, 80, 4),
        x1: num(it.x1, -1000, 21000), y1: num(it.y1, -1000, 21000),
        x2: num(it.x2, -1000, 21000), y2: num(it.y2, -1000, 21000),
      };
    case 'text':
      return {
        ...base, t: 'text', c: col(it.c), size: num(it.size, 12, 200, 40),
        x: num(it.x, -1000, 21000), y: num(it.y, -1000, 21000),
        content: String(it.content || '').slice(0, 2000),
      };
    case 'img': {
      const src = String(it.src || '');
      if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src) || src.length > 1.8e6) return null;
      return {
        ...base, t: 'img', src,
        x: num(it.x, -1000, 21000), y: num(it.y, -1000, 21000),
        w: num(it.w, 10, 3000, 400), h: num(it.h, 10, 3000, 300),
      };
    }
    default:
      return null;
  }
}

function sanitizePatch(it, patch) {
  const P = {};
  if (!patch || typeof patch !== 'object') return P;
  if ('x' in patch) P.x = num(patch.x, -1000, 21000);
  if ('y' in patch) P.y = num(patch.y, -1000, 21000);
  if (it.t === 'img') {
    if ('w' in patch) P.w = num(patch.w, 10, 3000, it.w);
    if ('h' in patch) P.h = num(patch.h, 10, 3000, it.h);
  }
  if (it.t === 'text') {
    if ('size' in patch) P.size = num(patch.size, 12, 200, it.size);
    if ('content' in patch) P.content = String(patch.content).slice(0, 2000);
    if ('c' in patch) P.c = col(patch.c);
  }
  return P;
}

/* ---------------- lớp duy nhất ---------------- */
/* Chỉ có 1 lớp, ai vào cũng có toàn quyền. */
const ROOM = 'LOP';
const TITLE = (process.env.CLASS_TITLE || '').trim().slice(0, 60);
if (!rooms[ROOM]) {
  const first = newPage('Buổi 1', 'grid');
  const now = Date.now();
  rooms[ROOM] = { code: ROOM, title: TITLE || 'Phụ đạo', created: now, updated: now, allowDraw: true, pages: [first], current: first.id };
  save();
}
rooms[ROOM].title = TITLE || 'Phụ đạo';

const page = path.join(__dirname, 'public', 'room.html');
app.get('/', (req, res) => res.sendFile(page));
app.get('/r/:code', (req, res) => res.redirect('/'));

/* ---------------- realtime ---------------- */
io.on('connection', (sock) => {
  let room = null;
  let role = 'student';
  let name = '';
  let lastChat = 0;

  const on = (ev, fn) => sock.on(ev, (d, ack) => {
    try { fn(d && typeof d === 'object' ? d : {}, typeof ack === 'function' ? ack : () => {}); }
    catch (e) { console.error('[socket]', ev, e); }
  });
  const isT = () => role === 'teacher';
  const touch = () => { room.updated = Date.now(); save(); };
  const getPage = (id) => room.pages.find((p) => p.id === id);

  on('join', (d, ack) => {
    const r = rooms[ROOM];
    room = r;
    role = 'teacher'; // mọi người cùng quyền
    name = String(d.name || '').trim().slice(0, 30) || 'Khách';
    sock.join(r.code);
    const lv = getLive(r.code);
    lv.users.set(sock.id, { name, role });
    ack({
      id: sock.id, role, title: r.title,
      state: { pages: r.pages, current: r.current, allowDraw: r.allowDraw },
      chat: lv.chat, users: usersList(lv), hands: handsList(lv), voice: lv.voice, voiceBy: lv.voiceSock,
    });
    io.to(r.code).emit('users', usersList(lv));
  });

  /* --- vẽ --- */
  on('item:add', (d) => {
    if (!room) return;
    const pg = getPage(d.p);
    if (!pg) return;
    const item = d.item;
    if (!isT() && !(room.allowDraw && item && ['pen', 'text'].includes(item.t))) return;
    const it = sanitizeItem(item, sock.id);
    if (!it || pg.items.length > 4000) return;
    pg.items.push(it);
    touch();
    sock.to(room.code).emit('item:add', { p: pg.id, item: it });
  });

  on('stroke:append', (d) => {
    if (!room) return;
    const pg = getPage(d.p);
    if (!pg) return;
    let it = null;
    for (let i = pg.items.length - 1; i >= 0; i--) if (pg.items[i].id === d.id) { it = pg.items[i]; break; }
    if (!it || !it.pts) return;
    if (!isT() && it.author !== sock.id) return;
    const pts = Array.isArray(d.pts) ? d.pts.slice(0, 2000).map((n) => num(n, -1000, 21000)) : [];
    if (!pts.length || pts.length % 2 || it.pts.length + pts.length > 40000) return;
    it.pts.push(...pts);
    touch();
    sock.to(room.code).emit('stroke:append', { p: pg.id, id: it.id, pts });
  });

  on('item:update', (d) => {
    if (!room || !isT()) return;
    const pg = getPage(d.p);
    const it = pg && pg.items.find((i) => i.id === d.id);
    if (!it) return;
    const P = sanitizePatch(it, d.patch);
    Object.assign(it, P);
    touch();
    sock.to(room.code).emit('item:update', { p: pg.id, id: it.id, patch: P });
  });

  on('item:remove', (d) => {
    if (!room) return;
    const pg = getPage(d.p);
    const it = pg && pg.items.find((i) => i.id === d.id);
    if (!it) return;
    if (!isT() && it.author !== sock.id) return;
    pg.items = pg.items.filter((i) => i.id !== it.id);
    touch();
    sock.to(room.code).emit('item:remove', { p: pg.id, id: it.id });
  });

  on('laser', (d) => {
    if (!room || !isT()) return;
    sock.volatile.to(room.code).emit('laser', { x: num(d.x, -1000, 21000), y: num(d.y, -1000, 21000), on: !!d.on });
  });

  /* --- trang --- */
  on('page:add', (d) => {
    if (!room || !isT() || room.pages.length >= 30) return;
    const pg = newPage(d.name, d.bg);
    room.pages.push(pg);
    room.current = pg.id;
    touch();
    io.to(room.code).emit('pages:meta', meta(room));
  });
  on('page:set', (d) => {
    if (!room || !isT() || !getPage(d.id)) return;
    room.current = d.id;
    touch();
    io.to(room.code).emit('pages:meta', meta(room));
  });
  on('page:rename', (d) => {
    if (!room) return;
    const pg = getPage(d.id);
    const n = String(d.name || '').trim().slice(0, 20);
    if (!pg || !n) return;
    pg.name = n;
    touch();
    io.to(room.code).emit('pages:meta', meta(room));
  });
  on('page:bg', (d) => {
    if (!room || !isT()) return;
    const pg = getPage(d.id);
    if (!pg || !BGS.includes(d.bg)) return;
    pg.bg = d.bg;
    touch();
    io.to(room.code).emit('pages:meta', meta(room));
  });
  on('page:clear', (d) => {
    if (!room || !isT()) return;
    const pg = getPage(d.id);
    if (!pg) return;
    pg.items = [];
    touch();
    io.to(room.code).emit('page:clear', { p: pg.id });
  });
  on('page:delete', (d) => {
    if (!room || !isT() || room.pages.length <= 1) return;
    const idx = room.pages.findIndex((p) => p.id === d.id);
    if (idx < 0) return;
    room.pages.splice(idx, 1);
    if (room.current === d.id) room.current = room.pages[Math.min(idx, room.pages.length - 1)].id;
    touch();
    io.to(room.code).emit('pages:meta', meta(room));
  });

  on('allowDraw', (d) => {
    if (!room || !isT()) return;
    room.allowDraw = !!d.value;
    touch();
    io.to(room.code).emit('allowDraw', room.allowDraw);
  });

  /* --- chat, giơ tay --- */
  on('chat', (d) => {
    if (!room) return;
    const text = String(d.text || '').trim().slice(0, 500);
    const now = Date.now();
    if (!text || now - lastChat < 400) return;
    lastChat = now;
    const lv = getLive(room.code);
    const m = { name, role, text, t: now };
    lv.chat.push(m);
    if (lv.chat.length > 200) lv.chat.shift();
    io.to(room.code).emit('chat', m);
  });
  on('hand', (d) => {
    if (!room || isT()) return;
    const lv = getLive(room.code);
    if (d.value) lv.hands.set(sock.id, name); else lv.hands.delete(sock.id);
    io.to(room.code).emit('hands', handsList(lv));
  });
  on('hand:clear', (d) => {
    if (!room || !isT()) return;
    const lv = getLive(room.code);
    lv.hands.delete(d.id);
    io.to(room.code).emit('hands', handsList(lv));
  });

  /* --- mic giảng bài (WebRTC, giáo viên -> học sinh) --- */
  on('voice', (d) => {
    if (!room) return;
    const lv = getLive(room.code);
    if (d.on) { lv.voice = true; lv.voiceSock = sock.id; }
    else if (lv.voiceSock === sock.id) { lv.voice = false; lv.voiceSock = null; }
    else return;
    io.to(room.code).emit('voice', { on: lv.voice, by: lv.voiceSock });
  });
  on('rtc:ready', () => {
    if (!room) return;
    const lv = getLive(room.code);
    if (lv.voice && lv.voiceSock && lv.voiceSock !== sock.id) io.to(lv.voiceSock).emit('rtc:ready', { id: sock.id });
  });
  on('rtc:signal', (d) => {
    if (!room || typeof d.to !== 'string') return;
    const lv = getLive(room.code);
    if (!lv.users.has(d.to)) return;
    io.to(d.to).emit('rtc:signal', { from: sock.id, data: d.data });
  });

  sock.on('disconnect', () => {
    if (!room) return;
    const lv = getLive(room.code);
    lv.users.delete(sock.id);
    if (lv.hands.delete(sock.id)) io.to(room.code).emit('hands', handsList(lv));
    if (lv.voiceSock === sock.id) {
      lv.voice = false;
      lv.voiceSock = null;
      io.to(room.code).emit('voice', { on: false, by: null });
    }
    io.to(room.code).emit('users', usersList(lv));
  });
});


server.listen(PORT, () => {
  console.log('Lớp học online chạy tại http://localhost:' + PORT);
});
