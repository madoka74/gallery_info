// 전시공간 홈페이지 수집기
// 페이지 받기 → 텍스트로 줄이기 → 바뀌었을 때만 Gemini로 전시 목록 추출 → KV에 공간별 결과 저장
//
// 비밀값: GEMINI_API_KEY (필수), CF_ACCOUNT_ID + CF_API_TOKEN (자바스크립트로 그려지는 페이지용, 선택)
// 변수:   GEMINI_MODEL (기본 gemini-3.5-flash-lite), CRAWL_BATCH (한 번에 수집할 공간 수, 기본 4)

import { SOURCES as SEED } from './sources.js';

/* ---------- 공간 목록: 서버 저장소(KV)에 두고 앱에서 추가·수정·삭제 ---------- */
// sources.js는 초기값. 코드로 넣은 공간 중 앱에서 손대지 않은 것은 코드 수정이 그대로 반영됨
export const SOURCES_KEY = 'sources:v1';
export async function loadSources(env) {
  const st = (await env.CACHE.get(SOURCES_KEY, 'json')) || { list: [], deleted: [] };
  const del = new Set(st.deleted || []);
  let changed = !st.seeded;
  for (const seed of SEED) {
    if (del.has(seed.id)) continue;
    const i = st.list.findIndex(s => s.id === seed.id);
    if (i < 0) { st.list.push({ ...seed, origin: 'seed' }); changed = true; }
    else if (st.list[i].origin === 'seed' && !st.list[i].edited && JSON.stringify({ ...seed, origin: 'seed' }) !== JSON.stringify(st.list[i])) {
      st.list[i] = { ...seed, origin: 'seed' }; changed = true;
    }
  }
  st.seeded = true;
  if (changed) await env.CACHE.put(SOURCES_KEY, JSON.stringify(st));
  return st.list;
}
export async function saveSource(env, src) {
  const st = (await env.CACHE.get(SOURCES_KEY, 'json')) || { list: [], deleted: [] };
  await loadSources(env); // 초기값 채우기
  const cur = (await env.CACHE.get(SOURCES_KEY, 'json')) || st;
  const i = cur.list.findIndex(s => s.id === src.id);
  const next = { ...(i >= 0 ? cur.list[i] : { origin: 'user' }), ...src, edited: true };
  if (i >= 0) cur.list[i] = next; else cur.list.push(next);
  cur.deleted = (cur.deleted || []).filter(id => id !== src.id);
  await env.CACHE.put(SOURCES_KEY, JSON.stringify(cur));
  return next;
}
export async function deleteSource(env, id) {
  await loadSources(env);
  const cur = await env.CACHE.get(SOURCES_KEY, 'json');
  cur.list = cur.list.filter(s => s.id !== id);
  cur.deleted = [...new Set([...(cur.deleted || []), id])];
  await env.CACHE.put(SOURCES_KEY, JSON.stringify(cur));
  const state = (await env.CACHE.get(CRAWL_KEY, 'json')) || {};
  delete state[id];
  await env.CACHE.put(CRAWL_KEY, JSON.stringify(state));
}
// 미리보기에서 이미 뽑은 결과를 그대로 수집 결과로 저장 (Gemini를 한 번 더 부르지 않도록)
export async function storeCrawlResult(env, id, r) {
  const state = (await env.CACHE.get(CRAWL_KEY, 'json')) || {};
  state[id] = { url: r.url, srcUrl: r.url, hash: r.hash || '', ver: EXTRACT_VER, items: r.items || [], pending: r.pending || 0, via: r.via || 'html',
    changed: true, checkedAt: Date.now(), nextAt: Date.now() + RECHECK_MS, ok: true, error: '', renderError: '' };
  await env.CACHE.put(CRAWL_KEY, JSON.stringify(state));
}

