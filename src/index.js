// 가까운 전시 — Cloudflare Worker
// 두 공공 API(문화포털 공연전시정보, 서울시 문화행사 정보)에서 전시만 모아
// 전시공간 단위로 묶고 KV에 캐시한 뒤, 앱이 쓰는 /api/* 엔드포인트를 제공합니다.
//
// 여기에 전시공간 홈페이지 직접 수집(src/crawl.js, 대상 목록은 src/sources.js)을 더합니다.
//
// 비밀값 (Secret):
//   DATA_GO_KR_KEY  공공데이터포털 일반 인증키 (Decoding 키 권장, Encoding 키도 자동 인식)
//   SEOUL_KEY       서울 열린데이터광장 인증키
//   ADMIN_TOKEN     관리용 주소(/api/refresh 등) 비밀번호
//   GEMINI_API_KEY  홈페이지에서 전시 목록을 뽑는 Gemini 키
//   CF_ACCOUNT_ID, CF_API_TOKEN  (선택) 자바스크립트로 그려지는 페이지를 읽는 브라우저 렌더링용

import { crawlBatch, crawlItems, crawlStatus, peek } from './crawl.js';

// 한눈에보는문화정보 조회서비스 · 기간별(period2). XML 전용, 페이지 크기는 numOfrows(소문자 r),
// from~to는 '기간이 겹치는' 항목을 돌려줌. 정상 resultCode는 00.
const CULTURE_URL = 'https://apis.data.go.kr/B553457/cultureinfo/period2';
const SEOUL_URL = key => `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/culturalEventInfo`;
// 수집 범위: 수도권 (서울·인천·경기). 넓히면 KV 데이터가 커져 요청당 CPU가 늘어남
const BOX = { latMin: 36.90, latMax: 38.00, lngMin: 126.30, lngMax: 127.85 };
const inBox = p => p.lat >= BOX.latMin && p.lat <= BOX.latMax && p.lng >= BOX.lngMin && p.lng <= BOX.lngMax;
const PAGE_VENUES = 10;
const DATASET_KEY = 'dataset:v1';
const API_KEY = 'api:v1';           // 공공 API 원본(정리 전) 보관
const API_EVERY_MS = 6 * 3600e3;    // 공공 API는 6시간마다

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
  // 매시 정각: 공공 API(6시간마다) + 홈페이지 몇 곳 수집 → 데이터 다시 묶기
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil((async () => {
      const api = await env.CACHE.get(API_KEY, 'json');
      if (!api || Date.now() - Date.parse(api.at) > API_EVERY_MS) await refreshApis(env).catch(() => {});
      await crawlBatch(env).catch(() => {});
      await rebuild(env);
    })());
  }
};

