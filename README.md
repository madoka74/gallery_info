# 가까운 전시 — 실제 데이터 연결

문화포털 공연·전시 API와 서울시 문화행사 API에서 **전시만** 모아 전시공간 단위로 묶고,
강남역(또는 고른 위치) 기준 가까운 공간 10곳씩 보여주는 웹앱입니다.
Cloudflare Worker 하나가 프록시(인증키 보관·캐시)와 화면 제공을 함께 맡습니다.

```
gakkaun-jeonsi/
├─ src/index.js        Worker: API 수집 → 정리 → KV 캐시 → /api/*
├─ public/index.html   화면 (근처 · 하트 · MY · 설정)
├─ wrangler.toml       배포 설정 (KV id만 채우면 됨)
└─ .dev.vars.example   로컬 테스트용 비밀값 예시
```

---

## 할 일 순서

### 1. 준비 (한 번만)
1. Node.js 18 이상 설치 (`node -v`로 확인)
2. https://dash.cloudflare.com 무료 가입
3. 이 폴더에서:
   ```bash
   npm install
   npx wrangler login        # 브라우저가 열리면 허용
   ```

### 2. 캐시 저장소(KV) 만들기
```bash
npx wrangler kv namespace create CACHE
```
출력에 나오는 `id = "..."` 값을 `wrangler.toml`의 `여기에_KV_ID` 자리에 붙여 넣습니다.

### 3. 인증키 넣기 (코드에 적지 않고 Cloudflare에 비밀값으로 저장)
```bash
npx wrangler secret put DATA_GO_KR_KEY   # 공공데이터포털 '일반 인증키(Decoding)' 붙여넣기
npx wrangler secret put SEOUL_KEY        # 서울 열린데이터광장 인증키
npx wrangler secret put ADMIN_TOKEN      # 아무 긴 문자열 (수동 갱신·점검용 비밀번호)
```
> Encoding 키를 넣어도 코드가 알아서 구분합니다. `%`가 들어 있으면 Encoding 키로 봅니다.

### 4. 배포
```bash
npm run deploy
```
끝나면 `https://gakkaun-jeonsi.<계정이름>.workers.dev` 주소가 나옵니다. 휴대폰에서 열어도 됩니다.

### 5. 첫 데이터 받기와 점검 (중요)
배포 직후 KV가 비어 있으니 한 번 수동으로 채웁니다.
```
https://<주소>/api/refresh?token=<ADMIN_TOKEN>
```
응답의 `stats`로 상태를 확인합니다.

| 항목 | 정상이면 |
|---|---|
| `cultureExhibitions` | 0보다 큼 |
| `seoulExhibitions` | 0보다 큼 |
| `cultureError` / `seoulError` | 없음 |
| `venues` | 수십~수백 곳 |

**숫자가 0이거나 에러가 있으면** 원본 응답을 그대로 보고 고칩니다 (키 값은 *** 로 가려짐).
```
https://<주소>/api/debug?src=culture&token=<ADMIN_TOKEN>
https://<주소>/api/debug?src=seoul&token=<ADMIN_TOKEN>
```
이 두 응답을 Claude에게 붙여 주면 필드 이름에 맞춰 파서를 바로 맞춰 드립니다.
(문화포털 신규 API의 응답 필드 이름은 공개 문서로 끝까지 확인하지 못해서, 흔히 쓰이는
`title / startDate / endDate / place / realmName / thumbnail / gpsX / gpsY` 기준으로 읽고
`item`·`perforList` 두 형식을 모두 받도록 해 두었습니다.)

자주 나오는 에러:
- `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`: 키 활성화 대기 중 (승인 후 1~2시간) 또는 Encoding/Decoding 키 혼동
- `서울 API: INFO-100`: 서울 인증키 오류
- 서울 쪽만 연결 실패: 8088 포트 문제일 수 있으니 `npx wrangler tail`로 로그 확인

### 6. 그다음부터는 자동
6시간마다 크론이 두 API를 다시 받아 KV를 갱신합니다. 사용자의 요청은 KV만 읽으므로 빠르고,
공공데이터포털 하루 호출 한도(개발계정 10,000건)에도 여유가 큽니다.

---

## 로컬에서 먼저 돌려 보기 (선택)
```bash
cp .dev.vars.example .dev.vars    # 값 채우기
npx wrangler kv namespace create CACHE --preview   # 출력된 preview_id를 wrangler.toml kv 항목에 preview_id = "..." 로 추가
npm run dev                        # http://localhost:8787
```
그다음 `http://localhost:8787/api/refresh?token=...` 로 첫 데이터를 받습니다.

---

## API 엔드포인트 (나중에 앱에서도 그대로 사용)

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| POST | `/api/feed` | `{lat,lng,page,only?,exclude?}` → 가까운 공간 10곳과 각 공간의 열린 전시 전부 |
| POST | `/api/venues` | `{ids,lat,lng}` → 지정한 공간들의 전시 (하트 탭) |
| GET | `/api/search?q=&lat=&lng=` | 공간 이름·지역 검색 (설정 › 공간 추가) |
| GET | `/api/status` | 마지막 갱신 시각, 공간·전시 수 |
| GET | `/api/refresh?token=` | 지금 바로 다시 받기 |
| GET | `/api/debug?src=culture|seoul&token=` | 원본 응답 일부 (키 가림) |

CORS를 열어 두었으니, 앱으로 옮길 때는 `public/index.html`의 `const API = ''`에 Worker 주소만 넣으면 됩니다.

## 알아둘 점
- **무료 플랜 CPU 제한(요청당 10ms)**: 데이터 정리는 크론에서만 하고 요청은 KV만 읽도록 만들어 두었습니다. 그래도 갱신 때 `Error 1102`(CPU 초과)가 보이면 Workers 유료 플랜($5/월)으로 올리거나 수집 범위를 줄이면 됩니다.
- **수집 범위**: 서울과 인접 지역(위도 37.25–37.75, 경도 126.70–127.30). `src/index.js`의 `BOX`에서 바꿉니다.
- **상업 갤러리 누락**: 공공 API는 기관이 등록한 정보라 일부 사설 갤러리는 없습니다.
- **출처 표시**: 공공누리 제1유형 조건에 따라 설정 탭 하단에 출처를 표시해 두었습니다.
- **개인 데이터**: 하트·MY·공간 목록은 각 사용자의 브라우저에 저장됩니다. 기기 간 동기화는 앱 단계에서 붙이면 됩니다.