export const CRAWL_KEY = 'crawl:v1';
const UA = 'Mozilla/5.0 (compatible; GakkaunJeonsiBot/1.0; exhibition listings, once a day)';
const RECHECK_MS = 20 * 3600e3;   // 하루에 한 번
const MAX_TEXT = 25000;           // Gemini에 넘기는 텍스트 상한 (글자). 무료 할당량(분당 토큰)을 고려해 작게
const RETRY_MS = 60 * 60e3;       // 일시적 실패(할당량 초과, 서버 오류)는 1시간 뒤 다시
const GEMINI_GAP_MS = 4000;       // Gemini 호출 사이 간격
const DETAIL_MAX = 6;             // 목록에 기간이 없을 때 열어 볼 상세 페이지 수
const EXTRACT_VER = 4;            // 추출 방식이 바뀌면 올림 → 페이지가 그대로여도 다시 추출

/* ---------- 배치 실행 ---------- */
export async function crawlBatch(env, opts = {}) {
  const SOURCES = await loadSources(env);
  const state = (await env.CACHE.get(CRAWL_KEY, 'json')) || {};
  const now = Date.now();
  const dueAt = st => st?.nextAt ?? ((st?.checkedAt || 0) + RECHECK_MS);
  let targets;
  if (opts.id) targets = SOURCES.filter(s => s.id === opts.id);
  else {
    const n = Math.max(1, parseInt(env.CRAWL_BATCH || '4', 10));
    targets = SOURCES.filter(s => !state[s.id] || dueAt(state[s.id]) <= now)
      .sort((a, b) => dueAt(state[a.id]) - dueAt(state[b.id]))
      .slice(0, n);
  }
  const report = [];
  let quotaHit = false;
  for (const src of targets) {
    const prev = state[src.id] || {};
    if (quotaHit) { report.push({ id: src.id, name: src.name, skipped: 'Gemini 할당량 초과·과부하로 다음에 다시' }); continue; }
    try {
      const r = await crawlOne(env, src, prev, opts.force);
      state[src.id] = { ...r, checkedAt: Date.now(), nextAt: Date.now() + RECHECK_MS, ok: true, error: '' };
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      const transient = isTransient(msg);
      if (/^Gemini (429|5\d\d)/.test(msg)) quotaHit = true; // 할당량 초과·서버 과부하면 이번 묶음은 멈춤
      // 실패해도 지난번 결과는 유지. 일시적 실패는 1시간 뒤, 나머지는 하루 뒤 다시
      state[src.id] = { ...prev, checkedAt: Date.now(), nextAt: Date.now() + (transient ? RETRY_MS : RECHECK_MS), ok: false, error: msg, transient };
    }
    const s = state[src.id];
    report.push({ id: src.id, name: src.name, ok: s.ok, count: (s.items || []).length, detailPages: s.pending || 0, via: s.via, changed: s.changed, url: s.url, error: s.error, renderError: s.renderError || '' });
  }
  await env.CACHE.put(CRAWL_KEY, JSON.stringify(state));
  return report;
}
const isTransient = msg => /^Gemini (429|5\d\d)|HTTP (5\d\d)|연결 실패|timed? ?out|렌더링 실패/i.test(msg);