/* ---------------- routes ---------------- */
async function route(url, req, env, ctx) {
  const p = url.pathname;
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const q = k => body[k] ?? url.searchParams.get(k);

  if (['/api/refresh', '/api/debug', '/api/crawl', '/api/sources', '/api/peek'].includes(p) && !isAdmin(url, env)) return json({ error: 'token이 맞지 않습니다' }, 403);
  if (p === '/api/refresh') {
    // 공공 API 다시 받기 + 데이터 다시 묶기 (홈페이지 수집은 /api/crawl)
    await refreshApis(env);
    const stats = await rebuild(env);
    return json({ ok: true, stats });
  }
  if (p === '/api/crawl') {
    // ?id=leeum 한 곳만 (force=1이면 페이지가 그대로여도 다시 추출) · id 없으면 다음 묶음
    const report = await crawlBatch(env, { id: url.searchParams.get('id') || undefined, force: url.searchParams.get('force') === '1' });
    const stats = await rebuild(env);
    return json({ ok: true, report, stats });
  }
  if (p === '/api/peek') {
    // ?id=daelim&render=1 (또는 &url=다른주소) → 수집기가 읽은 텍스트와 링크를 그대로 보여줌
    return json(await peek(env, url.searchParams.get('id'), { render: url.searchParams.get('render') === '1', url: url.searchParams.get('url') || undefined }));
  }
  if (p === '/api/sources') {
    const list = await crawlStatus(env);
    return json({ total: list.length, done: list.filter(s => s.ok).length, failed: list.filter(s => s.ok === false).length, pending: list.filter(s => s.ok === null).length, exhibitions: list.reduce((n, s) => n + s.count, 0), sources: list });
  }
  if (p === '/api/debug') {
    return new Response(await debugRaw(url.searchParams.get('src'), env), { headers: { 'content-type': 'text/plain; charset=utf-8', ...cors() } });
  }

  const ds = await getDataset(env, ctx);
  const today = kstToday();
  const lat = num(q('lat'), 37.4979), lng = num(q('lng'), 127.0276);

  if (p === '/api/dupes') {
    if (!isAdmin(url, env)) return json({ error: 'token이 맞지 않습니다' }, 403);
    const active = ds.venues.filter(v => v.ex.some(e => e.end >= today));
    return json({ venues: active.length, candidates: dupeCandidates(active) });
  }

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

  if (p === '/api/allvenues') {
    // 설정 탭용: 지금 열린 전시가 있는 모든 공간 (전시 목록 없이 요약만)
    const venues = ds.venues
      .map(v => ({ id: v.id, name: v.name, addr: v.addr, lat: v.lat, lng: v.lng, active: v.ex.filter(e => e.end >= today).length, distance: Math.round(haversine(lat, lng, v.lat, v.lng)) }))
      .filter(v => v.active)
      .sort((a, b) => a.distance - b.distance);
    return json({ venues });
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
    if (Date.now() - Date.parse(cached.updatedAt) > 12 * 3600e3) ctx.waitUntil(refreshApis(env).then(() => rebuild(env)).catch(() => {}));
    return cached;
  }
  if (!(await env.CACHE.get(API_KEY))) await refreshApis(env);
  await rebuild(env);
  return env.CACHE.get(DATASET_KEY, 'json');
}

async function refreshApis(env) {
  const stats = {};
  const results = await Promise.allSettled([fetchCulture(env, stats), fetchSeoul(env, stats)]);
  const items = [];
  results.forEach((r, i) => {
    const name = i ? 'seoul' : 'culture';
    if (r.status === 'fulfilled') items.push(...r.value);
    else stats[name + 'Error'] = String(r.reason && r.reason.message || r.reason);
  });
  if (!items.length) throw new Error('두 API 모두 전시를 가져오지 못했습니다: ' + JSON.stringify(stats));
  await env.CACHE.put(API_KEY, JSON.stringify({ at: new Date().toISOString(), items, stats }));
  return stats;
}

// 공공 API 결과 + 홈페이지 수집 결과를 합쳐 공간 단위로 묶음
async function rebuild(env) {
  const api = (await env.CACHE.get(API_KEY, 'json')) || { items: [], stats: {} };
  const crawled = await crawlItems(env);
  const stats = { ...api.stats, apiAt: api.at, crawledExhibitions: crawled.length };
  const today = kstToday();
  const all = [...api.items, ...crawled];
  const active = all.filter(it => it.end >= today);
  stats.endedDropped = all.length - active.length;
  const venues = buildVenues(active, stats);
  await env.CACHE.put(DATASET_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), venues, stats }));
  return stats;
}

