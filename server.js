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
async function shutdown() {
  flushSync();
  await flushGist(); // Render tắt server: kịp ghi điểm lên gist trước khi thoát
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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
    case 'dash':
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
        ...base, t: 'text', c: col(it.c), size: num(it.size, 8, 400, 40),
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
    // xoay / lật ảnh: máy gửi lại ảnh đã xoay
    if ('src' in patch) {
      const src = String(patch.src || '');
      if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src) && src.length <= 1.8e6) P.src = src;
    }
  }
  if (it.t === 'text') {
    if ('size' in patch) P.size = num(patch.size, 8, 400, it.size);
    if ('content' in patch) P.content = String(patch.content).slice(0, 2000);
    if ('c' in patch) P.c = col(patch.c);
  }
  return P;
}

/* ---------------- lớp duy nhất ---------------- */
/* Chỉ có 1 lớp, ai vào cũng có toàn quyền. */
const ROOM = 'LOP';
const TITLE = (process.env.CLASS_TITLE || '').trim().slice(0, 60);
// mã PIN để cộng/trừ điểm (đặt biến môi trường SCORE_PIN trên Render)
const SCORE_PIN = String(process.env.SCORE_PIN || '1234').trim();
if (!rooms[ROOM]) {
  const first = newPage('Trang 1', 'grid');
  const now = Date.now();
  rooms[ROOM] = { code: ROOM, title: TITLE || 'Phụ đạo', created: now, updated: now, allowDraw: true, pages: [first], current: first.id };
  save();
}
rooms[ROOM].title = TITLE || 'Phụ đạo';
if (!rooms[ROOM].score) rooms[ROOM].score = { total: 0, log: [], updated: 0 };
// đã có người chấm điểm từ lúc server chạy thì không nhận bản sao từ trình duyệt nữa
let scoreLive = false;

/* ---------------- ⭐ sao lưu điểm lên GitHub Gist (miễn phí) ----------------
   Render gói Free xóa file mỗi lần khởi động lại, nên điểm được ghi thêm vào 1 gist bí mật
   trên tài khoản GitHub của bạn. Chỉ cần biến môi trường GIST_TOKEN (token có quyền "gist").
   Gist tự được tạo ở lần chạy đầu, tìm lại theo tên file. */
