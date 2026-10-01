// 가까운 전시 — Cloudflare Worker
// 두 공공 API(문화포털 공연전시정보, 서울시 문화행사 정보)에서 전시만 모아
// 전시공간 단위로 묶고 KV에 캐시한 뒤, 앱이 쓰는 /api/* 엔드포인트를 제공합니다.
//
// 비밀값 (wrangler secret put):
//   DATA_GO_KR_KEY  공공데이터포털 일반 인증키 (Decoding 키 권장, Encoding 키도 자동 인식)
//   SEOUL_KEY       서울 열린데이터광장 인증키
//   ADMIN_TOKEN     /api/refresh, /api/debug 호출용 임의 문자열

const CULTURE_URL = 'https://apis.data.go.kr/B553457/nopenapi/rest/publicperformancedisplays/period';
const SEOUL_URL = key => `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/culturalEventInfo`;
// 수집 범위: 서울과 인접 지역
const BOX = { latMin: 37.25, latMax: 37.75, lngMin: 126.70, lngMax: 127.30 };
const PAGE_VENUES = 10;
const DATASET_KEY = 'dataset:v1';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    }
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    try {
      return await route(url, req, env, ctx);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(refresh(env));
  }
};

/* ---------------- routes ---------------- */
async function route(url, req, env, ctx) {
  const p = url.pathname;
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const q = k => body[k] ?? url.searchParams.get(k);

  if ((p === '/api/refresh' || p === '/api/debug') && !isAdmin(url, env)) return json({ error: 'token이 맞지 않습니다' }, 403);
  if (p === '/api/refresh') {
    const stats = await refresh(env);
    return json({ ok: true, stats });
  }
  if (p === '/api/debug') {
    return new Response(await debugRaw(url.searchParams.get('src'), env), { headers: { 'content-type': 'text/plain; charset=utf-8', ...cors() } });
  }

  const ds = await getDataset(env, ctx);
  const today = kstToday();
  const lat = num(q('lat'), 37.4979), lng = num(q('lng'), 127.0276);

  if (p === '/api/status') {
    return json({ updatedAt: ds.updatedAt, venues: ds.venues.length, exhibitions: ds.venues.reduce((n, v) => n + v.ex.length, 0), stats: ds.stats });
  }

  if (p === '/api/feed') {
    const page = Math.max(0, parseInt(q('page') || '0', 10) || 0);
    const only = Array.isArray(body.only) ? new Set(body.only) : null;
    const exclude = new Set(Array.isArray(body.exclude) ? body.exclude : []);
    const list = ds.venues
      .filter(v => (!only || only.has(v.id)) && !exclude.has(v.id))
      .map(v => withActive(v, today, lat, lng))
      .filter(v => v.ex.length)
      .sort((a, b) => a.distance - b.distance);
    const venues = list.slice(page * PAGE_VENUES, (page + 1) * PAGE_VENUES);
    return json({ page, total: list.length, hasMore: (page + 1) * PAGE_VENUES < list.length, venues, updatedAt: ds.updatedAt });
  }

  if (p === '/api/venues') {
    const ids = Array.isArray(body.ids) ? body.ids : String(q('ids') || '').split(',').filter(Boolean);
    const map = new Map(ds.venues.map(v => [v.id, v]));
    const venues = ids.map(id => map.get(id)).filter(Boolean).map(v => withActive(v, today, lat, lng));
    return json({ venues, missing: ids.filter(id => !map.has(id)) });
  }

  if (p === '/api/search') {
    const term = norm(String(q('q') || ''));
    if (!term) return json({ venues: [] });
    const venues = ds.venues
      .filter(v => norm(v.name).includes(term) || norm(v.addr).includes(term))
      .map(v => withActive(v, today, lat, lng))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 15);
    return json({ venues });
  }

  return json({ error: '알 수 없는 경로입니다' }, 404);
}

function withActive(v, today, lat, lng) {
  return { ...v, distance: Math.round(haversine(lat, lng, v.lat, v.lng)), ex: v.ex.filter(e => e.end >= today).sort((a, b) => a.start.localeCompare(b.start)) };
}