/* ---- 문화포털 ---- */
function cultureKey(env) {
  const k = (env.DATA_GO_KR_KEY || '').trim();
  if (!k) throw new Error('DATA_GO_KR_KEY 비밀값이 없습니다');
  return k.includes('%') ? k : encodeURIComponent(k); // Encoding 키면 그대로, Decoding 키면 인코딩
}
function cultureUrl(env, page, rows = 1000) {
  const t = kstToday();
  // 오늘~60일 뒤와 겹치는 것 = 지금 열려 있거나 곧 열리는 전시
  return `${CULTURE_URL}?serviceKey=${cultureKey(env)}&from=${ymdCompact(t)}&to=${ymdCompact(addDays(t, 60))}` +
    `&numOfrows=${rows}&cPage=${page}&sortStdr=1`;
}
async function fetchCulture(env, stats) {
  const out = [], realms = {};
  let total = 0, raw = 0, noPos = 0, outside = 0;
  for (let page = 1; page <= 8; page++) {
    const xml = await (await fetch(cultureUrl(env, page), { headers: { accept: 'application/xml' } })).text();
    cultureCheck(xml);
    if (page === 1) total = parseInt(tag(xml, ['totalCount']) || '0', 10);
    const blocks = blockList(xml, ['item']);
    raw += blocks.length;
    for (const b of blocks) {
      const realm = tag(b, ['realmName']);
      realms[realm || '(없음)'] = (realms[realm || '(없음)'] || 0) + 1;
      const e = parseCulture(b);
      if (!e) continue;
      if (e.lat == null) { noPos++; out.push(e); continue; } // 좌표 없음: 같은 이름 공간에 붙여 살림
      if (!inBox(e)) { outside++; continue; }
      out.push(e);
    }
    if (!blocks.length || page * 1000 >= total) break;
  }
  Object.assign(stats, { cultureTotal: total, cultureRaw: raw, cultureExhibitions: out.length, cultureNoCoords: noPos, cultureOutside: outside, cultureRealms: realms });
  return out;
}
function cultureCheck(xml) {
  const rc = tag(xml, ['resultCode']);
  if (rc === '00') return;
  const reason = tag(xml, ['returnReasonCode']), msg = tag(xml, ['errMsg', 'returnAuthMsg', 'resultMsg']);
  throw new Error(`문화포털 API 실패 ${reason || rc || ''} ${msg || xml.slice(0, 120)}`.trim());
}
function parseCulture(b) {
  if (tag(b, ['realmName']) !== '전시') return null;
  const place = tag(b, ['place']);
  const start = ymd(tag(b, ['startDate'])), end = ymd(tag(b, ['endDate']));
  if (!place || !start || !end) return null;
  const pos = fixLatLng(tag(b, ['gpsY']), tag(b, ['gpsX'])) || { lat: null, lng: null };
  const area = [tag(b, ['area']), tag(b, ['sigungu'])].filter(Boolean).join(' ');
  return {
    id: 'c' + (tag(b, ['seq']) || hash(tag(b, ['title']) + place)),
    src: 'culture', title: tag(b, ['title']), sub: '', artist: '', genre: '전시',
    start, end, fee: '', poster: https(tag(b, ['thumbnail'])), link: '', place, addr: area, ...pos
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
  const out = rows.filter(r => /전시|미술/.test(r.CODENAME || '')).map(parseSeoul).filter(Boolean).filter(inBox);
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
    const keep = rank(prev) >= rank(it) ? prev : it, other = keep === prev ? it : prev;
    keep.poster ||= other.poster; keep.link ||= other.link; keep.fee ||= other.fee; keep.artist ||= other.artist;
    byEx.set(k, keep);
  }
  // 2) 공간 키로 묶기 (홈페이지 수집 공간은 sources.js의 공간 하나 = 한 묶음)
  const groups = new Map(), orphans = [];
  for (const it of byEx.values()) {
    if (it.lat == null) { orphans.push(it); continue; }
    const k = placeKey(it.place);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { key: k, names: [], addr: '', lat: it.lat, lng: it.lng, ex: [], crawl: null, aliases: [] });
    const g = groups.get(k);
    g.names.push(placeName(it.place)); g.addr ||= it.addr; g.ex.push(it);
    if (it.src === 'crawl' && !g.crawl) { g.crawl = it.place; g.aliases = (it.aliases || []).map(simKey).filter(Boolean); }
  }
  // 3) 같은 공간 합치기. 홈페이지 수집 공간을 기준(host)으로 먼저 놓고, 이름이 길수록 먼저
  const list = [...groups.values()].sort((a, b) => (!!b.crawl - !!a.crawl) || b.key.length - a.key.length);
  const merged = [];
  for (const g of list) {
    const host = merged.find(m => sameVenue(m, g));
    if (host) {
      host.ex.push(...g.ex); host.names.push(...g.names); host.addr ||= g.addr;
      // 수집 공간 좌표는 근사값이라, 공공 API 좌표가 있으면 그걸 씀
      if (host.crawl && !g.crawl && !host.preciseCoords) { host.lat = g.lat; host.lng = g.lng; host.preciseCoords = true; }
    } else merged.push(g);
  }
  stats.mergedGroups = list.length - merged.length;
  // 4) 좌표 없는 전시: 이름이 같은(또는 서로 포함하는) 공간이 있으면 거기에 붙임
  let rescued = 0;
  for (const it of orphans) {
    const k = placeKey(it.place);
    const host = k && (merged.find(m => m.key === k) || merged.find(m => k.length >= 3 && (m.key.includes(k) || k.includes(m.key))));
    if (host) { host.ex.push(it); rescued++; }
  }
  stats.orphansRescued = rescued; stats.orphansDropped = orphans.length - rescued;
  const venues = merged.map(g => ({
    id: 'p' + hash(g.key),
    name: g.crawl || mostCommon(g.names),
    addr: g.addr, lat: +g.lat.toFixed(6), lng: +g.lng.toFixed(6),
    ex: dedupeTitles(g.ex).map(({ place, addr, lat, lng, ...e }) => e)
  }));
  stats.venues = venues.length; stats.exhibitions = venues.reduce((n, v) => n + v.ex.length, 0);
  return venues;
}