const GIST_TOKEN = String(process.env.GIST_TOKEN || '').trim();
const GH_API = process.env.GIST_API || 'https://api.github.com';
const GIST_FILE = 'lop-hoc-online-score.json';
let gistId = null, gistTimer = null, gistDirty = false;
async function gh(pathname, opts = {}) {
  const r = await fetch(GH_API + pathname, {
    ...opts,
    headers: { Authorization: 'Bearer ' + GIST_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'lop-hoc-online', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('GitHub ' + r.status + ' ' + pathname);
  return r.json();
}
function cleanScore(s) {
  return {
    total: Math.trunc(Number(s && s.total)) || 0,
    log: (Array.isArray(s && s.log) ? s.log : []).slice(0, 200).map((e) => ({
      t: Number(e && e.t) || 0, d: Math.trunc(Number(e && e.d)) || 0,
      by: String((e && e.by) || '').slice(0, 30), why: String((e && e.why) || '').slice(0, 60),
    })),
    updated: Number(s && s.updated) || 0,
  };
}
async function loadScoreFromGist() {
  if (!GIST_TOKEN) return;
  try {
    const list = await gh('/gists?per_page=100');
    const found = list.find((g) => g.files && g.files[GIST_FILE]);
    if (!found) {
      const c = await gh('/gists', { method: 'POST', body: JSON.stringify({
        description: 'Bảng điểm lớp Phụ đạo (tự tạo bởi lop-hoc-online, đừng xóa)', public: false,
        files: { [GIST_FILE]: { content: JSON.stringify(rooms[ROOM].score, null, 1) } },
      }) });
      gistId = c.id;
      console.log('[gist] đã tạo gist lưu điểm:', gistId);
      return;
    }
    gistId = found.id;
    const full = await gh('/gists/' + gistId);
    const s = cleanScore(JSON.parse(full.files[GIST_FILE].content || '{}'));
    if (s.updated > (rooms[ROOM].score.updated || 0)) { rooms[ROOM].score = s; save(); }
    console.log('[gist] đã đọc điểm:', rooms[ROOM].score.total);
  } catch (e) {
    console.error('[gist] không đọc được điểm:', e.message);
  }
}
async function writeGist() {
  if (!GIST_TOKEN || !gistId || !gistDirty) return;
  gistDirty = false;
  try {
    await gh('/gists/' + gistId, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(rooms[ROOM].score, null, 1) } } }) });
  } catch (e) {
    gistDirty = true;
    console.error('[gist] không lưu được điểm:', e.message);
    clearTimeout(gistTimer); gistTimer = setTimeout(writeGist, 30000); // thử lại sau
  }
}
function saveScoreToGist() {
  if (!GIST_TOKEN) return;
  gistDirty = true;
  clearTimeout(gistTimer);
  gistTimer = setTimeout(writeGist, 2000);
}
async function flushGist() { clearTimeout(gistTimer); await writeGist(); }

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
      score: r.score, chat: lv.chat, users: usersList(lv), hands: handsList(lv), voice: lv.voice, voiceBy: lv.voiceSock,
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

  /* màn hình người kia cuộn theo */
  on('view', (d) => {
    if (!room || !d) return;
    sock.volatile.to(room.code).emit('view', { p: String(d.p || ''), x: num(d.x, 0, 21000), y: num(d.y, 0, 21000), w: num(d.w, 50, 21000, 1600), h: num(d.h, 50, 21000, 900), name });
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
  /* ⚡ chích điện: phát âm thanh trên máy người kia */
  /* ⭐ bảng điểm: lưu trong rooms.json cùng bảng */
  on('score:pin', (d, ack) => ack({ ok: safeEq(d.pin || '', SCORE_PIN) }));
  on('score:add', (d, ack) => {
    if (!room) return;
    if (!safeEq(d.pin || '', SCORE_PIN)) return ack({ error: 'pin' });
    const delta = Math.trunc(Number(d.d));
    if (!delta || Math.abs(delta) > 100) return;
    scoreLive = true;
    const sc = room.score;
    sc.total += delta;
    sc.updated = Date.now();
    sc.log.unshift({ t: sc.updated, d: delta, by: name, why: String(d.why || '').trim().slice(0, 60) });
    sc.log = sc.log.slice(0, 200);
    touch();
    saveScoreToGist();
    io.to(room.code).emit('score', { ...sc, last: sc.log[0] });
    ack({ ok: true });
  });
  // server vừa khởi động lại (mất file) thì lấy lại điểm từ bản sao trong trình duyệt
  on('score:restore', (d) => {
    if (!room) return;
    const up = Number(d.updated) || 0;
    if (scoreLive || up <= room.score.updated || up > Date.now() + 60000) return;
    const log = (Array.isArray(d.log) ? d.log : []).slice(0, 200).map((e) => ({
      t: Number(e && e.t) || 0, d: Math.trunc(Number(e && e.d)) || 0,
      by: String((e && e.by) || '').slice(0, 30), why: String((e && e.why) || '').slice(0, 60),
    }));
    room.score = { total: Math.trunc(Number(d.total)) || 0, log, updated: up };
    touch();
    saveScoreToGist();
    io.to(room.code).emit('score', room.score);
  });

  let lastZap = 0;
  on('zap', (d, ack) => {
    if (!room) return;
    if (!safeEq(d.pin || '', SCORE_PIN)) return ack({ error: 'pin' });
    const now = Date.now();
    if (now - lastZap < 800) return;
    lastZap = now;
    sock.to(room.code).emit('zap', { name });
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


loadScoreFromGist().finally(() => server.listen(PORT, () => {
  console.log('Lớp học online chạy tại http://localhost:' + PORT);
}));