/* ---------------- dataset ---------------- */
async function getDataset(env, ctx) {
  const cached = await env.CACHE.get(DATASET_KEY, 'json');
  if (cached) {
    // 12시간 넘게 갱신이 없으면 백그라운드로 다시 받기 (크론이 실패했을 때 대비)
    if (Date.now() - Date.parse(cached.updatedAt) > 12 * 3600e3) ctx.waitUntil(refresh(env).catch(() => {}));
    return cached;
  }
  await refresh(env);
  return env.CACHE.get(DATASET_KEY, 'json');
}

async function refresh(env) {
  const stats = {};
  const results = await Promise.allSettled([fetchCulture(env, stats), fetchSeoul(env, stats)]);
  const items = [];
  results.forEach((r, i) => {
    const name = i ? 'seoul' : 'culture';
    if (r.status === 'fulfilled') items.push(...r.value);
    else stats[name + 'Error'] = String(r.reason && r.reason.message || r.reason);
  });
  if (!items.length) throw new Error('두 API 모두 전시를 가져오지 못했습니다: ' + JSON.stringify(stats));
  const venues = buildVenues(items, stats);
  const ds = { updatedAt: new Date().toISOString(), venues, stats };
  await env.CACHE.put(DATASET_KEY, JSON.stringify(ds));
  return stats;
}

/* ---- 문화포털 ---- */
function cultureKey(env) {
  const k = (env.DATA_GO_KR_KEY || '').trim();
  if (!k) throw new Error('DATA_GO_KR_KEY 비밀값이 없습니다');
  return k.includes('%') ? k : encodeURIComponent(k); // Encoding 키면 그대로, Decoding 키면 인코딩
}
function cultureUrl(env, page, withGps) {
  const t = kstToday();
  const p = new URLSearchParams({
    from: ymdCompact(addDays(t, -400)), to: ymdCompact(addDays(t, 120)),
    cPage: String(page), rows: '100', sortStdr: '1'
  });
  if (withGps) {
    p.set('gpsxfrom', String(BOX.lngMin)); p.set('gpsxto', String(BOX.lngMax));
    p.set('gpsyfrom', String(BOX.latMin)); p.set('gpsyto', String(BOX.latMax));
  }
  return `${CULTURE_URL}?${p}&serviceKey=${cultureKey(env)}`;
}
async function fetchCulture(env, stats) {
  let withGps = true, out = [], total = 0, raw = 0;
  for (let page = 1; page <= 20; page++) {
    const xml = await (await fetch(cultureUrl(env, page, withGps))).text();
    cultureCheck(xml);
    if (page === 1) {
      total = parseInt(tag(xml, ['totalCount']) || '0', 10);
      if (!total && withGps) { withGps = false; page = 0; continue; } // GPS 조건이 안 먹으면 조건 없이 다시
    }
    const blocks = blockList(xml, ['perforList', 'item']);
    raw += blocks.length;
    out.push(...blocks.map(parseCulture).filter(Boolean));
    if (!blocks.length || page * 100 >= total) break;
  }
  stats.cultureTotal = total; stats.cultureRaw = raw; stats.cultureExhibitions = out.length; stats.cultureGpsFilter = withGps;
  return out;
}
function cultureCheck(xml) {
  const err = xml.match(/SERVICE_KEY_IS_NOT_REGISTERED_ERROR|SERVICE_ACCESS_DENIED_ERROR|LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR|SERVICE ERROR|Unauthorized/i);
  if (err) throw new Error('문화포털 API: ' + err[0]);
  const code = tag(xml, ['resultCode']);
  if (code && !/^0+$/.test(code)) throw new Error(`문화포털 API: ${code} ${tag(xml, ['resultMsg'])}`);
}
function parseCulture(b) {
  const realm = tag(b, ['realmName', 'realm', 'genreName']);
  if (realm && !/전시|미술/.test(realm)) return null;
  const pos = fixLatLng(tag(b, ['gpsY', 'gpsy', 'latitude']), tag(b, ['gpsX', 'gpsx', 'longitude']));
  const place = tag(b, ['place', 'placeName']);
  const start = ymd(tag(b, ['startDate', 'startdate'])), end = ymd(tag(b, ['endDate', 'enddate']));
  if (!pos || !place || !start || !end) return null;
  return {
    id: 'c' + (tag(b, ['seq']) || hash(tag(b, ['title']) + place)),
    src: 'culture', title: tag(b, ['title']), sub: '', artist: '', genre: realm || '전시',
    start, end, fee: tag(b, ['price']) || '', poster: https(tag(b, ['thumbnail', 'imgUrl'])),
    link: https(tag(b, ['url', 'placeUrl'])) || '', place, addr: tag(b, ['placeAddr', 'area', 'sigungu']), ...pos
  };
}