export async function crawlItems(env) {
  const SOURCES = await loadSources(env);
  const state = (await env.CACHE.get(CRAWL_KEY, 'json')) || {};
  const out = [];
  // 한 페이지를 여러 공간이 나눠 읽는 경우(예술의전당 3관, 국립현대미술관 서울·덕수궁, 대림·디뮤지엄)
  // 같은 전시가 두 공간에 동시에 들어가지 않도록, 전시장소 표기를 보고 한 공간에만 배정
  const groups = new Map();
  for (const src of SOURCES) { const k = src.url; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(src); }
  for (const srcs of groups.values()) {
    const picked = new Map(); // 제목 → {src, item, score}
    for (const src of srcs) for (const e of state[src.id]?.items || []) {
      const k = tkey(e.title);
      const score = hallScore(e.hall, src);
      const prev = picked.get(k);
      if (!prev || score > prev.score) picked.set(k, { src, e, score });
    }
    for (const { src, e } of picked.values())
      out.push({ ...e, id: `w-${src.id}-${e.id}`, src: 'crawl', srcId: src.id, aliases: src.aliases || [], place: src.name, addr: src.addr, lat: src.lat, lng: src.lng });
  }
  return out;
}
const tkey = t => String(t || '').replace(/[\s《》〈〉<>「」『』“”"'\[\]():·\-–—~,.!?]/g, '').toLowerCase();
// 전시장소 표기가 이 공간 이름(별칭 포함)을 얼마나 길게 담고 있는지. 표기가 없으면 0
function hallScore(hall, src) {
  const h = tkey(hall).replace(/예술의전당/g, '');
  if (!h) return 0;
  let best = 0;
  for (const n of [src.name, ...(src.aliases || [])]) {
    const k = tkey(n).replace(/예술의전당/g, '');
    if (k.length >= 2 && h.includes(k)) best = Math.max(best, k.length);
  }
  return best;
}

export async function crawlStatus(env) {
  const SOURCES = await loadSources(env);
  const state = (await env.CACHE.get(CRAWL_KEY, 'json')) || {};
  return SOURCES.map(s => {
    const st = state[s.id] || {};
    return { id: s.id, name: s.name, ok: st.ok ?? null, count: (st.items || []).length, via: st.via || '', url: st.url || s.url,
      checkedAt: st.checkedAt ? new Date(st.checkedAt).toISOString() : null, nextAt: st.nextAt ? new Date(st.nextAt).toISOString() : null,
      error: st.error || '', retrySoon: !!st.transient, renderError: st.renderError || '' };
  });
}

// 점검용: 한 공간의 페이지가 어떻게 읽히는지 그대로 보여줌 (Gemini 호출 없음)
export async function peek(env, id, opts = {}) {
  const SOURCES = await loadSources(env);
  const src = SOURCES.find(s => s.id === id);
  if (!src && !opts.url) throw new Error('없는 id입니다: ' + id);
  const base = src || { id: 'adhoc', name: '', addr: '', home: opts.url };
  const url = opts.url || src.url;
  const page = await getPage(env, { ...base, render: !!opts.render }, url);
  const links = [...new Set((page.text || '').match(/\[LINK [^\]]+\]/g) || [])].map(x => x.slice(6, -1));
  return {
    id, url, ok: page.ok, via: page.via, error: page.error || '', renderError: page.renderError || '',
    textLength: (page.text || '').length,
    exhibitionLinks: links.filter(l => /exhibit|전시|show|program/i.test(l)).slice(0, 40),
    otherLinks: links.filter(l => !/exhibit|전시|show|program/i.test(l)).slice(0, 40),
    text: (page.text || '').slice(0, 6000)
  };
}

/* ---------- 한 공간 ---------- */
async function crawlOne(env, src, prev, force) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 비밀값이 없습니다');
  // sources.js에서 주소를 바꿨으면 예전에 찾아 둔 주소 대신 새 주소부터
  let url = (prev.srcUrl === src.url && prev.url) || src.url;
  let page = await getPage(env, src, url);

  // 페이지가 없어졌으면 홈에서 '전시' 링크를 찾아 다시 시도
  if (!page.ok && src.home) {
    const found = await discover(env, src);
    if (found) { url = found; page = await getPage(env, src, url); }
  }
  if (!page.ok) throw new Error(page.error);

  const hash = await sha1(page.text);
  if (!force && prev.hash === hash && prev.ver === EXTRACT_VER && prev.items?.length) return { ...prev, url, srcUrl: src.url, via: page.via, changed: false };

  let renderError = page.renderError || '';
  let r = await extract(env, src, page.text, url);

  // 아무것도 못 찾았으면 자바스크립트로 목록을 그리는 사이트일 수 있으니 브라우저로 다시
  if (!r.items.length && !r.pending.length && page.via === 'html' && canRender(env)) {
    const p2 = await getPage(env, { ...src, render: true }, url);
    if (p2.ok && p2.via === 'render') { page = p2; r = await extract(env, src, page.text, url); }
    else renderError = p2.renderError || p2.error || renderError;
  }
  // 그래도 없으면 홈에서 전시 페이지를 찾아 한 번 더 (자바스크립트 사이트면 렌더링한 홈에서 링크를 찾음)
  if (!r.items.length && !r.pending.length && src.home) {
    const found = await discover(env, src, url, page.via === 'render');
    if (found && found !== url) {
      const p3 = await getPage(env, { ...src, render: page.via === 'render' }, found);
      if (p3.ok) {
        const r3 = await extract(env, src, p3.text, found);
        if (r3.items.length || r3.pending.length) { url = found; page = p3; r = r3; }
      }
    }
  }
  // 목록에 기간이 없는 전시는 상세 페이지를 열어서 기간·포스터를 채움
  let items = r.items;
  if (r.pending.length) {
    const more = await extractDetails(env, src, r.pending.slice(0, page.via === 'render' ? 4 : DETAIL_MAX), page.via === 'render');
    const have = new Set(items.map(x => x.title.replace(/\s+/g, '').toLowerCase()));
    items = items.concat(more.filter(x => !have.has(x.title.replace(/\s+/g, '').toLowerCase())));
  }
  return { url, srcUrl: src.url, hash: await sha1(page.text), ver: EXTRACT_VER, items, pending: r.pending.length, via: page.via, changed: true, renderError };
}

