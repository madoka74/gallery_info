// 전시공간 홈페이지 수집기
// 페이지 받기 → 텍스트로 줄이기 → 바뀌었을 때만 Gemini로 전시 목록 추출 → KV에 공간별 결과 저장
//
// 비밀값: GEMINI_API_KEY (필수), CF_ACCOUNT_ID + CF_API_TOKEN (자바스크립트로 그려지는 페이지용, 선택)
// 변수:   GEMINI_MODEL (기본 gemini-3.5-flash-lite), CRAWL_BATCH (한 번에 수집할 공간 수, 기본 4)

import { SOURCES } from './sources.js';

export const CRAWL_KEY = 'crawl:v1';
const UA = 'Mozilla/5.0 (compatible; GakkaunJeonsiBot/1.0; exhibition listings, once a day)';
const RECHECK_MS = 20 * 3600e3;   // 하루에 한 번
const MAX_TEXT = 60000;           // Gemini에 넘기는 텍스트 상한 (글자)
const DETAIL_MAX = 6;             // 목록에 기간이 없을 때 열어 볼 상세 페이지 수
const EXTRACT_VER = 3;            // 추출 방식이 바뀌면 올림 → 페이지가 그대로여도 다시 추출

/* ---------- 배치 실행 ---------- */
export async function crawlBatch(env, opts = {}) {
  const state = (await env.CACHE.get(CRAWL_KEY, 'json')) || {};
  const now = Date.now();
  let targets;
  if (opts.id) targets = SOURCES.filter(s => s.id === opts.id);
  else {
    const n = Math.max(1, parseInt(env.CRAWL_BATCH || '4', 10));
    targets = SOURCES
      .filter(s => !state[s.id] || now - (state[s.id].checkedAt || 0) > RECHECK_MS)
      .sort((a, b) => (state[a.id]?.checkedAt || 0) - (state[b.id]?.checkedAt || 0))
      .slice(0, n);
  }
  const report = [];
  for (const src of targets) {
    const prev = state[src.id] || {};
    try {
      const r = await crawlOne(env, src, prev, opts.force);
      state[src.id] = { ...r, checkedAt: Date.now(), ok: true, error: '' };
    } catch (e) {
      // 실패해도 지난번 결과는 유지
      state[src.id] = { ...prev, checkedAt: Date.now(), ok: false, error: String(e.message || e).slice(0, 300) };
    }
    const s = state[src.id];
    report.push({ id: src.id, name: src.name, ok: s.ok, count: (s.items || []).length, detailPages: s.pending || 0, via: s.via, changed: s.changed, url: s.url, error: s.error, renderError: s.renderError || '' });
  }
  await env.CACHE.put(CRAWL_KEY, JSON.stringify(state));
  return report;
}

export async function crawlItems(env) {
  const state = (await env.CACHE.get(CRAWL_KEY, 'json')) || {};
  const out = [];
  for (const src of SOURCES) {
    for (const e of state[src.id]?.items || []) {
      out.push({ ...e, id: `w-${src.id}-${e.id}`, src: 'crawl', place: src.name, addr: src.addr, lat: src.lat, lng: src.lng });
    }
  }
  return out;
}

export async function crawlStatus(env) {
  const state = (await env.CACHE.get(CRAWL_KEY, 'json')) || {};
  return SOURCES.map(s => {
    const st = state[s.id] || {};
    return { id: s.id, name: s.name, ok: st.ok ?? null, count: (st.items || []).length, via: st.via || '', url: st.url || s.url,
      checkedAt: st.checkedAt ? new Date(st.checkedAt).toISOString() : null, error: st.error || '', renderError: st.renderError || '' };
  });
}

// 점검용: 한 공간의 페이지가 어떻게 읽히는지 그대로 보여줌 (Gemini 호출 없음)
export async function peek(env, id, opts = {}) {
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
  let url = prev.url || src.url;
  let page = await getPage(env, src, url);

  // 페이지가 없어졌으면 홈에서 '전시' 링크를 찾아 다시 시도
  if (!page.ok && src.home) {
    const found = await discover(env, src);
    if (found) { url = found; page = await getPage(env, src, url); }
  }
  if (!page.ok) throw new Error(page.error);

  const hash = await sha1(page.text);
  if (!force && prev.hash === hash && prev.ver === EXTRACT_VER && prev.items?.length) return { ...prev, url, via: page.via, changed: false };

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
  return { url, hash: await sha1(page.text), ver: EXTRACT_VER, items, pending: r.pending.length, via: page.via, changed: true, renderError };
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
  let res;
  try { res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*', 'accept-language': 'ko,en;q=0.8' }, redirect: 'follow' }); }
  catch (e) { return { ok: false, error: '연결 실패: ' + e.message }; }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, renderError };
  const html = await readHtml(res);
  return { ok: true, via: 'html', text: htmlToText(html, res.url || url), renderError };
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

async function rendered(env, url, retried) {
  for (const path of ['browser-run', 'browser-rendering']) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/${path}/content`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url, gotoOptions: { waitUntil: 'networkidle2', timeout: 25000 } })
    });
    if (r.status === 404) continue;
    if (r.status === 429 && !retried) {
      // 무료 플랜은 분당 요청 수가 적어서 연달아 부르면 막힘 → 잠깐 쉬고 한 번만 다시
      const wait = Math.min(20, parseInt(r.headers.get('retry-after') || '10', 10) || 10);
      await new Promise(res => setTimeout(res, wait * 1000));
      return rendered(env, url, true);
    }
    const j = await r.json().catch(() => ({}));
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
    .replace(/<(script|style|noscript|svg|iframe|template|head)\b[\s\S]*?<\/\1>/gi, ' ');
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
  return h.slice(0, MAX_TEXT);
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
          fee: { type: 'STRING', description: '관람료. 없으면 빈 문자열' }
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
    if (pg.ok) parts.push(`===== 상세 페이지: ${p.link} (목록의 제목: ${p.title}) =====\n${pg.text.slice(0, 12000)}`);
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

async function gemini(env, prompt) {
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${data.error?.message || ''}`.slice(0, 300));
  const out = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new Error('Gemini 응답이 JSON이 아닙니다: ' + out.slice(0, 120)); }
  return parsed.exhibitions || [];
}

// 모델 출력 검증: 날짜 형식, 끝난 전시 제거, 텍스트에 없는 URL 제거, 같은 제목 중복 제거
export function clean(list, text, today) {
  const seen = new Set(), out = [], pending = [];
  const inText = u => u && /^https?:\/\//.test(u) && text.includes(u) ? u.replace(/^http:\/\//, 'https://') : '';
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
      poster: inText(String(x.poster || '').trim()), link: inText(String(x.link || '').trim())
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