/* ---- 서울시 ---- */
async function fetchSeoul(env, stats) {
  const key = (env.SEOUL_KEY || '').trim();
  if (!key) throw new Error('SEOUL_KEY 비밀값이 없습니다');
  const base = SEOUL_URL(key);
  // 1차: 분류 '전시/미술'로 서버에서 거르기
  let rows = [];
  try {
    rows = await seoulPages(`${base}`, '/' + encodeURIComponent('전시/미술'), 5);
  } catch (e) { stats.seoulFilterError = e.message; }
  stats.seoulFiltered = rows.length > 0;
  // 2차: 거르기가 안 되면 전체 받아서 직접 거르기
  if (!rows.length) rows = await seoulPages(base, '', 8);
  const out = rows.filter(r => /전시|미술/.test(r.CODENAME || '')).map(parseSeoul).filter(Boolean);
  stats.seoulRaw = rows.length; stats.seoulExhibitions = out.length;
  return out;
}
async function seoulPages(base, suffix, maxPages) {
  const rows = [];
  for (let i = 0; i < maxPages; i++) {
    const s = i * 1000 + 1, e = s + 999;
    const res = await fetch(`${base}/${s}/${e}${suffix}`);
    const data = await res.json().catch(() => { throw new Error('서울 API 응답이 JSON이 아닙니다 (HTTP ' + res.status + ')'); });
    const body = data.culturalEventInfo;
    if (!body) {
      const r = data.RESULT || {};
      if (r.CODE === 'INFO-200') break; // 데이터 없음
      throw new Error(`서울 API: ${r.CODE || ''} ${r.MESSAGE || JSON.stringify(data).slice(0, 200)}`);
    }
    rows.push(...(body.row || []));
    if (e >= (body.list_total_count || 0)) break;
  }
  return rows;
}
function parseSeoul(r) {
  const pos = fixLatLng(r.LAT, r.LOT);
  const start = ymd(r.STRTDATE), end = ymd(r.END_DATE);
  if (!pos || !r.PLACE || !start || !end) return null;
  return {
    id: 's' + hash(r.TITLE + '|' + r.PLACE + '|' + start),
    src: 'seoul', title: clean(r.TITLE), sub: '', artist: clean(r.PLAYER), genre: '전시',
    start, end, fee: clean(r.USE_FEE) || (r.IS_FREE === '무료' ? '무료' : ''),
    poster: https(r.MAIN_IMG), link: https(r.HMPG_ADDR || r.ORG_LINK) || '',
    place: clean(r.PLACE), addr: r.GUNAME ? '서울 ' + r.GUNAME : '', ...pos
  };
}

/* ---- 공간 단위로 묶기 ---- */
function buildVenues(items, stats) {
  // 1) 같은 전시(제목+공간) 중복 제거: 서울 데이터 우선, 포스터 비어 있으면 서로 채움
  const byEx = new Map();
  for (const it of items) {
    const k = norm(it.title) + '|' + placeKey(it.place);
    const prev = byEx.get(k);
    if (!prev) { byEx.set(k, it); continue; }
    const keep = prev.src === 'seoul' ? prev : it, other = keep === prev ? it : prev;
    keep.poster ||= other.poster; keep.link ||= other.link; keep.fee ||= other.fee;
    byEx.set(k, keep);
  }
  // 2) 공간 키로 묶기
  const groups = new Map();
  for (const it of byEx.values()) {
    const k = placeKey(it.place);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { key: k, names: [], addr: '', lat: it.lat, lng: it.lng, ex: [] });
    const g = groups.get(k);
    g.names.push(placeName(it.place)); g.addr ||= it.addr; g.ex.push(it);
  }
  // 3) 이름이 서로 포함되고 150m 이내면 같은 공간 ("한가람미술관" ⊂ "예술의전당 한가람미술관")
  const list = [...groups.values()].sort((a, b) => b.key.length - a.key.length);
  const merged = [];
  for (const g of list) {
    const host = merged.find(m => (m.key.includes(g.key) || g.key.includes(m.key)) && haversine(m.lat, m.lng, g.lat, g.lng) < 150);
    if (host) { host.ex.push(...g.ex); host.names.push(...g.names); host.addr ||= g.addr; }
    else merged.push(g);
  }
  const venues = merged.map(g => ({
    id: 'p' + hash(g.key),
    name: mostCommon(g.names),
    addr: g.addr, lat: +g.lat.toFixed(6), lng: +g.lng.toFixed(6),
    ex: dedupeTitles(g.ex).map(({ place, addr, lat, lng, ...e }) => e)
  }));
  stats.venues = venues.length; stats.exhibitions = venues.reduce((n, v) => n + v.ex.length, 0);
  return venues;
}

