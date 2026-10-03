// 마감 알림 (웹 푸시)
// 보고 싶은 전시(하트)가 마감 2주 안으로 들어오면, 매일 오전 10시(한국 시간)에 한 번 모아서 알려 줌.
// 홈 화면에 추가한 앱(iOS 16.4+)과 일반 브라우저의 웹 푸시를 그대로 씀. 따로 넣을 키 없음:
// 서버 서명 키(VAPID)는 처음 필요할 때 만들어 KV에 보관.
//
// KV
//   vapid:v1          {jwk, pub}  서버 서명 키
//   push:<sha256>     {sub, items:[{id,t,n,end}], sent:{전시 id: 알린 마감일}, at}  기기(구독)마다 하나
//   pushrun:v1        마지막으로 아침 알림을 보낸 날짜 (같은 날 두 번 안 보내게)

export const ALERT_DAYS = 14;
const VAPID_KEY = 'vapid:v1';
const PREFIX = 'push:';
const RUN_KEY = 'pushrun:v1';
const SEND_HOUR_KST = 10;
const KEEP_MS = 120 * 86400e3; // 120일 동안 앱을 안 열면 구독 기록 정리
// 푸시 서비스 주소만 허용 (아무 주소로나 요청을 보내게 되지 않도록)
const ALLOWED = /^https:\/\/([a-z0-9-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)\//i;

const enc = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function subKey(endpoint) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode('gakkaun-push:' + endpoint));
  return PREFIX + [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function vapid(env) {
  const cur = await env.CACHE.get(VAPID_KEY, 'json');
  if (cur && cur.jwk && cur.pub) return cur;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = { jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
  await env.CACHE.put(VAPID_KEY, JSON.stringify(v));
  return v;
}

// RFC 8292 VAPID 서명 (ES256 JWT)
async function vapidAuth(v, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.pub}`;
}

// RFC 8291 메시지 암호화 (aes128gcm, 한 덩어리)
export async function encryptPayload(sub, text) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length;
  return concat(head, asPub, ct);
}

async function sendPush(env, v, rec, msg) {
  const body = await encryptPayload(rec.sub, JSON.stringify(msg));
  const r = await fetch(rec.sub.endpoint, {
    method: 'POST',
    headers: { authorization: await vapidAuth(v, rec.sub.endpoint, rec.origin || 'https://gallery-info.workers.dev'), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(20 * 3600), urgency: 'normal' },
    body
  });
  return r.status;
}

const cleanItems = list => (Array.isArray(list) ? list : []).slice(0, 300)
  .map(x => ({ id: String(x?.id || '').slice(0, 120), t: String(x?.t || '').slice(0, 120), n: String(x?.n || '').slice(0, 60), end: String(x?.end || '') }))
  .filter(x => x.id && /^\d{4}-\d{2}-\d{2}$/.test(x.end));
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);

// 지금 알려야 할 전시: 마감이 오늘~14일 뒤이고, 그 마감일로 아직 안 알린 것.
// 마감일은 서버 최신 데이터를 우선(연장되면 새 마감일 기준으로 다시 판단)
function dueOf(rec, exIndex, today) {
  const out = [];
  for (const it of rec.items || []) {
    const cur = exIndex.get(it.id);
    const end = cur?.end || it.end, n = dayDiff(today, end);
    if (n < 0 || n > ALERT_DAYS) continue;
    if ((rec.sent || {})[it.id] === end) continue;
    out.push({ id: it.id, t: cur?.title || it.t, n: cur?.venue || it.n, end, d: n });
  }
  return out.sort((a, b) => a.d - b.d || a.t.localeCompare(b.t));
}
function message(due) {
  const dd = d => d === 0 ? '오늘 마감' : `D-${d}`;
  if (due.length === 1) { const x = due[0]; return { title: `곧 끝나요 · ${dd(x.d)}`, body: `${x.t}${x.n ? ' · ' + x.n : ''}`, url: '/#my', tag: 'deadline' }; }
  const lines = due.slice(0, 4).map(x => `${dd(x.d)}  ${x.t}`);
  if (due.length > 4) lines.push(`외 ${due.length - 4}개`);
  return { title: `곧 끝나는 전시 ${due.length}개`, body: lines.join('\n'), url: '/#my', tag: 'deadline' };
}
function exIndexOf(ds) {
  const m = new Map();
  for (const v of ds?.venues || []) for (const e of v.ex || []) m.set(e.id, { end: e.end, title: e.title, venue: v.name });
  return m;
}
// 보내고 기록. 구독이 사라졌으면(404·410) 기록 삭제
async function deliver(env, v, key, rec, due, today) {
  const status = await sendPush(env, v, rec, message(due));
  if (status === 404 || status === 410) { await env.CACHE.delete(key); return 'gone'; }
  if (status < 200 || status >= 300) return 'fail:' + status;
  rec.sent = pruneSent(rec.sent, today);
  for (const x of due) rec.sent[x.id] = x.end;
  await env.CACHE.put(key, JSON.stringify(rec), { expirationTtl: Math.ceil(KEEP_MS / 1000) });
  return 'ok';
}
// 이미 끝난 전시의 '알림 보냄' 기록만 지움 (하트를 뺐다 다시 눌러도 같은 마감일로 또 알리지 않게 나머지는 유지)
function pruneSent(sent, today) {
  const out = {};
  for (const [id, end] of Object.entries(sent || {})) if (end >= today) out[id] = end;
  return out;
}

/* ---- 앱이 부르는 주소 ---- */
export async function pushRoute(p, body, env, url, getDs, today) {
  if (p === '/api/push/key') return { key: (await vapid(env)).pub };
  const sub = body.sub || {};
  if (p === '/api/push/delete') {
    const ep = String(body.endpoint || sub.endpoint || '');
    if (ALLOWED.test(ep)) await env.CACHE.delete(await subKey(ep));
    return { ok: true };
  }
  if (p === '/api/push/save') {
    const ep = String(sub.endpoint || '');
    if (!ALLOWED.test(ep) || !sub.keys?.p256dh || !sub.keys?.auth) return { error: '알림 구독 정보가 맞지 않아요', status: 400 };
    const v = await vapid(env);
    const key = await subKey(ep), cur = await env.CACHE.get(key, 'json');
    const rec = { sub: { endpoint: ep, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } }, items: cleanItems(body.items),
      sent: pruneSent(cur?.sent, today), origin: url.origin, at: new Date().toISOString() };
    if (body.old && body.old !== ep && ALLOWED.test(String(body.old))) {
      // 구독 주소가 바뀐 경우: 예전 기록의 '보냄' 표시를 이어받고 예전 기록은 지움
      const ok = await subKey(String(body.old)), old = await env.CACHE.get(ok, 'json');
      if (old) { rec.sent = { ...pruneSent(old.sent, today), ...rec.sent }; await env.CACHE.delete(ok); }
    }
    await env.CACHE.put(key, JSON.stringify(rec), { expirationTtl: Math.ceil(KEEP_MS / 1000) });
    let sent = '';
    if (body.welcome) {
      // 알림을 막 켰을 때: 이미 2주 안에 든 전시가 있으면 바로 알려 주고, 없으면 켜졌다는 확인만
      const due = dueOf(rec, exIndexOf(await getDs()), today);
      if (due.length) sent = await deliver(env, v, key, rec, due, today);
      else {
        const st = await sendPush(env, v, rec, { title: '마감 알림을 켰어요', body: `보고 싶은 전시가 끝나기 ${ALERT_DAYS}일 전부터 아침에 알려 드려요`, url: '/#my', tag: 'deadline' });
        sent = st >= 200 && st < 300 ? 'ok' : 'fail:' + st;
      }
    }
    return { ok: true, key: v.pub, sent };
  }
  return null;
}

/* ---- 매시 크론에서 호출: 한국 시간 오전 10시에 하루 한 번 ---- */
export async function pushDaily(env, ds, today, force) {
  const hour = (new Date().getUTCHours() + 9) % 24;
  if (!force && hour !== SEND_HOUR_KST) return { skipped: 'hour' };
  if (!force && (await env.CACHE.get(RUN_KEY)) === today) return { skipped: 'done' };
  await env.CACHE.put(RUN_KEY, today, { expirationTtl: 3 * 86400 });
  const v = await vapid(env), idx = exIndexOf(ds), report = { devices: 0, sent: 0, gone: 0, fail: 0 };
  let cursor;
  do {
    const page = await env.CACHE.list({ prefix: PREFIX, cursor });
    for (const k of page.keys) {
      const rec = await env.CACHE.get(k.name, 'json');
      if (!rec || !rec.sub) continue;
      report.devices++;
      const due = dueOf(rec, idx, today);
      if (!due.length) continue;
      const r = await deliver(env, v, k.name, rec, due, today).catch(e => 'fail:' + e.message);
      if (r === 'ok') report.sent++; else if (r === 'gone') report.gone++; else report.fail++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return report;
}