/* ---------- 페이지 받기 ---------- */
const canRender = env => !!(env.CF_ACCOUNT_ID && env.CF_API_TOKEN);

async function getPage(env, src, url) {
  if (!(await robotsAllows(env, url))) return { ok: false, error: 'robots.txt가 수집을 막고 있습니다' };
  let renderError = '';
  if (src.render && canRender(env)) {
    try { return { ok: true, via: 'render', text: htmlToText(await rendered(env, url), url) }; }
    catch (e) { renderError = String(e.message || e).slice(0, 200); } // 실패하면 일반 요청으로
  }
  let last = '';
  // 인증서 오류(526)·서버 오류(52x)·연결 실패면 http/https, www 유무를 바꿔 다시
  for (const u of urlVariants(url)) {
    let res;
    try { res = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html,*/*', 'accept-language': 'ko,en;q=0.8' }, redirect: 'follow' }); }
    catch (e) { last = '연결 실패: ' + e.message; continue; }
    if (res.ok) {
      const html = await readHtml(res);
      return { ok: true, via: 'html', text: htmlToText(html, res.url || u), renderError };
    }
    last = `HTTP ${res.status}`;
    if (res.status < 500) break; // 4xx는 주소를 바꿔도 같음
  }
  // 봇 요청만 막는 사이트(403/404)는 실제 브라우저로 한 번 더
  if (/HTTP 40[34]/.test(last) && !src.render && canRender(env)) {
    try { return { ok: true, via: 'render', text: htmlToText(await rendered(env, url), url) }; }
    catch (e) { renderError = String(e.message || e).slice(0, 200); }
  }
  return { ok: false, error: last, renderError };
}
function urlVariants(url) {
  const out = [url];
  try {
    const u = new URL(url);
    const flipProto = new URL(url); flipProto.protocol = u.protocol === 'https:' ? 'http:' : 'https:';
    const flipWww = new URL(url); flipWww.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname;
    out.push(flipProto.href, flipWww.href);
  } catch {}
  return [...new Set(out)];
}

async function readHtml(res) {
  // EUC-KR 사이트 대응
  const buf = await res.arrayBuffer();
  const ct = res.headers.get('content-type') || '';
  let charset = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(buf.slice(0, 3000));
    charset = (head.match(/charset=["']?([\w-]+)/i) || [])[1];
  }
  try { return new TextDecoder((charset || 'utf-8').toLowerCase()).decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}

async function rendered(env, url, retried, gentle) {
  for (const path of ['browser-run', 'browser-rendering']) {
    // gentle: 스스로 이동(리다이렉트)하거나 이미지·영상이 끝없이 로딩돼 시간 초과 나는 사이트용.
    // 문서 뼈대만 받으면 바로 진행하고, 화면이 그려질 시간을 잠깐 준 뒤 읽음
    const opts = gentle
      ? { url, gotoOptions: { waitUntil: 'domcontentloaded', timeout: 40000 }, waitForTimeout: 5000 }
      : { url, gotoOptions: { waitUntil: 'networkidle2', timeout: 25000 } };
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/${path}/content`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(opts)
    });
    if (r.status === 404) continue;
    if (r.status === 429 && !retried) {
      // 무료 플랜은 분당 요청 수가 적어서 연달아 부르면 막힘 → 잠깐 쉬고 한 번만 다시
      const wait = Math.min(20, parseInt(r.headers.get('retry-after') || '10', 10) || 10);
      await new Promise(res => setTimeout(res, wait * 1000));
      return rendered(env, url, true, gentle);
    }
    const j = await r.json().catch(() => ({}));
    if ((!r.ok || j.success === false) && !gentle && /execution context|navigation|timeout/i.test(JSON.stringify(j.errors || ''))) return rendered(env, url, retried, true);
    if (!r.ok || j.success === false) throw new Error('브라우저 렌더링 실패: ' + JSON.stringify(j.errors || r.status).slice(0, 200));
    return typeof j.result === 'string' ? j.result : '';
  }
  throw new Error('브라우저 렌더링 엔드포인트를 찾지 못했습니다');
}

async function discover(env, src, exclude, useRender) {
  try {
    let html = '', base = src.home;
    if (useRender && canRender(env)) { try { html = await rendered(env, src.home); } catch {} }
    if (!html) {
      const res = await fetch(src.home, { headers: { 'user-agent': UA } });
      if (!res.ok) return null;
      html = await readHtml(res); base = res.url || src.home;
    }
    const links = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map(m => ({ href: abs(m[1], base), text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
      .filter(l => l.href && l.href.startsWith('http') && l.href !== exclude && /exhibit|전시|show/i.test(l.href + ' ' + l.text) && !/past|지난|archive|아카이브/i.test(l.href + ' ' + l.text));
    links.sort((a, b) => score(b) - score(a));
    return links[0]?.href || null;
  } catch { return null; }
}
const score = l => (/current|now|진행|현재|on.?view/i.test(l.href + l.text) ? 2 : 0) + (/exhibit|전시/i.test(l.text) ? 1 : 0);

/* ---------- robots.txt ---------- */
const robotsMemo = new Map();
async function robotsAllows(env, url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (!robotsMemo.has(u.origin)) {
    let rules = [];
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: { 'user-agent': UA } });
      if (r.ok) rules = parseRobots(await r.text());
    } catch {}
    robotsMemo.set(u.origin, rules);
  }
  const path = u.pathname + u.search;
  let best = null;
  for (const r of robotsMemo.get(u.origin)) if (r.path && path.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
  return !best || best.allow;
}
function parseRobots(txt) {
  const out = []; let agents = [], inRules = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const at = line.indexOf(':'); if (at < 0) continue;
    const key = line.slice(0, at).trim().toLowerCase(), v = line.slice(at + 1).trim();
    if (key === 'user-agent') { if (inRules) { agents = []; inRules = false; } agents.push(v.toLowerCase()); }
    else if (key === 'disallow' || key === 'allow') {
      inRules = true;
      if (agents.some(a => a === '*' || a.includes('gakkaun'))) out.push({ path: v, allow: key === 'allow' });
    }
  }
  return out;
}

