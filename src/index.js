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
//   KAKAO_REST_KEY  (선택) 기준 위치 검색용 카카오 로컬 API 키. 없으면 OpenStreetMap으로 검색

import { crawlBatch, crawlItems, crawlStatus, peek, loadSources, saveSource, deleteSource, storeCrawlResult, identify, inspect, COORDS_KEY, similarTitle } from './crawl.js';

// 한눈에보는문화정보 조회서비스 · 기간별(period2). XML 전용, 페이지 크기는 numOfrows(소문자 r),
// from~to는 '기간이 겹치는' 항목을 돌려줌. 정상 resultCode는 00.
const CULTURE_URL = 'https://apis.data.go.kr/B553457/cultureinfo/period2';
const SEOUL_URL = key => `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/culturalEventInfo`;
// 수집 범위: 수도권 (서울·인천·경기). 넓히면 KV 데이터가 커져 요청당 CPU가 늘어남
// 전국(제주 포함). 좌표가 바다 한가운데 등 엉뚱한 값인 것만 거름
const BOX = { latMin: 33.0, latMax: 38.7, lngMin: 124.5, lngMax: 131.0 };
const inBox = p => p.lat >= BOX.latMin && p.lat <= BOX.latMax && p.lng >= BOX.lngMin && p.lng <= BOX.lngMax;
// 배포 확인용 버전. 고칠 때마다 올림 → /api/status, /api/refresh 응답에 그대로 나옴
const VERSION = '2026-10-03.51';
const PAGE_VENUES = 10;
const DATASET_KEY = 'dataset:v1';
const API_KEY = 'api:v1';           // 공공 API 원본(정리 전) 보관
const API_EVERY_MS = 6 * 3600e3;    // 공공 API는 6시간마다

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      if (!env.ASSETS) return new Response('Not found', { status: 404 });
      const res = await env.ASSETS.fetch(req);
      // 화면(html)은 캐시하지 않음 → 배포하면 바로 새 화면
      if ((res.headers.get('content-type') || '').includes('text/html')) {
        const h = new Headers(res.headers); h.set('cache-control', 'no-cache');
        return new Response(res.body, { status: res.status, headers: h });
      }
      return res;
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

  if ((['/api/refresh', '/api/debug', '/api/crawl', '/api/sources', '/api/peek'].includes(p) || p.startsWith('/api/admin/')) && !isAdmin(url, env, req)) return json({ error: '관리자 토큰이 맞지 않습니다' }, 403);

  /* ---- 공간 관리 (관리자) ---- */
  if (p === '/api/admin/sources') {
    const [list, status] = await Promise.all([loadSources(env), crawlStatus(env)]);
    const st = new Map(status.map(x => [x.id, x]));
    return json({ sources: list.map(s => ({ ...s, status: st.get(s.id) || null })) });
  }
  if (p === '/api/admin/probe') {
    // 홈페이지 주소 → 이름·주소·좌표·전시 페이지를 찾고, 실제로 전시를 뽑아 미리보기로 돌려줌 (저장은 안 함)
    const home = normUrl(body.url);
    if (!home) return json({ error: '홈페이지 주소를 확인해 주세요' }, 400);
    let name = String(body.name || '').trim(), addr = String(body.addr || '').trim();
    let pageUrl = normUrl(body.page), branches = [], note = '', render = !!body.render;
    if (!name || !pageUrl) {
      const id = await identify(env, home);
      name ||= id.name; addr ||= id.address; pageUrl ||= id.pageUrl; branches = id.branches; note = id.note; render ||= id.render;
    }
    let lat = parseFloat(body.lat), lng = parseFloat(body.lng), geoName = '';
    if ((!Number.isFinite(lat) || !Number.isFinite(lng) || body.regeo) && addr) {
      const g = await geocode(env, addr, 37.5665, 126.978);
      if (g.places[0]) { lat = g.places[0].lat; lng = g.places[0].lng; geoName = g.places[0].name; }
    }
    const branch = String(body.branch || '').trim();
    const result = await inspect(env, { name, addr, branch, home, render }, pageUrl || home);
    const draft = { id: body.id || await newSourceId(env, home, branch), name, addr, lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
      home, url: result.url, branch, render: !!result.render, aliases: Array.isArray(body.aliases) ? body.aliases : [] };
    return json({ draft, branches, note, geoName, result });
  }
  if (p === '/api/admin/sources/save') {
    const s = body.source || {};
    if (!s.id || !s.name || !normUrl(s.url) || !Number.isFinite(+s.lat) || !Number.isFinite(+s.lng)) return json({ error: '이름, 전시 페이지, 위치(좌표)가 모두 있어야 저장할 수 있어요' }, 400);
    const saved = await saveSource(env, {
      id: String(s.id), name: String(s.name).trim(), addr: String(s.addr || '').trim(), lat: +s.lat, lng: +s.lng,
      home: normUrl(s.home) || normUrl(s.url), url: normUrl(s.url), branch: String(s.branch || '').trim(), render: !!s.render,
      aliases: (Array.isArray(s.aliases) ? s.aliases : String(s.aliases || '').split(',')).map(x => String(x).trim()).filter(Boolean)
    });
    if (body.result && body.result.ok) await storeCrawlResult(env, saved.id, body.result);
    const stats = await rebuild(env);
    return json({ ok: true, source: saved, stats });
  }
  if (p === '/api/admin/sources/delete') {
    if (!body.id) return json({ error: 'id가 없어요' }, 400);
    await deleteSource(env, String(body.id));
    const stats = await rebuild(env);
    return json({ ok: true, stats });
  }
  if (p === '/api/admin/venues/rule') {
    // {a: 공간 id, b: 공간 id, action: 'merge'|'split'|'clear'} → 두 공간을 합치거나, 다른 공간으로 고정
    const ds0 = await getDataset(env, ctx);
    const va = ds0.venues.find(v => v.id === body.a || (v.prevIds || []).includes(body.a));
    const vb = ds0.venues.find(v => v.id === body.b || (v.prevIds || []).includes(body.b));
    if (!va || !vb) return json({ error: '공간을 찾지 못했어요' }, 404);
    const rules = (await env.CACHE.get(RULES_KEY, 'json')) || { merge: [], split: [] };
    const same = r => (r.a.some(k => va.keys.includes(k)) && r.b.some(k => vb.keys.includes(k))) || (r.a.some(k => vb.keys.includes(k)) && r.b.some(k => va.keys.includes(k)));
    rules.merge = rules.merge.filter(r => !same(r)); rules.split = rules.split.filter(r => !same(r));
    if (body.action === 'merge' || body.action === 'split') rules[body.action].push({ a: va.keys, b: vb.keys, names: [va.name, vb.name], at: new Date().toISOString() });
    await env.CACHE.put(RULES_KEY, JSON.stringify(rules));
    const stats = await rebuild(env);
    return json({ ok: true, rules: { merge: rules.merge.length, split: rules.split.length }, stats });
  }
  if (p === '/api/admin/venues/rules') {
    return json((await env.CACHE.get(RULES_KEY, 'json')) || { merge: [], split: [] });
  }
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
  if (p === '/api/places') {
    // ?q=공예 → 공공 API 원본의 장소 표기와 그걸 어떻게 나눴는지 (공간 이름 정리 점검용)
    const qq = String(url.searchParams.get('q') || '').replace(/\s+/g, '');
    const api = (await env.CACHE.get(API_KEY, 'json')) || { items: [] };
    const rows = api.items.filter(it => it.place && it.place.replace(/\s+/g, '').includes(qq))
      .map(it => ({ place: it.place, parsed: placeParts(it.place), title: it.title, src: it.src, lat: it.lat, lng: it.lng, end: it.end }));
    return json({ count: rows.length, rows: rows.slice(0, 80) });
  }
  if (p === '/api/debug') {
    return new Response(await debugRaw(url.searchParams.get('src'), env), { headers: { 'content-type': 'text/plain; charset=utf-8', ...cors() } });
  }

  // http 전용 사이트(학고재 등)의 포스터: https 페이지에서는 브라우저가 막으므로 여기서 대신 받아 줌 (이미지만)
  /* ---- 백업·복원: 계정 없이 '복원 코드'로 내 저장 데이터(하트·별표·관람 기록 등)를 서버에 보관 ----
     코드는 그대로 저장하지 않고 해시로만 키를 만듦. 다른 기기가 먼저 저장했으면 409와 서버 데이터를 돌려줘서 앱이 합친 뒤 다시 저장 */
  if (p === '/api/sync/save' || p === '/api/sync/load') {
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 20 || code.length > 40) return json({ error: '복원 코드 형식이 맞지 않아요' }, 400);
    const key = 'sync:' + (await sha256hex(code));
    const cur = await env.CACHE.get(key, 'json');
    if (p === '/api/sync/load') return cur ? json({ data: cur.data, savedAt: cur.savedAt }) : json({ error: '이 코드로 저장된 데이터가 없어요' }, 404);
    const data = body.data;
    if (!data || typeof data !== 'object') return json({ error: '저장할 데이터가 없어요' }, 400);
    const raw = JSON.stringify(data);
    if (raw.length > 400000) return json({ error: '데이터가 너무 커요' }, 413);
    if (cur && body.base !== cur.savedAt) return json({ conflict: true, data: cur.data, savedAt: cur.savedAt }, 409);
    const savedAt = new Date().toISOString();
    await env.CACHE.put(key, JSON.stringify({ data, savedAt }), { expirationTtl: 400 * 86400 }); // 400일 동안 안 쓰면 지워짐
    return json({ ok: true, savedAt });
  }

  if (p === '/api/img') {
    const u = String(q('u') || '');
    if (!/^http:\/\/[^/]+\//i.test(u)) return new Response('bad url', { status: 400 });
    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 GakkaunJeonsi' }, cf: { cacheTtl: 86400, cacheEverything: true } });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\//i.test(ct)) return new Response('not an image', { status: 404 });
    return new Response(r.body, { headers: { 'content-type': ct, 'cache-control': 'public, max-age=86400' } });
  }

  if (p === '/api/geocode') {
    const term = String(q('q') || '').trim().slice(0, 80);
    if (!term) return json({ places: [] });
    return json(await geocode(env, term, num(q('lat'), 37.5665), num(q('lng'), 126.978)));
  }

  const ds = await getDataset(env, ctx);
  const today = kstToday();
  const lat = num(q('lat'), 37.4979), lng = num(q('lng'), 127.0276);

  if (p === '/api/dupes') {
    if (!isAdmin(url, env, req)) return json({ error: '관리자 토큰이 맞지 않습니다' }, 403);
    const active = ds.venues.filter(v => v.ex.some(e => e.end >= today));
    VENUE_RULES = (await env.CACHE.get(RULES_KEY, 'json')) || { merge: [], split: [] };
    const cands = dupeCandidates(active).filter(c => {
      const a = active.find(v => v.id === c.aId), b = active.find(v => v.id === c.bId);
      return ruleFor({ members: a.keys || [] }, { members: b.keys || [] }) !== 'split';
    });
    return json({ venues: active.length, candidates: cands });
  }

  if (p === '/api/status') {
    return json({ version: VERSION, kakaoJsKey: env.KAKAO_JS_KEY || '', updatedAt: ds.updatedAt, venues: ds.venues.length, exhibitions: ds.venues.reduce((n, v) => n + v.ex.length, 0), stats: ds.stats });
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
      .map(v => ({ id: v.id, name: v.name, addr: v.addr, lat: v.lat, lng: v.lng, active: v.ex.filter(e => e.end >= today).length, firstSeen: v.firstSeen, prevIds: v.prevIds || [], distance: Math.round(haversine(lat, lng, v.lat, v.lng)) }))
      .filter(v => v.active)
      .sort((a, b) => a.distance - b.distance);
    return json({ venues });
  }

  if (p === '/api/walk') {
    // TMAP 보행자 경로: 기준 위치 → 전시장 (3km 이내만). 같은 구간은 하루 동안 캐시
    if (!env.TMAP_KEY) return json({ error: 'TMAP_KEY가 없어요' }, 404);
    const f = [num(q('flat'), NaN), num(q('flng'), NaN)], t = [num(q('tlat'), NaN), num(q('tlng'), NaN)];
    if (![...f, ...t].every(Number.isFinite)) return json({ error: '좌표가 없어요' }, 400);
    if (haversine(f[0], f[1], t[0], t[1]) > 3000) return json({ tooFar: true });
    const r4 = x => x.toFixed(4);
    const ck = new Request(`https://walk.cache/${r4(f[0])},${r4(f[1])}-${r4(t[0])},${r4(t[1])}`);
    const hit = await caches.default.match(ck);
    if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json; charset=utf-8', ...cors() } });
    const res = await fetch('https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1', {
      method: 'POST', headers: { appKey: env.TMAP_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ startX: f[1], startY: f[0], endX: t[1], endY: t[0], startName: String(q('fname') || '출발').slice(0, 40), endName: String(q('tname') || '도착').slice(0, 40), reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO', searchOption: '0' })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(j.features)) return json({ error: 'TMAP ' + res.status + ': ' + (j.error?.message || j.error?.code || '경로를 받지 못했어요') }, 502);
    const path = [];
    for (const ft of j.features) if (ft.geometry?.type === 'LineString') for (const [x, y] of ft.geometry.coordinates) {
      const last = path[path.length - 1];
      if (!last || last[0] !== y || last[1] !== x) path.push([+y.toFixed(6), +x.toFixed(6)]);
    }
    const head = j.features.find(ft => ft.properties && ft.properties.totalDistance != null)?.properties || {};
    const body = JSON.stringify({ meters: head.totalDistance || 0, seconds: head.totalTime || 0, path });
    ctx.waitUntil(caches.default.put(ck, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=86400' } })));
    return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', ...cors() } });
  }

  if (p === '/api/resolve') {
    // 앱에 남아 있는 '서버에 없는 공간 id'(예전 표기 시절 하트·끔 설정)를 지금 공간으로 이어 줌
    // 순서: 예전 id 기록 → 지금 방식으로 정리한 이름의 키 → 400m 안 이름이 같은/포함하는 공간
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200);
    const vmap = (await env.CACHE.get(VID_KEY, 'json')) || {};
    const byId = new Map(ds.venues.map(v => [v.id, v]));
    const prevOf = new Map(); ds.venues.forEach(v => (v.prevIds || []).forEach(x => { if (!prevOf.has(x)) prevOf.set(x, v); }));
    const knownIds = new Set(Object.entries(vmap).filter(([k]) => !k.startsWith('@')).map(([, id]) => id));
    const out = {};
    for (const it of items) {
      // 지금 목록에 있거나, 지금 쓰는 id인데 전시가 잠시 없어 빠진 공간이면 그대로 둠
      if (!it || !it.id || byId.has(it.id) || knownIds.has(it.id)) continue;
      let v = prevOf.get(it.id);
      if (!v && it.name) {
        const k = norm(placeParts(it.name).name);
        if (k && vmap[k] && byId.has(vmap[k])) v = byId.get(vmap[k]);
      }
      if (!v && it.name && Number.isFinite(+it.lat) && Number.isFinite(+it.lng)) {
        const ka = simKey(placeParts(it.name).name);
        let best = null, bd = 400;
        for (const c of ds.venues) {
          const d = haversine(+it.lat, +it.lng, c.lat, c.lng);
          if (d >= bd) continue;
          const kb = simKey(c.name);
          if (ka.length >= 2 && kb.length >= 2 && (ka === kb || (Math.min(ka.length, kb.length) >= 3 && (ka.includes(kb) || kb.includes(ka))))) { best = c; bd = d; }
        }
        v = best;
      }
      if (v) out[it.id] = { id: v.id, name: v.name, addr: v.addr, lat: v.lat, lng: v.lng };
    }
    return json({ map: out });
  }

  if (p === '/api/venues') {
    const ids = Array.isArray(body.ids) ? body.ids : String(q('ids') || '').split(',').filter(Boolean);
    // 예전 id로 물어도 지금 공간을 돌려줌 (응답의 id·prevIds로 앱이 스스로 옮김)
    const map = new Map();
    ds.venues.forEach(v => (v.prevIds || []).forEach(x => { if (!map.has(x)) map.set(x, v); }));
    ds.venues.forEach(v => map.set(v.id, v));
    const seen = new Set();
    const venues = ids.map(id => map.get(id)).filter(v => v && !seen.has(v.id) && seen.add(v.id)).map(v => withActive(v, today, lat, lng));
    return json({ venues, missing: ids.filter(id => !map.has(id)) });
  }

  if (p === '/api/find') {
    // 전시 검색: 제목·부제·작가·다른 표기·공간 이름·주소. 공간 이름이 맞으면 그 공간 전시 전부
    const term = norm(String(q('q') || ''));
    if (!term) return json({ venues: [] });
    const hit = s => norm(s).includes(term);
    const venues = ds.venues.map(v => {
      const w = withActive(v, today, lat, lng);
      const venueHit = hit(v.name) || hit(v.addr);
      w.ex = venueHit ? w.ex : w.ex.filter(e => hit(e.title) || hit(e.sub) || hit(e.artist) || hit(e.hall) || (e.alt || []).some(hit));
      return w;
    }).filter(v => v.ex.length).sort((a, b) => a.distance - b.distance).slice(0, 40);
    return json({ venues });
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

/* ---------------- 주소·지명 → 좌표 ---------------- */
// KAKAO_REST_KEY가 있으면 카카오 로컬 API(국내 장소·주소에 가장 정확), 없으면 OpenStreetMap Nominatim
async function geocode(env, term, lat, lng) {
  const ck = 'geo3:' + (env.KAKAO_REST_KEY ? 'k:' : 'o:') + term + ':' + lat.toFixed(1) + ',' + lng.toFixed(1);   // 공급자별로 따로 저장
  const cached = await env.CACHE.get(ck, 'json');
  if (cached) return { places: cached, source: 'cache' };
  let places = [], source = '', kakaoError = '';
  if (env.KAKAO_REST_KEY) {
    try { places = await kakaoSearch(env, term, lat, lng); source = 'kakao'; }
    catch (e) { kakaoError = String(e.message || e); }   // 실패하면 OpenStreetMap으로 대신
  }
  if (!places.length) {
    try { places = await osmSearch(term, lat, lng); source = source || 'openstreetmap'; }
    catch (e) { if (!kakaoError) throw e; }
  }
  places = places.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)).slice(0, 8);
  // 빈 결과, 그리고 카카오가 실패해서 대신 받은 결과는 저장하지 않음 (카카오가 살아나면 바로 카카오 결과를 쓰도록)
  if (places.length && !kakaoError) await env.CACHE.put(ck, JSON.stringify(places), { expirationTtl: 7 * 86400 });
  return { places, source, ...(kakaoError ? { kakaoError } : {}) };
}
async function kakaoSearch(env, term, lat, lng) {
  const h = { authorization: `KakaoAK ${env.KAKAO_REST_KEY}` };
  const call = async path => {
    const r = await fetch(`https://dapi.kakao.com${path}${encodeURIComponent(term)}`, { headers: h });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`카카오 ${r.status}: ${j.message || j.msg || JSON.stringify(j).slice(0, 150)}`);
    return j.documents || [];
  };
  const [ad, kw] = await Promise.all([call('/v2/local/search/address.json?size=3&query='), call(`/v2/local/search/keyword.json?size=6&x=${lng}&y=${lat}&sort=accuracy&query=`)]);
  return [
    ...ad.map(d => ({ name: d.address_name, addr: d.road_address?.address_name || '', lat: +d.y, lng: +d.x })),
    ...kw.map(d => ({ name: d.place_name, addr: d.road_address_name || d.address_name || '', lat: +d.y, lng: +d.x }))
  ];
}
// 같은 이름이 전국에 여러 곳이라(성수동: 서울·제주…) 지금 기준점 주변을 우선하고 가까운 순으로 정렬
async function osmSearch(term, lat, lng) {
  const vb = [lng - 0.6, lat + 0.5, lng + 0.6, lat - 0.5].map(x => x.toFixed(3)).join(',');
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=kr&limit=10&accept-language=ko&viewbox=${vb}&q=${encodeURIComponent(term)}`,
    { headers: { 'user-agent': 'GakkaunJeonsi/1.0 (exhibition finder; low volume)' } });
  if (!r.ok) throw new Error('장소 검색 서버가 응답하지 않아요 (' + r.status + ')');
  const list = await r.json();
  return list.map(d => {
    const parts = String(d.display_name || '').split(',').map(x => x.trim());
    return { name: d.name || parts[0], addr: parts.slice(1, 4).reverse().join(' '), lat: +d.lat, lng: +d.lon };
  }).sort((a, b) => haversine(lat, lng, a.lat, a.lng) - haversine(lat, lng, b.lat, b.lng));
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
  // 한쪽 API가 실패하거나 갑자기 절반 넘게 줄면, 그쪽은 지난번에 받아 둔 전시를 그대로 씀
  // (일시적 장애 때문에 공간 수십 곳이 한꺼번에 사라지는 일이 없게)
  const prev = (await env.CACHE.get(API_KEY, 'json')) || { items: [] };
  const held = { ...(prev.held || {}) };   // 지난 데이터를 붙잡아 두기 시작한 시각 (출처별)
  const items = [];
  results.forEach((r, i) => {
    const name = i ? 'seoul' : 'culture';
    // 비교는 '아직 안 끝난' 지난 전시끼리 (끝난 전시까지 세면 자연스러운 감소도 이상하다고 오판함)
    // 이상하다고 판단해도 지난 데이터가 하루 넘게 묵었으면 새 데이터를 받아들임
    const today = kstToday();
    const old = prev.items.filter(it => it.src === name && it.end >= today);
    const stale = held[name] && Date.now() - held[name] > 86400e3;
    if (r.status === 'fulfilled' && (stale || !(old.length >= 20 && r.value.length < old.length * 0.5))) { items.push(...r.value); delete held[name]; return; }
    held[name] = held[name] || Date.now();
    if (r.status === 'fulfilled') stats[name + 'Suspicious'] = `${r.value.length}개 (지난번 ${old.length}개) → 지난번 데이터 유지`;
    else stats[name + 'Error'] = String(r.reason && r.reason.message || r.reason) + ` → 지난번 데이터 ${old.length}개 유지`;
    items.push(...old);
  });
  if (!items.length) throw new Error('두 API 모두 전시를 가져오지 못했습니다: ' + JSON.stringify(stats));
  await env.CACHE.put(API_KEY, JSON.stringify({ at: new Date().toISOString(), items, stats, held }));
  return stats;
}

// 공공 API 결과 + 홈페이지 수집 결과를 합쳐 공간 단위로 묶음
async function rebuild(env) {
  const api = (await env.CACHE.get(API_KEY, 'json')) || { items: [], stats: {} };
  const coordStats = await fillSourceCoords(env).catch(e => ({ error: String(e.message || e) }));
  const crawled = await crawlItems(env);
  const stats = { version: VERSION, ...api.stats, apiAt: api.at, crawledExhibitions: crawled.length, sourceCoords: coordStats };
  const today = kstToday();
  const all = [...api.items, ...crawled];
  const active = all.filter(it => it.end >= today);
  stats.endedDropped = all.length - active.length;
  VENUE_RULES = (await env.CACHE.get(RULES_KEY, 'json')) || { merge: [], split: [] };
  const venues = buildVenues(active, stats);
  await assignVenueIds(env, venues, stats);
  stats.newToday = await stampFirstSeen(env, venues);
  stats.newVenuesToday = venues.filter(v => v.firstSeen > new Date(Date.now() - 86400e3).toISOString()).length;
  // 지난번과 비교해 어떤 공간이 생기고 빠졌는지 기록 (/api/status의 stats.venueChanges로 확인)
  const old = (await env.CACHE.get(DATASET_KEY, 'json')) || { venues: [] };
  const live = list => new Map(list.filter(v => v.ex.some(e => e.end >= today)).map(v => [v.id, v.name]));
  const before = live(old.venues), after = live(venues);
  stats.venueChanges = {
    added: [...after].filter(([id]) => !before.has(id)).map(([, n]) => n).slice(0, 30),
    removed: [...before].filter(([id]) => !after.has(id)).map(([, n]) => n).slice(0, 30),
    since: old.updatedAt || null
  };
  await env.CACHE.put(DATASET_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), venues, stats }));
  return stats;
}

// 공간 id를 한 번 정하면 계속 유지: 공간을 이루는 이름 키마다 id를 기록해 두고 다음에도 같은 id를 씀
// (이름 표기가 바뀌거나 다른 표기가 합쳐져 대표 이름이 바뀌어도 하트·순서·관람 기록이 끊기지 않게)
const VID_KEY = 'vid:v1', RULES_KEY = 'venuerules:v1';
async function assignVenueIds(env, venues, stats) {
  const map = (await env.CACHE.get(VID_KEY, 'json')) || {};
  const taken = new Set();
  // 수집 공간·큰 묶음부터 id를 고름 (같은 예전 id를 두 공간이 다투면 먼저 고른 쪽이 가짐)
  const order = [...venues].sort((a, b) => b.keys.length - a.keys.length);
  for (const v of order) {
    const fresh = 'p' + hash(v.keys[0]);
    const known = v.keys.map(k => map[k]).filter(Boolean);
    const id = known.find(x => !taken.has(x)) || (!taken.has(fresh) ? fresh : 'p' + hash(v.keys.join('|')));
    taken.add(id);
    const prev = new Set([...known, ...v.keys.map(k => 'p' + hash(k)), ...v.legacy.map(k => 'p' + hash(k))]);
    prev.delete(id);
    v.id = id; v.prevIds = [...prev].slice(0, 40);
    v.keys.forEach(k => { map[k] = id; });
    // 표시 이름도 한 번 정하면 유지 (그 표기가 계속 쓰이는 동안)
    if (!v.fixedName && map['@' + id] && v.allNames.includes(map['@' + id])) v.name = map['@' + id];
    else map['@' + id] = v.name;
    delete v.legacy; delete v.allNames; delete v.fixedName;
  }
  await env.CACHE.put(VID_KEY, JSON.stringify(map));
  stats.venueIdsKnown = Object.keys(map).length;
}

// sources.js에 좌표 없이 주소만 적은 공간: 주소(안 되면 이름)로 좌표를 찾아 KV에 저장. 한 번에 몇 곳씩
async function fillSourceCoords(env) {
  const coords = (await env.CACHE.get(COORDS_KEY, 'json')) || {};
  const list = await loadSources(env);
  // geo: 주소를 모를 때 좌표를 찾을 검색어(예: '그라운드시소 센트럴')
  const keyOf = s => s.addr || s.geo;
  const need = list.filter(s => !(Number.isFinite(s.lat) && Number.isFinite(s.lng)) && keyOf(s) && !(coords[s.id] && coords[s.id].addr === keyOf(s) && coords[s.id].failedAt && Date.now() - coords[s.id].failedAt < 86400e3));
  let done = 0, failed = [];
  for (const s of need.slice(0, 12)) {
    let hit = null;
    for (const term of [s.geo, s.addr, s.name].filter(Boolean)) {
      const g = await geocode(env, term, 36.4, 127.8).catch(() => ({ places: [] }));
      if (g.places[0]) { hit = g.places[0]; break; }
    }
    if (hit) { coords[s.id] = { addr: keyOf(s), lat: hit.lat, lng: hit.lng, raddr: hit.addr || '' }; done++; }
    else { coords[s.id] = { addr: keyOf(s), failedAt: Date.now() }; failed.push(s.id); }
  }
  if (need.length) await env.CACHE.put(COORDS_KEY, JSON.stringify(coords));
  return { need: need.length, done, failed };
}

// 전시마다 '처음 들어온 시각'을 붙임 → 앱에서 NEW 표시에 사용
// 키는 공간 id + 정리한 제목. 출처가 바뀌어 대표 제목이 달라져도 합쳐진 다른 표기로 이전 시각을 찾아 이어 씀
const FS_KEY = 'firstseen:v1';
async function stampFirstSeen(env, venues) {
  const stored = await env.CACHE.get(FS_KEY, 'json');
  const firstRun = !stored, m = stored || {}, now = new Date().toISOString(), live = new Set();
  let fresh = 0;
  for (const v of venues) for (const e of v.ex) {
    const keys = [e.title, ...(e.alt || [])].map(t => v.id + '|' + titleKey(t)).filter(k => !k.endsWith('|'));
    let known = keys.map(k => m[k]).filter(Boolean).sort()[0];
    // 같은 공간에서 그 기간의 전시가 하나뿐이면, 제목을 전혀 다르게 읽었어도 같은 전시로 보고 처음 시각을 이어 씀
    const dkey = 'D|' + v.id + '|' + e.start + '|' + e.end;
    const soleDates = v.ex.filter(x => x.start === e.start && x.end === e.end).length === 1;
    if (!known && soleDates && m[dkey]) known = m[dkey];
    // 제목을 조금 다르게 읽은 경우('우우스모'↔'우우스모스'): 같은 공간의 비슷한 제목 기록을 이어 씀
    if (!known && !firstRun) {
      const pre = v.id + '|', mine = keys.map(k => k.slice(pre.length));
      known = Object.keys(m).filter(k => k.startsWith(pre) && mine.some(t => similarTitle(t, k.slice(pre.length)))).map(k => m[k]).sort()[0];
    }
    // 처음 기능을 켤 때 이미 있던 전시는 NEW로 치지 않도록 아주 옛날 시각을 줌
    const fs = known || (firstRun ? '2000-01-01T00:00:00.000Z' : now);
    if (!known && !firstRun) fresh++;
    keys.forEach(k => { if (!m[k] || m[k] > fs) m[k] = fs; live.add(k); });
    if (soleDates) { if (!m[dkey] || m[dkey] > fs) m[dkey] = fs; live.add(dkey); }
    e.firstSeen = fs; e.nk = keys[0];
  }
  // 공간도 '처음 들어온 시각' (설정 목록의 NEW). 처음 켤 때 이미 있던 공간은 옛날 시각
  const venueFirstRun = !Object.keys(m).some(k => k.startsWith('V|'));
  for (const v of venues) {
    const keys = ['V|' + v.id, 'V|n:' + norm(v.name)];
    const known = keys.map(k => m[k]).filter(Boolean).sort()[0];
    const fs = known || (venueFirstRun ? '2000-01-01T00:00:00.000Z' : now);
    keys.forEach(k => { if (!m[k] || m[k] > fs) m[k] = fs; live.add(k); });
    v.firstSeen = fs;
  }
  // 끝난 전시 기록이 너무 쌓이면 정리 (공간 기록은 남김)
  const all = Object.keys(m).filter(k => !k.startsWith('V|'));
  if (all.length > 6000) all.filter(k => !live.has(k)).sort((a, b) => m[a].localeCompare(m[b])).slice(0, all.length - 4000).forEach(k => delete m[k]);
  await env.CACHE.put(FS_KEY, JSON.stringify(m));
  return fresh;
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
    keep.alt = [...new Set([...(keep.alt || []), other.title, ...(other.alt || [])])].filter(t => t !== keep.title);
    byEx.set(k, keep);
  }
  // 2) 공간 키로 묶기 (홈페이지 수집 공간은 sources.js의 공간 하나 = 한 묶음)
  const groups = new Map(), orphans = [], subs = [];
  for (const it of byEx.values()) {
    if (it.lat == null) { orphans.push(it); continue; }
    const parts = placeParts(it.place);
    if (parts.hall && !it.hall) it.hall = parts.hall;
    const k = norm(parts.name);
    if (!k) { if (parts.hall) subs.push(it); continue; }
    if (!groups.has(k)) groups.set(k, { key: k, members: [k], names: [], addr: '', lat: it.lat, lng: it.lng, ex: [], crawl: null, aliases: [] });
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
      host.ex.push(...g.ex); host.names.push(...g.names); host.members.push(...g.members); host.addr ||= g.addr;
      // 수집 공간 좌표는 근사값이라, 공공 API 좌표가 있으면 그걸 씀
      if (host.crawl && !g.crawl && !host.preciseCoords) { host.lat = g.lat; host.lng = g.lng; host.preciseCoords = true; }
    } else merged.push(g);
  }
  stats.mergedGroups = list.length - merged.length;
  // 3-1) '전시3동'처럼 단지 이름 없이 동·관만 적힌 전시: 400m 안의 가장 가까운 공간에 붙임
  let subAttached = 0;
  for (const it of subs) {
    let best = null, bd = 400;
    for (const m of merged) { const d = haversine(m.lat, m.lng, it.lat, it.lng); if (d < bd) { bd = d; best = m; } }
    if (best) { best.ex.push(it); subAttached++; }
  }
  stats.subPlacesAttached = subAttached; stats.subPlacesDropped = subs.length - subAttached;
  // 4) 좌표 없는 전시: 이름이 같은(또는 서로 포함하는) 공간이 있으면 거기에 붙임
  let rescued = 0;
  for (const it of orphans) {
    const k = placeKey(it.place);
    const host = k && (merged.find(m => m.key === k) || merged.find(m => k.length >= 3 && (m.key.includes(k) || k.includes(m.key))));
    if (host) { host.ex.push(it); rescued++; }
  }
  stats.orphansRescued = rescued; stats.orphansDropped = orphans.length - rescued;
  const venues = merged.map(g => ({
    id: 'p' + hash(g.key),   // 임시. rebuild에서 예전 id를 이어 붙임 (assignVenueIds)
    name: g.crawl || mostCommon(g.names),
    addr: g.addr, lat: +g.lat.toFixed(6), lng: +g.lng.toFixed(6),
    keys: [...new Set(g.members)], fixedName: !!g.crawl, allNames: [...new Set(g.names)],
    // 예전 버전들이 쓰던 공간 키(장소 원문 기준) → 예전 id 후보
    legacy: [...new Set(g.ex.flatMap(e => e.place ? [norm(legacyPlaceName(e.place)), norm(clean(e.place).replace(/\(.*?\)|\[.*?\]/g, ' '))] : []))].filter(Boolean),
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
// 관리자가 정한 합치기/나누기 규칙 (rebuild에서 KV로 읽어 둠). 공간 키 묶음끼리 짝으로 저장
let VENUE_RULES = { merge: [], split: [] };
function ruleFor(a, b) {
  const A = a.members || [a.key], B = b.members || [b.key];
  const hit = r => (r.a.some(k => A.includes(k)) && r.b.some(k => B.includes(k))) || (r.a.some(k => B.includes(k)) && r.b.some(k => A.includes(k)));
  if (VENUE_RULES.split.some(hit)) return 'split';
  if (VENUE_RULES.merge.some(hit)) return 'merge';
  return '';
}
function sameVenue(a, b) {
  const rule = ruleFor(a, b);
  if (rule) return rule === 'merge';
  // 홈페이지 수집 공간 두 곳은 sources.js에서 일부러 나눈 것이라 자동으로 합치지 않음 (예술의전당 3관 등)
  if (a.crawl && b.crawl && a.crawl !== b.crawl) return false;
  const d = haversine(a.lat, a.lng, b.lat, b.lng);
  const ka = simKey(a.key), kb = simKey(b.key);
  if (!ka || !kb) return false;
  if (ka === kb && d < 700) return true;                                        // 같은 이름
  if (d < 700 && (a.aliases.includes(kb) || b.aliases.includes(ka))) return true; // sources.js 별칭
  const contains = Math.min(ka.length, kb.length) >= 3 && (ka.includes(kb) || kb.includes(ka));
  if (contains && d < (a.crawl || b.crawl ? 400 : 150)) return true;            // 한쪽 이름이 다른 쪽에 포함
  // 거의 같은 자리 + 흔한 단어(미술관·갤러리 등)를 뺀 이름이 같음 ('서울시립 남서울미술관' = '서울시립미술관 남서울미술관')
  // 한가람미술관/한가람디자인미술관처럼 같은 단지의 다른 관은 이름이 달라서 합쳐지지 않음
  const core = k => simKey(k).replace(GENERIC, '');
  return d < 60 && core(a.key) === core(b.key) && core(a.key).length >= 2;
}
// 예전(2026-10-02.27까지) 공간 이름 정리 방식: 예전 id를 찾아 이어 주는 데만 씀
function legacyPlaceName(p) {
  return clean(p).replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\s+(지하\s*)?(B?\d+\s*층|B\d+|\d+\s*F|제?\s*\d+\s*전시실|[A-Za-z가-힣]*\s*전시실\s*\d*|로비|야외.*|\d+\s*관(?=\s|$)).*$/i, '')
    .replace(/\s+/g, ' ').trim();
}
// 이름 유사도 (두 글자 조각 겹침). '갤러리·미술관' 같은 흔한 단어는 빼고 비교
const GENERIC = /갤러리|미술관|박물관|아트센터|센터|문화|gallery|museum|art/gi;
function nameSim(a, b) {
  const bi = s => { const k = simKey(s).replace(GENERIC, ''), out = new Set(); for (let i = 0; i < k.length - 1; i++) out.add(k.slice(i, i + 2)); return out; };
  const A = bi(a), B = bi(b); let n = 0; A.forEach(x => B.has(x) && n++);
  return A.size + B.size ? (2 * n) / (A.size + B.size) : 0;
}
// 점검용: 합치지 못한 '비슷한 공간' 쌍
function dupeCandidates(venues) {
  const sim = nameSim;
  const out = [];
  for (let i = 0; i < venues.length; i++) for (let j = i + 1; j < venues.length; j++) {
    const a = venues[i], b = venues[j], d = haversine(a.lat, a.lng, b.lat, b.lng), s2 = sim(a.name, b.name);
    if ((d < 60) || (s2 >= 0.5 && d < 2000)) out.push({ a: a.name, b: b.name, meters: Math.round(d), similarity: +s2.toFixed(2), aId: a.id, bId: b.id,
      aAddr: a.addr || '', bAddr: b.addr || '', aEx: a.ex.slice(0, 3).map(e => e.title), bEx: b.ex.slice(0, 3).map(e => e.title), aCount: a.ex.length, bCount: b.ex.length });
  }
  return out.sort((x, y) => y.similarity - x.similarity || x.meters - y.meters).slice(0, 80);
}

// 같은 전시가 여러 출처에 있으면: 홈페이지 수집 > 서울시 > 문화포털 순으로 대표를 고름
const rank = it => ({ crawl: 3, seoul: 2, culture: 1 })[it.src] || 0;

// 같은 공간 안의 같은 전시를 하나로. 출처마다 제목 표기가 달라서
// (《 》·[순회 전시]·'개인전' 같은 꾸밈, 띄어쓰기, 부제 유무) 정규화한 제목과 기간으로 비교
function titleKey(t) {
  return String(t || '')
    .replace(/^\s*\[[^\]]*\]\s*/, '')                                   // [순회 전시] 같은 머리말
    .replace(/[《》〈〉<>「」『』“”"'‘’\[\]()（）:：·∙\-–—~,.!?]/g, ' ')
    .replace(/(개인전|특별전|기획전|초대전|展|exhibition|solo show)/gi, ' ')
    .replace(/\s+/g, '').toLowerCase();
}
function bigramSim(a, b) {
  const bi = k => { const o = new Set(); for (let i = 0; i < k.length - 1; i++) o.add(k.slice(i, i + 2)); return o; };
  const A = bi(a), B = bi(b); let n = 0; A.forEach(x => B.has(x) && n++);
  return A.size + B.size ? (2 * n) / (A.size + B.size) : 0;
}
function sameExhibition(x, y) {
  const a = titleKey(x.title), b = titleKey(y.title);
  if (!a || !b) return false;
  const overlap = x.start <= y.end && y.start <= x.end;      // 기간이 겹침
  const sameDates = x.start === y.start && x.end === y.end;
  if (a === b) return overlap;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)) && overlap) return true; // 부제 유무
  const sim = bigramSim(a, b);
  if (sim >= 0.6 && overlap) return true;
  // 기간이 완전히 같고 한쪽 작가 이름이 다른 쪽 제목에 있으면 (한·영 표기 차이)
  // 같은 날 함께 열리는 다른 전시('회화의 시간'·'조각의 시간')를 잘못 합치지 않도록 제목 유사도만으로는 합치지 않음
  const artistIn = (p, q) => String(p.artist || '').split(/[,·\s]+/).some(n => n.length >= 2 && titleKey(q.title).includes(n.toLowerCase()));
  return sameDates && (artistIn(x, y) || artistIn(y, x));
}
function dedupeTitles(list) {
  const out = [];
  for (const it of list) {
    let i = out.findIndex(o => sameExhibition(o, it));
    // 제목 표기가 완전히 달라도(한글↔영문 등) 출처가 다르고, 이 공간에서 그 기간의 전시가 양쪽 모두 하나뿐이면 같은 전시
    if (i < 0) {
      const cand = out.map((o, k) => [o, k]).filter(([o]) => o.src !== it.src && o.start === it.start && o.end === it.end);
      const mine = list.filter(x => x.src === it.src && x.start === it.start && x.end === it.end).length;
      if (cand.length === 1 && mine === 1 && list.filter(x => x.src === cand[0][0].src && x.start === it.start && x.end === it.end).length === 1) i = cand[0][1];
    }
    if (i < 0) { out.push(it); continue; }
    const prev = out[i];
    const keep = rank(prev) >= rank(it) ? prev : it, other = keep === prev ? it : prev;
    keep.poster ||= other.poster; keep.link ||= other.link; keep.fee ||= other.fee; keep.artist ||= other.artist; keep.sub ||= other.sub;
    keep.alt = [...new Set([...(keep.alt || []), other.title, ...(other.alt || [])])].filter(t => t !== keep.title); // 합쳐진 다른 표기
    out[i] = keep;
  }
  return out;
}

/* ---------------- debug ---------------- */
async function debugRaw(src, env) {
  let text;
  if (src === 'seoul') text = await (await fetch(`${SEOUL_URL(env.SEOUL_KEY || '')}/1/3`)).text();
  else text = await (await fetch(cultureUrl(env, 1, 3))).text();
  for (const k of [env.SEOUL_KEY, env.DATA_GO_KR_KEY]) if (k) text = text.split(k).join('***');
  return text.slice(0, 6000);
}
function isAdmin(url, env, req) {
  const t = url.searchParams.get('token') || (req && req.headers.get('x-admin-token')) || '';
  return !!env.ADMIN_TOKEN && t === env.ADMIN_TOKEN;
}
function normUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return /\./.test(x.hostname) ? x.href : ''; } catch { return ''; }
}
// 새 공간 id: 도메인 이름 + (지점) → 겹치면 숫자 붙임
async function newSourceId(env, home, branch) {
  const host = new URL(home).hostname.replace(/^www\./, '').split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'venue';
  const base = branch ? `${host}-${hash(branch).slice(0, 4)}` : host;
  const ids = new Set((await loadSources(env)).map(s => s.id));
  let id = base, n = 2;
  while (ids.has(id)) id = `${base}${n++}`;
  return id;
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
// "서울공예박물관 전시3동 2층" → "서울공예박물관", "전시3동" → "" (단지 이름이 빠진 표기: 근처 공간에 붙임)
// 동·관·층·전시실처럼 한 단지 안의 위치를 나타내는 꼬리
const SUBLOC = /(?:^|\s+)(?:지하\s*)?(?:B?\d+\s*층|B\d+|\d+\s*F|제?\s*\d+\s*전시실|[A-Za-z가-힣]{0,4}\s*전시실\s*\d*|로비|야외.*|[가-힣]{0,3}\s*\d+\s*관(?=\s|$)|전시\s*\d+\s*동|\d+\s*동(?=\s|$)|별관|신관|구관)(?=\s|$|\d).*$/i;
// 여러 시설이 모인 단지는 단지 이름 하나로 (안쪽 시설 이름은 hall로)
const COMPLEXES = [
  { re: /DDP|동대문\s*디자인\s*플라자/i, name: '동대문디자인플라자(DDP)' }
];
function placeParts(p) {
  const c = clean(p);
  for (const x of COMPLEXES) if (x.re.test(c)) {
    const hall = c.replace(/\(?\s*DDP\s*\)?|동대문\s*디자인\s*플라자/gi, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
    return { name: x.name, hall };
  }
  // 'B1, B2층', '1, 2층', '1~3층', '1,' 같은 층 목록: 쉼표·물결을 띄어쓰기로 바꾸고 꼬리의 숫자 목록을 함께 떼어 냄
  const listy = /\d\s*[,~]/.test(c);
  const base = c.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s*[,~]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  let name = base.replace(SUBLOC, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/(?:\s+B\d+)+$/i, '');                 // 'B1' 같은 지하층 표기
  if (listy) name = name.replace(/(?:\s+\d+)+$/, '');         // 목록에서 남은 '1'
  name = name.trim();
  const orig = c.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();   // 관 표시는 쉼표를 살린 원래 표기로
  const hall = (orig.startsWith(name) ? orig : base).slice(name.length).replace(/^[\s,]+|[\s,]+$/g, '').trim();
  return { name, hall };
}
function placeName(p) { return placeParts(p).name; }
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

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('gakkaun-sync:' + s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