// 공간 이름 비교용: 띄어쓰기·기호 제거 + '서울관/서울점/본관' 같은 꼬리 제거
function simKey(name) {
  return norm(String(name || '').replace(/\(재\)|재단법인/g, ''))
    .replace(/(서울관|서울점|서울|본관|본점|seoul)$/i, '');
}
function sameVenue(a, b) {
  const d = haversine(a.lat, a.lng, b.lat, b.lng);
  const ka = simKey(a.key), kb = simKey(b.key);
  if (!ka || !kb) return false;
  if (ka === kb && d < 700) return true;                                        // 같은 이름
  if (d < 700 && (a.aliases.includes(kb) || b.aliases.includes(ka))) return true; // sources.js 별칭
  const contains = Math.min(ka.length, kb.length) >= 3 && (ka.includes(kb) || kb.includes(ka));
  return contains && d < (a.crawl || b.crawl ? 400 : 150);                       // 한쪽 이름이 다른 쪽에 포함
}
// 점검용: 합치지 못한 '비슷한 공간' 쌍
function dupeCandidates(venues) {
  const bi = s => { const k = simKey(s), out = new Set(); for (let i = 0; i < k.length - 1; i++) out.add(k.slice(i, i + 2)); return out; };
  const sim = (a, b) => { const A = bi(a), B = bi(b); let n = 0; A.forEach(x => B.has(x) && n++); return A.size + B.size ? (2 * n) / (A.size + B.size) : 0; };
  const out = [];
  for (let i = 0; i < venues.length; i++) for (let j = i + 1; j < venues.length; j++) {
    const a = venues[i], b = venues[j], d = haversine(a.lat, a.lng, b.lat, b.lng), s2 = sim(a.name, b.name);
    if ((d < 60) || (s2 >= 0.5 && d < 2000)) out.push({ a: a.name, b: b.name, meters: Math.round(d), similarity: +s2.toFixed(2), aId: a.id, bId: b.id });
  }
  return out.sort((x, y) => y.similarity - x.similarity || x.meters - y.meters).slice(0, 80);
}

// 같은 전시가 여러 출처에 있으면: 홈페이지 수집 > 서울시 > 문화포털 순으로 대표를 고름
const rank = it => ({ crawl: 3, seoul: 2, culture: 1 })[it.src] || 0;

// 공간을 합친 뒤에도 같은 제목이 남으면 하나로 (서울 데이터 우선, 빈 칸은 서로 채움)
function dedupeTitles(list) {
  const m = new Map();
  for (const it of list) {
    const k = norm(it.title), prev = m.get(k);
    if (!prev) { m.set(k, it); continue; }
    const keep = rank(prev) >= rank(it) ? prev : it, other = keep === prev ? it : prev;
    keep.poster ||= other.poster; keep.link ||= other.link; keep.fee ||= other.fee; keep.artist ||= other.artist; keep.sub ||= other.sub;
    m.set(k, keep);
  }
  return [...m.values()];
}

/* ---------------- debug ---------------- */
async function debugRaw(src, env) {
  let text;
  if (src === 'seoul') text = await (await fetch(`${SEOUL_URL(env.SEOUL_KEY || '')}/1/3`)).text();
  else text = await (await fetch(cultureUrl(env, 1, 3))).text();
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
export const _test = { rebuild, parseCulture, parseSeoul, buildVenues, placeName, fixLatLng, blockList, ymd };