/* ---------- HTML → 텍스트 ---------- */
export function htmlToText(html, base) {
  let h = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    // 사이트 메뉴·머리말·꼬리말은 전시 정보가 아니라서 버림 (메뉴가 길면 본문이 글자 수 제한에 잘려 나감)
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  // 배경 이미지로 쓰인 포스터
  h = h.replace(/<[^>]*style=["'][^"']*url\(\s*['"]?([^'")]+)['"]?\s*\)[^>]*>/gi, (tag, u) => `${tag} [IMG ${abs(u, base)}] `);
  h = h.replace(/<img\b[^>]*>/gi, tag => {
    const src = (tag.match(/\s(?:data-src|data-original|data-lazy-src|src)=["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/\salt=["']([^"']*)["']/i) || [])[1] || '';
    return src && !src.startsWith('data:') ? ` [IMG ${alt} ${abs(src, base)}] ` : ' ';
  });
  h = h.replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>/gi, (_, u) => /^(javascript|mailto|tel):/i.test(u) ? ' ' : ` [LINK ${abs(u, base)}] `);
  h = h.replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article|dd|dt)>/gi, '\n');
  h = h.replace(/<[^>]+>/g, ' ');
  h = h.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
       .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
  h = h.replace(/[ \t\f\r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
  const seen = new Set();
  // 같은 줄은 길이와 상관없이 한 번만 (슬라이드 배너는 같은 이미지·문구를 수십 번 복제해 둠)
  let lines = h.split('\n').filter(line => { if (seen.has(line)) return false; seen.add(line); return true; });
  // 링크 하나에 짧은 글자만 있는 줄이 8줄 넘게 이어지면 메뉴 덩어리로 보고 버림
  const isMenuLine = l => /^\[LINK [^\]]+\]\s*\S.{0,18}$/.test(l) && !/\d{4}[.\-/]\d{1,2}/.test(l);
  const out = [];
  for (let i = 0; i < lines.length;) {
    let j = i; while (j < lines.length && isMenuLine(lines[j])) j++;
    if (j - i >= 8) { i = j; continue; }
    out.push(lines[i]); i++;
  }
  return out.join('\n').slice(0, MAX_TEXT);
}
function abs(u, base) { try { return new URL(String(u).replace(/&amp;/g, '&').trim(), base).href; } catch { return ''; } }