// 공간을 합친 뒤에도 같은 제목이 남으면 하나로 (서울 데이터 우선, 빈 칸은 서로 채움)
function dedupeTitles(list) {
  const m = new Map();
  for (const it of list) {
    const k = norm(it.title), prev = m.get(k);
    if (!prev) { m.set(k, it); continue; }
    const keep = prev.src === 'seoul' ? prev : it, other = keep === prev ? it : prev;
    keep.poster ||= other.poster; keep.link ||= other.link; keep.fee ||= other.fee; keep.artist ||= other.artist;
    m.set(k, keep);
  }
  return [...m.values()];
}

/* ---------------- debug ---------------- */
async function debugRaw(src, env) {
  let text;
  if (src === 'seoul') text = await (await fetch(`${SEOUL_URL(env.SEOUL_KEY || '')}/1/3`)).text();
  else text = await (await fetch(cultureUrl(env, 1, true).replace('rows=100', 'rows=3'))).text();
  for (const k of [env.SEOUL_KEY, env.DATA_GO_KR_KEY]) if (k) text = text.split(k).join('***');
  return text.slice(0, 6000);
}
function isAdmin(url, env) {
  return !!env.ADMIN_TOKEN && url.searchParams.get('token') === env.ADMIN_TOKEN;
}

/* ---------------- helpers ---------------- */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors() } });
}
function cors() { return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }; }
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
function kstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const ymdCompact = s => s.replace(/-/g, '');
function ymd(v) { const d = String(v || '').replace(/[^\d]/g, '').slice(0, 8); return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : ''; }
function fixLatLng(a, b) {
  const x = parseFloat(a), y = parseFloat(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const isLat = v => v > 33 && v < 39, isLng = v => v > 124 && v < 132;
  if (isLat(x) && isLng(y)) return { lat: x, lng: y };
  if (isLat(y) && isLng(x)) return { lat: y, lng: x }; // 위도/경도 필드가 뒤바뀐 경우
  return null;
}
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const h = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const norm = s => String(s || '').replace(/[\s·\-_.,'"“”‘’()[\]]/g, '').toLowerCase();
const clean = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
function https(u) { u = String(u || '').trim(); if (!u) return ''; if (u.startsWith('//')) return 'https:' + u; return u.replace(/^http:\/\//i, 'https://'); }
// "서울시립미술관 서소문본관 2층 전시실1 (덕수궁길)" → "서울시립미술관 서소문본관"
function placeName(p) {
  return clean(p)
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\s+(지하\s*)?(B?\d+\s*층|B\d+|\d+\s*F|제?\s*\d+\s*전시실|[A-Za-z가-힣]*\s*전시실\s*\d*|로비|야외.*|\d+\s*관(?=\s|$)).*$/i, '')
    .replace(/\s+/g, ' ').trim();
}
const placeKey = p => norm(placeName(p));
function mostCommon(arr) {
  const c = new Map(); arr.forEach(x => c.set(x, (c.get(x) || 0) + 1));
  return [...c.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
}
function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
}
function blockList(xml, names) {
  for (const n of names) {
    const out = [...xml.matchAll(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`, 'g'))].map(m => m[1]);
    if (out.length) return out;
  }
  return [];
}
function tag(xml, names) {
  for (const n of names) {
    const m = xml.match(new RegExp(`<${n}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${n}>`));
    if (m) { const v = clean(decode(m[1] ?? m[2] ?? '')); if (v) return v; }
  }
  return '';
}

// 테스트용 내보내기
export const _test = { parseCulture, parseSeoul, buildVenues, placeName, fixLatLng, blockList, ymd };