/* ---------- Gemini 추출 ---------- */
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    exhibitions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: '전시 제목' },
          subtitle: { type: 'STRING', description: '부제. 없으면 빈 문자열' },
          artists: { type: 'STRING', description: '참여 작가. 쉼표로 구분, 없으면 빈 문자열' },
          start: { type: 'STRING', description: '시작일 YYYY-MM-DD. 페이지에 기간이 없으면 빈 문자열' },
          end: { type: 'STRING', description: '종료일 YYYY-MM-DD. 페이지에 기간이 없으면 빈 문자열' },
          poster: { type: 'STRING', description: '이 전시의 대표 이미지 URL. 텍스트의 [IMG ...]에 있는 주소 그대로. 없으면 빈 문자열' },
          link: { type: 'STRING', description: '이 전시 상세 페이지 URL. 텍스트의 [LINK ...]에 있는 주소 그대로. 없으면 빈 문자열' },
          fee: { type: 'STRING', description: '관람료. 없으면 빈 문자열' },
          hall: { type: 'STRING', description: '페이지에 적힌 전시장소(관·전시실) 이름 그대로. 없으면 빈 문자열' }
        },
        required: ['title', 'start', 'end', 'link']
      }
    }
  },
  required: ['exhibitions']
};

const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function extract(env, src, text, url) {
  const today = kstToday();
  const prompt = `다음은 전시공간 "${src.name}"(${src.addr})의 웹페이지(${url})에서 뽑은 텍스트다.
오늘은 ${today}이다.

규칙:
- 이 공간에서 지금 진행 중이거나 앞으로 열릴 전시만 뽑아라. 이미 끝난 전시, 지난 전시 아카이브, 뉴스, 이벤트, 교육 프로그램, 공연은 제외.
${src.branch ? `- 이 페이지에는 여러 지점·도시의 전시가 섞여 있을 수 있다. "${src.branch}"에 해당하는 전시만 포함하고 나머지는 제외.\n` : ''}- 날짜는 YYYY-MM-DD로. 연도가 없으면 오늘 기준으로 가장 자연스러운 연도를 쓴다.
- 현재 전시 목록인데 기간이 페이지에 안 적혀 있으면 start·end를 빈 문자열로 두고, 그 전시의 상세 페이지 link는 반드시 채운다.
- poster와 link는 텍스트 안의 [IMG 주소], [LINK 주소]에 실제로 있는 주소만 그대로 쓰고, 지어내지 마라. 확실하지 않으면 빈 문자열.
- 제목·작가 이름은 페이지에 적힌 그대로. 한국어와 영어가 같이 있으면 한국어를 우선.
- 해당하는 전시가 없으면 빈 배열.

----- 페이지 텍스트 -----
${text}`;
  return clean(await gemini(env, prompt), text, today);
}

// 상세 페이지 여러 개를 한 번에 넘겨 기간·포스터를 뽑음
async function extractDetails(env, src, pending, listViaRender) {
  const parts = [];
  for (const p of pending) {
    // 상세 페이지는 대개 정적이라 일반 요청 먼저, 거의 비어 있으면(자바스크립트 사이트) 렌더링
    let pg = await getPage(env, { ...src, render: false }, p.link);
    if (listViaRender && (!pg.ok || pg.text.length < 1500) && canRender(env)) {
      const pr = await getPage(env, { ...src, render: true }, p.link);
      if (pr.ok) pg = pr;
    }
    if (pg.ok) parts.push(`===== 상세 페이지: ${p.link} (목록의 제목: ${p.title}) =====\n${pg.text.slice(0, 8000)}`);
  }
  if (!parts.length) return [];
  const today = kstToday();
  const text = parts.join('\n\n');
  const prompt = `다음은 전시공간 "${src.name}"(${src.addr})의 전시 상세 페이지 ${parts.length}개에서 뽑은 텍스트다. 오늘은 ${today}이다.

규칙:
- 각 상세 페이지마다 그 페이지가 소개하는 전시 하나를 뽑는다. link는 그 상세 페이지 주소를 그대로 쓴다.
- 이미 끝난 전시, 기간을 끝내 알 수 없는 전시는 제외.
${src.branch ? `- "${src.branch}"에 해당하지 않는 전시는 제외.\n` : ''}- 날짜는 YYYY-MM-DD. poster는 텍스트의 [IMG 주소] 중 그 전시 대표 이미지로 보이는 것만, 지어내지 마라.

${text}`;
  return clean(await gemini(env, prompt), text + pending.map(p => p.link).join(' '), today).items;
}

let lastGemini = 0;
async function gemini(env, prompt, schema = SCHEMA, pick = 'exhibitions') {
  const wait = lastGemini + GEMINI_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGemini = Date.now();
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const call = () => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema }
    })
  });
  let res = await call();
  // 503(과부하)·500은 잠깐 쉬고 한 번만 다시
  if (res.status >= 500) { await new Promise(r => setTimeout(r, 8000)); res = await call(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message || ''}`.slice(0, 300));
  const out = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new Error('Gemini 응답이 JSON이 아닙니다: ' + out.slice(0, 120)); }
  return pick ? (parsed[pick] || []) : parsed;
}

// 모델 출력 검증: 날짜 형식, 끝난 전시 제거, 텍스트에 없는 URL 제거, 같은 제목 중복 제거
export function clean(list, text, today) {
  const seen = new Set(), out = [], pending = [];
  // https가 안 되는 사이트(학고재 등)도 있어서 주소는 페이지에 적힌 그대로 둠
  const inText = u => u && /^https?:\/\//.test(u) && text.includes(u) ? u : '';
  for (const x of list) {
    const title = String(x.title || '').trim();
    const start = normDate(x.start), end = normDate(x.end);
    if (!title) continue;
    const key = title.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    if (!start || !end) {
      // 기간 없음: 상세 페이지 주소가 확실하면 나중에 열어 봄 (원래 주소 그대로 사용)
      const raw = String(x.link || '').trim();
      if (raw && /^https?:\/\//.test(raw) && text.includes(raw)) { seen.add(key); pending.push({ title, link: raw }); }
      continue;
    }
    if (end < today || end < start) continue;
    seen.add(key);
    out.push({
      id: 'w' + hashStr(title + start),
      title, sub: String(x.subtitle || '').trim(), artist: String(x.artists || '').trim(),
      start, end, fee: String(x.fee || '').trim(), genre: '전시',
      poster: inText(String(x.poster || '').trim()), link: inText(String(x.link || '').trim()),
      hall: String(x.hall || '').trim()
    });
  }
  return { items: out, pending };
}
function normDate(v) { const d = String(v || '').replace(/[^\d]/g, ''); return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : ''; }
function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
async function sha1(s) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}


/* ---------- 새 공간 진단: 홈페이지 → 이름·주소·지점·전시 목록 페이지 ---------- */
const ID_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: '전시공간의 공식 이름. 한국어 이름이 있으면 한국어' },
    address: { type: 'STRING', description: '전시공간 주소(도로명 우선). 보통 페이지 아래쪽에 있음. 없으면 빈 문자열' },
    branches: { type: 'ARRAY', items: { type: 'STRING' }, description: '지점·관이 여러 곳이면 그 이름들(예: 서울, 부산). 하나뿐이면 빈 배열' },
    exhibitionListUrl: { type: 'STRING', description: '현재·예정 전시 목록 페이지 주소. 반드시 텍스트의 [LINK 주소] 중 하나 그대로. 홈 화면에 전시 목록이 있으면 홈 주소' },
    note: { type: 'STRING', description: '참고할 점 한 문장(예: 전시 준비 중, 인스타그램만 운영 등). 없으면 빈 문자열' }
  },
  required: ['name', 'address', 'branches', 'exhibitionListUrl', 'note']
};
export async function identify(env, homeUrl) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 비밀값이 없습니다');
  let page = await getPage(env, { render: false }, homeUrl);
  if (page.ok && page.text.length < 1500 && canRender(env)) {
    const p2 = await getPage(env, { render: true }, homeUrl);
    if (p2.ok && p2.text.length > page.text.length) page = p2;
  }
  if (!page.ok && canRender(env)) page = await getPage(env, { render: true }, homeUrl);
  if (!page.ok) throw new Error('홈페이지를 열지 못했어요: ' + (page.error || page.renderError || ''));
  const prompt = `다음은 어떤 미술관·갤러리 홈페이지(${homeUrl})에서 뽑은 텍스트다. [LINK 주소]는 링크, [IMG 주소]는 이미지다.
이 공간의 이름, 주소, 지점 목록, 그리고 '현재·예정 전시 목록'을 보여주는 페이지 주소를 찾아라.
- exhibitionListUrl은 반드시 텍스트에 있는 [LINK 주소] 중 하나를 그대로 쓴다. 지난 전시(archive, past) 페이지는 고르지 마라.
- 주소는 페이지에 적힌 그대로. 없으면 빈 문자열.

----- 홈페이지 텍스트 -----
${page.text.slice(0, 15000)}`;
  const r = await gemini(env, prompt, ID_SCHEMA, null);
  let listUrl = String(r.exhibitionListUrl || '').trim();
  if (!listUrl || !(page.text.includes(listUrl) || listUrl === homeUrl)) {
    listUrl = (await discover(env, { home: homeUrl }, null, page.via === 'render')) || homeUrl; // 모델이 고른 주소가 텍스트에 없으면 직접 찾음
  }
  return { name: String(r.name || '').trim(), address: String(r.address || '').trim(), branches: (r.branches || []).map(String).filter(Boolean),
    pageUrl: listUrl, note: String(r.note || '').trim(), render: page.via === 'render' };
}

// 정해진 전시 페이지에서 실제로 뽑아 보기 (일반 → 렌더링 → 상세 페이지 순으로 시도)
export async function inspect(env, src, pageUrl) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 비밀값이 없습니다');
  let page = await getPage(env, src, pageUrl);
  if (!page.ok && !src.render && canRender(env)) page = await getPage(env, { ...src, render: true }, pageUrl);
  if (!page.ok) return { ok: false, url: pageUrl, error: page.error || '페이지를 열지 못했어요', renderError: page.renderError || '' };
  let r = await extract(env, src, page.text, pageUrl);
  if (!r.items.length && !r.pending.length && page.via === 'html' && canRender(env)) {
    const p2 = await getPage(env, { ...src, render: true }, pageUrl);
    if (p2.ok && p2.via === 'render') { const r2 = await extract(env, src, p2.text, pageUrl); if (r2.items.length || r2.pending.length) { page = p2; r = r2; } }
  }
  let items = r.items;
  if (r.pending.length) {
    const more = await extractDetails(env, src, r.pending.slice(0, page.via === 'render' ? 4 : DETAIL_MAX), page.via === 'render');
    const have = new Set(items.map(x => x.title.replace(/\s+/g, '').toLowerCase()));
    items = items.concat(more.filter(x => !have.has(x.title.replace(/\s+/g, '').toLowerCase())));
  }
  return { ok: true, url: pageUrl, via: page.via, render: page.via === 'render', items, pending: r.pending.length,
    hash: await sha1(page.text), textLength: page.text.length, renderError: page.renderError || '' };
}
