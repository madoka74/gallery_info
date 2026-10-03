// 직접 수집할 전시공간 목록.
// url: 전시 목록 페이지 (틀리거나 바뀌면 home에서 '전시' 링크를 찾아 자동으로 다시 잡음)
// branch: 여러 도시·지점 전시가 한 페이지에 섞인 사이트에서 이 공간만 고르게 하는 힌트
// render: true면 자바스크립트로 그려지는 페이지라 헤드리스 브라우저로 읽음 (CF_ACCOUNT_ID, CF_API_TOKEN 필요)
// aliases: 공공 API에서 이 공간을 부르는 다른 이름 (같은 공간으로 합치는 데 씀)
// 좌표는 지도 기준 근사값이라 수십~수백 m 차이가 있을 수 있음. 틀린 곳은 고쳐 주세요.
// 공공 API에 이미 있는 공간도 넣어 두면 같은 전시는 하나로 합쳐지고, 포스터·작가 정보가 보강됨.

export const SOURCES = [
  // ---- 미술관 ----
  { id: 'leeum', name: '리움미술관', addr: '용산구 이태원로55길 60-16', lat: 37.5383, lng: 126.9990, home: 'https://www.leeumhoam.org', url: 'https://www.leeumhoam.org/leeum/exhibition', render: true, aliases: ['삼성미술관 리움','삼성미술관 Leeum','리움','Leeum'] },
  { id: 'hoam', name: '호암미술관', addr: '경기 용인시 처인구 포곡읍 에버랜드로562번길 38', lat: 37.2936, lng: 127.2003, home: 'https://www.leeumhoam.org', url: 'https://www.leeumhoam.org/hoam/exhibition', render: true, aliases: ['삼성 호암미술관','Hoam Museum of Art','호암'] },
  // 뮤지엄 산: 홈페이지가 자바스크립트 앱이라 렌더링 필수
  { id: 'museumsan', name: '뮤지엄 산', addr: '강원 원주시 지정면 오크밸리2길 260', lat: 37.4157, lng: 127.8228, home: 'https://www.museumsan.org', url: 'https://www.museumsan.org/art-museum?tab=exhibition-intro', render: true, aliases: ['뮤지엄산','Museum SAN','뮤지엄SAN','한솔뮤지엄'] },
  // 예술의전당: 미술관·박물관 일정 페이지 하나에 세 관 전시가 함께 나옴 → 관별로 나눠 수집
  { id: 'sac-hangaram', name: '예술의전당 한가람미술관', addr: '서초구 남부순환로 2406', lat: 37.4790, lng: 127.0118, home: 'https://www.sac.or.kr', url: 'https://www.sac.or.kr/site/main/program/schedule?tab=3', render: true, branch: '한가람미술관 (1~7전시실). 한가람디자인미술관·서울서예박물관 전시는 제외', aliases: ['한가람미술관','예술의전당 한가람미술관 제7전시실','Hangaram Art Museum'] },
  { id: 'sac-design', name: '예술의전당 한가람디자인미술관', addr: '서초구 남부순환로 2406', lat: 37.4784, lng: 127.0124, home: 'https://www.sac.or.kr', url: 'https://www.sac.or.kr/site/main/program/schedule?tab=3', render: true, branch: '한가람디자인미술관만', aliases: ['한가람디자인미술관','Hangaram Design Museum'] },
  { id: 'sac-calligraphy', name: '예술의전당 서울서예박물관', addr: '서초구 남부순환로 2406', lat: 37.4795, lng: 127.0128, home: 'https://www.sac.or.kr', url: 'https://www.sac.or.kr/site/main/program/schedule?tab=3', render: true, branch: '서울서예박물관(서예박물관)만', aliases: ['서울서예박물관','예술의전당 서예박물관','서예박물관'] },
  { id: 'mmca-seoul', name: '국립현대미술관 서울', addr: '종로구 삼청로 30', lat: 37.5788, lng: 126.9800, home: 'https://www.mmca.go.kr', url: 'https://www.mmca.go.kr/exhibitions/progressList.do', branch: '서울관 (덕수궁·과천·청주 제외)', render: true, aliases: ['국립현대미술관','국립현대미술관 서울관','MMCA 서울'] },
  { id: 'mmca-deoksu', name: '국립현대미술관 덕수궁', addr: '중구 세종대로 99', lat: 37.5659, lng: 126.9751, home: 'https://www.mmca.go.kr', url: 'https://www.mmca.go.kr/exhibitions/progressList.do', branch: '덕수궁관만', render: true, aliases: ['국립현대미술관 덕수궁관','MMCA 덕수궁'] },
  { id: 'sema', name: '서울시립미술관 서소문본관', addr: '중구 덕수궁길 61', lat: 37.5640, lng: 126.9737, home: 'https://sema.seoul.go.kr', url: 'https://sema.seoul.go.kr/kr/whatson/exhibition/list', branch: '서소문본관만', aliases: ['서울시립미술관','서울시립미술관 본관','서소문본관','SeMA'] },
  { id: 'apma', name: '아모레퍼시픽미술관', addr: '용산구 한강대로 100', lat: 37.5292, lng: 126.9683, home: 'https://apma.amorepacific.com', url: 'https://apma.amorepacific.com/contents/exhibition/index.do', aliases: ['아모레퍼시픽 미술관','APMA'] },
  { id: 'daelim', name: '대림미술관', addr: '종로구 자하문로4길 21', lat: 37.5769, lng: 126.9734, home: 'https://www.daelimmuseum.org', url: 'https://www.daelimmuseum.org', branch: '대림미술관만 (디뮤지엄 제외)' },
  { id: 'dmuseum', name: '디뮤지엄', addr: '성동구 왕십리로 83-21', lat: 37.5446, lng: 127.0436, home: 'https://www.daelimmuseum.org', url: 'https://www.daelimmuseum.org', branch: '디뮤지엄만 (대림미술관 제외)' },
  { id: 'artsonje', name: '아트선재센터', addr: '종로구 율곡로3길 87', lat: 37.5795, lng: 126.9813, home: 'https://artsonje.org', url: 'https://artsonje.org/exhibition/', aliases: ['아트선재','Art Sonje Center'] },
  { id: 'kumho', name: '금호미술관', addr: '종로구 삼청로 18', lat: 37.5768, lng: 126.9812, home: 'http://www.kumhomuseum.com', url: 'http://www.kumhomuseum.com', aliases: ['금호 미술관'] },
  { id: 'ilmin', name: '일민미술관', addr: '종로구 세종대로 152', lat: 37.5703, lng: 126.9771, home: 'https://ilmin.org', url: 'https://ilmin.org', aliases: ['일민미술관 ILMIN'] },
  { id: 'sungkok', name: '성곡미술관', addr: '종로구 경희궁1가길 42', lat: 37.5713, lng: 126.9688, home: 'http://www.sungkokmuseum.org', url: 'http://www.sungkokmuseum.org' },
  { id: 'songeun', name: '송은', addr: '강남구 도산대로 441', lat: 37.5245, lng: 127.0461, home: 'https://songeun.or.kr', url: 'https://songeun.or.kr' },
  { id: 'platforml', name: '플랫폼엘', addr: '강남구 언주로133길 11', lat: 37.5163, lng: 127.0352, home: 'https://www.platform-l.org', url: 'https://www.platform-l.org/exhibition/list?category=1' },
  { id: 'spacec', name: '코리아나미술관 스페이스씨', addr: '강남구 언주로 827', lat: 37.5236, lng: 127.0326, home: 'http://www.spacec.co.kr', url: 'http://www.spacec.co.kr', aliases: ['스페이스씨','코리아나미술관','스페이스 씨'] },
  { id: 'posco', name: '포스코미술관', addr: '강남구 테헤란로 440', lat: 37.5059, lng: 127.0557, home: 'https://www.poscoartmuseum.org', url: 'https://www.poscoartmuseum.org', aliases: ['포스코 미술관','POSCO Art Museum'] },
  { id: 'lotte', name: '롯데뮤지엄', addr: '송파구 올림픽로 300 롯데월드타워 7층', lat: 37.5126, lng: 127.1025, home: 'https://www.lottemuseum.com', url: 'https://www.lottemuseum.com', aliases: ['롯데뮤지엄 LOTTE MUSEUM OF ART','롯데월드타워 롯데뮤지엄'] },
  { id: 'mamuone', name: '마이아트뮤지엄 원그로브', addr: '강서구 공항대로 165 원그로브 C동 2층', lat: 37.5606, lng: 126.8310, home: 'https://www.mamuone.com', url: 'https://www.mamuone.com/7', aliases: ['마이아트뮤지엄','마이아트 뮤지엄'] },
  { id: 'horim', name: '호림박물관 신사분관', addr: '강남구 도산대로 317', lat: 37.5223, lng: 127.0365, home: 'http://www.horimmuseum.org', url: 'http://www.horimmuseum.org', branch: '신사분관' },
  { id: 'kmca', name: 'K현대미술관', addr: '강남구 선릉로 807', lat: 37.5256, lng: 127.0400, home: 'http://www.kmcaseoul.org', url: 'https://www.kmcaseoul.org/exhibition', aliases: ['KMCA'] },
  // 그라운드시소: 한 목록(Now)에 지점 전시가 섞여 있음 → 지점별로 나눠 읽음. 성수는 현재 운영 흔적이 없어 뺌
  { id: 'gs-central', name: '그라운드시소 센트럴', geo: '그라운드시소 센트럴', home: 'https://groundseesaw.co.kr', url: 'https://groundseesaw.co.kr/product/list.html?cate_no=47', branch: '센트럴 지점만', aliases: ['그라운드시소센트럴'] },
  { id: 'gs-east', name: '그라운드시소 이스트', addr: '서울 광진구 아차산로 402', home: 'https://groundseesaw.co.kr', url: 'https://groundseesaw.co.kr/product/list.html?cate_no=47', branch: '이스트 지점만', aliases: ['그라운드시소이스트'] },
  { id: 'gs-hannam', name: '그라운드시소 한남', geo: '그라운드시소 한남', home: 'https://groundseesaw.co.kr', url: 'https://groundseesaw.co.kr/product/list.html?cate_no=47', branch: '한남 지점만', aliases: ['그라운드시소한남'] },
  { id: 'piknic', name: '피크닉', addr: '중구 퇴계로6가길 30', lat: 37.5555, lng: 126.9790, home: 'https://piknic.kr', url: 'https://piknic.kr', aliases: ['piknic'] },
  { id: 'spacek', name: '스페이스K 서울', addr: '강서구 마곡중앙8로 32', lat: 37.5613, lng: 126.8270, home: 'https://spacek.co.kr', url: 'https://spacek.co.kr', branch: '서울' },

  // ---- 갤러리: 삼청·종로 ----
  { id: 'kukje', name: '국제갤러리', addr: '종로구 삼청로 54', lat: 37.5806, lng: 126.9806, home: 'https://www.kukjegallery.com', url: 'https://www.kukjegallery.com/exhibitions', branch: '서울 (부산 제외)', aliases: ['Kukje Gallery','국제갤러리 서울'] },
  { id: 'hyundai', name: '갤러리현대', addr: '종로구 삼청로 14', lat: 37.5800, lng: 126.9810, home: 'https://www.galleryhyundai.com', url: 'https://www.galleryhyundai.com/exhibition', aliases: ['갤러리 현대','Gallery Hyundai'] },
  { id: 'hakgojae', name: '학고재', addr: '종로구 삼청로 50', lat: 37.5797, lng: 126.9815, home: 'http://www.hakgojae.com', url: 'http://www.hakgojae.com/page/1-1.php', aliases: ['학고재갤러리','학고재 갤러리','Hakgojae Gallery'] },
  { id: 'arario', name: '아라리오갤러리 서울', addr: '종로구 율곡로 83', lat: 37.5793, lng: 126.9853, home: 'https://www.arariogallery.com', url: 'https://www.arariogallery.com', branch: '서울 (천안·상하이 제외)', aliases: ['아라리오갤러리','ARARIO GALLERY'] },
  { id: 'pkm', name: 'PKM 갤러리', addr: '종로구 삼청로7길 40', lat: 37.5823, lng: 126.9819, home: 'https://www.pkmgallery.com', url: 'https://www.pkmgallery.com', aliases: ['PKM갤러리','PKM Gallery'] },
  { id: 'leeahn', name: '리안갤러리 서울', addr: '종로구 창성동', lat: 37.5795, lng: 126.9757, home: 'http://www.leeahngallery.com', url: 'http://www.leeahngallery.com', branch: '서울 (대구 제외)' },
  { id: 'sun', name: '선화랑', addr: '종로구 인사동5길 8', lat: 37.5729, lng: 126.9852, home: 'http://www.sungallery.co.kr', url: 'http://www.sungallery.co.kr' },
  { id: 'gana', name: '가나아트센터', addr: '종로구 평창30길 28', lat: 37.6046, lng: 126.9587, home: 'https://www.ganaart.com', url: 'https://www.ganaart.com/exhibition/', render: true, branch: '평창동 가나아트센터' },

  // ---- 갤러리: 한남·이태원 ----
  { id: 'ropac', name: '타데우스 로팍 서울', addr: '용산구 한남대로 122', lat: 37.5355, lng: 127.0060, home: 'https://ropac.net', url: 'https://ropac.net/exhibitions/', branch: 'Seoul', aliases: ['Thaddaeus Ropac'] },
  { id: 'pace', name: '페이스 서울', addr: '용산구 이태원로 267', lat: 37.5347, lng: 127.0006, home: 'https://www.pacegallery.com', url: 'https://www.pacegallery.com/exhibitions/', branch: 'Seoul', aliases: ['Pace Gallery','페이스갤러리'] },
  { id: 'lehmann', name: '리만머핀 서울', addr: '용산구 이태원로 213', lat: 37.5367, lng: 126.9960, home: 'https://www.lehmannmaupin.com', url: 'https://www.lehmannmaupin.com/exhibitions', branch: 'Seoul' },
  { id: 'baton', name: '갤러리바톤', addr: '용산구 독서당로 116', lat: 37.5369, lng: 127.0070, home: 'https://www.gallerybaton.com', url: 'https://www.gallerybaton.com' },
  { id: 'johyun', name: '조현화랑 서울', addr: '용산구 한남동', lat: 37.5340, lng: 127.0050, home: 'https://johyungallery.com', url: 'https://johyungallery.com', branch: '서울 (부산 제외)' },

  // ---- 갤러리: 청담·신사·성수 ----
  { id: 'perrotin', name: '페로탕 서울', addr: '강남구 도산대로45길 10', lat: 37.5241, lng: 127.0379, home: 'https://www.perrotin.com', url: 'https://www.perrotin.com/exhibitions/current/seoul/5', branch: 'Seoul', aliases: ['Perrotin','페로탕'] },
  { id: 'whitecube', name: '화이트큐브 서울', addr: '강남구 도산대로45길 6', lat: 37.5243, lng: 127.0386, home: 'https://www.whitecube.com', url: 'https://www.whitecube.com/exhibitions/seoul', aliases: ['White Cube','화이트큐브'] },
  { id: 'gladstone', name: '글래드스톤 서울', addr: '서울 용산구 한남동 739-28', home: 'https://gladstonegallery.com', url: 'https://gladstonegallery.com/exhibitions/', branch: 'Seoul', render: true, aliases: ['Gladstone Seoul','글래드스톤'] },
  { id: 'tang', name: '탕 컨템포러리 아트 서울', addr: '강남구 청담동', lat: 37.5248, lng: 127.0440, home: 'https://www.tangcontemporary.com', url: 'https://www.tangcontemporary.com', branch: 'Seoul' },
  { id: 'yehwa', name: '예화랑', addr: '강남구 신사동', lat: 37.5245, lng: 127.0400, home: 'https://www.galleryyeh.com', url: 'https://www.galleryyeh.com/exhibition' },
  { id: 'thepage', name: '더페이지갤러리', addr: '성동구 성수동', lat: 37.5446, lng: 127.0560, home: 'https://thepagegallery.com', url: 'https://thepagegallery.com' },

  /* ---------- 서울·수도권 밖 (좌표는 주소로 자동 계산) ---------- */
  // 국립현대미술관 다른 관: 서울관과 같은 목록 페이지
  { id: 'mmca-gwacheon', name: '국립현대미술관 과천', addr: '경기 과천시 광명로 313', home: 'https://www.mmca.go.kr', url: 'https://www.mmca.go.kr/exhibitions/progressList.do', branch: '과천관만', render: true, aliases: ['국립현대미술관 과천관','MMCA 과천'] },
  { id: 'mmca-cheongju', name: '국립현대미술관 청주', addr: '충북 청주시 청원구 상당로 314', home: 'https://www.mmca.go.kr', url: 'https://www.mmca.go.kr/exhibitions/progressList.do', branch: '청주관(국립현대미술관 청주)만', render: true, aliases: ['국립현대미술관 청주관','MMCA 청주','국립청주미술관'] },
  // 부산
  { id: 'busan-art', name: '부산시립미술관', addr: '부산 해운대구 APEC로 58', home: 'https://art.busan.go.kr', url: 'https://art.busan.go.kr/tblTsite07Display/listNowClient.nm', aliases: ['부산시립미술관 본관','Busan Museum of Art','이우환공간'] },
  { id: 'busan-moca', name: '부산현대미술관', addr: '부산 사하구 낙동남로 1191', home: 'https://www.busan.go.kr/moca', url: 'https://www.busan.go.kr/moca/exhibition01', aliases: ['MoCA Busan','부산 현대미술관'] },
  { id: 'goeun', name: '고은사진미술관', addr: '부산 해운대구 해운대로452번길 16', home: 'https://www.goeunmuseum.kr', url: 'https://www.goeunmuseum.kr/bbs/page.php?hid=menu02_1', aliases: ['GoEun Museum of Photography'] },
  { id: 'f1963', name: 'F1963', addr: '부산 수영구 구락로123번길 20', home: 'https://f1963.org', url: 'https://f1963.org', aliases: ['에프1963','F1963 석천홀'] },
  { id: 'kukje-busan', name: '국제갤러리 부산', addr: '부산 수영구 구락로123번길 20', home: 'https://www.kukjegallery.com', url: 'https://www.kukjegallery.com/exhibitions', branch: '부산만', aliases: ['Kukje Gallery Busan'] },
  { id: 'johyun-busan', name: '조현화랑 부산', addr: '부산 해운대구 달맞이길 117번길 9', home: 'https://johyungallery.com', url: 'https://johyungallery.com', branch: '부산 (서울 제외)', aliases: ['Johyun Gallery Busan'] },
  { id: 'museum1', name: '뮤지엄원', addr: '부산 해운대구 센텀서로 20', home: 'http://museum1.co.kr', url: 'http://museum1.co.kr', render: true, aliases: ['Museum 1','뮤지엄 원'] },
  // 대구·경북
  { id: 'daegu-art', name: '대구미술관', addr: '대구 수성구 미술관로 40', home: 'https://www.daeguartmuseum.or.kr', url: 'https://www.daeguartmuseum.or.kr/index.do?menu_id=00000729', aliases: ['Daegu Art Museum'] },
  { id: 'kansong-daegu', name: '대구간송미술관', addr: '대구 수성구 미술관로 70', home: 'https://kansong.org/daegu/', url: 'https://kansong.org/daegu/', aliases: ['간송미술관 대구'] },
  { id: 'leeahn-daegu', name: '리안갤러리 대구', addr: '대구 중구 달구벌대로 2077', home: 'http://www.leeahngallery.com', url: 'http://www.leeahngallery.com', branch: '대구 (서울 제외)', aliases: ['Leeahn Gallery Daegu'] },
  { id: 'wooyang', name: '우양미술관', addr: '경북 경주시 보문로 484-7', home: 'https://www.wooyangmuseum.org', url: 'https://www.wooyangmuseum.org/current', aliases: ['Wooyang Museum','아트선재미술관 경주'] },
  { id: 'solgeo', name: '경주솔거미술관', addr: '경북 경주시 경감로 614', home: 'https://www.gjsam.or.kr/ko/', url: 'https://www.gjsam.or.kr/ko/page.aspx?mnu_uid=78&', aliases: ['솔거미술관'] },
  { id: 'poma', name: '포항시립미술관', addr: '경북 포항시 북구 환호공원길 10', home: 'https://poma.pohang.go.kr/poma/', url: 'https://poma.pohang.go.kr/poma/bbs/board.php?bo_table=exhibition&ketime=current', aliases: ['POMA','포항시립미술관 POMA'] },
  // 울산·경남
  { id: 'ulsan-art', name: '울산시립미술관', addr: '울산 중구 미술관길 72', home: 'https://www.ulsan.go.kr/s/uam/main.ulsan', url: 'https://www.ulsan.go.kr/s/uam/bbs/list.ulsan?bbsId=BBS_0000000000000174&mId=001003001000000000', aliases: ['Ulsan Art Museum'] },
  { id: 'gam', name: '경남도립미술관', addr: '경남 창원시 의창구 용지로 296', home: 'https://www.gyeongnam.go.kr/gam/index.gyeong', url: 'https://www.gyeongnam.go.kr/gam/index.gyeong?menuCd=DOM_000003401001000000', aliases: ['Gyeongnam Art Museum'] },
  { id: 'moonshin', name: '창원시립마산문신미술관', addr: '경남 창원시 마산합포구 문신길 147', home: 'https://www.changwon.go.kr/moonshin/', url: 'https://www.changwon.go.kr/moonshin/', aliases: ['문신미술관','마산문신미술관'] },
  // 광주·전라 (광주·전남 통합으로 주소·도메인이 바뀌는 중)
  { id: 'gwangju-art', name: '광주시립미술관', addr: '광주 북구 하서로 52', home: 'https://artmuse.gwangju.go.kr', url: 'https://artmuse.gwangju.go.kr', aliases: ['광주시립미술관 본관','Gwangju Museum of Art'] },
  { id: 'acc', name: '국립아시아문화전당', addr: '광주 동구 문화전당로 38', home: 'https://www.acc.go.kr', url: 'https://www.acc.go.kr', aliases: ['ACC','아시아문화전당'] },
  { id: 'jma-jeonnam', name: '전남도립미술관', addr: '전남 광양시 광양읍 순광로 660', home: 'https://jma.jeonnam-gwangju.go.kr/www', url: 'https://jma.jeonnam-gwangju.go.kr/www/9', aliases: ['Jeonnam Museum of Art'] },
  { id: 'jma-jeonbuk', name: '전북도립미술관', addr: '전북 완주군 구이면 모악산길 111-6', home: 'https://www.jma.go.kr', url: 'https://www.jma.go.kr/web/page.php?pcode=AA01&s_ecate=all', branch: '본관·대아스페이스 (서울관 제외)', aliases: ['Jeonbuk Museum of Art'] },
  // 대전·충청
  { id: 'dma', name: '대전시립미술관', addr: '대전 서구 둔산대로 155', home: 'https://www.daejeon.go.kr/dma/index.do', url: 'https://www.daejeon.go.kr/dma/index.do', aliases: ['Daejeon Museum of Art'] },
  { id: 'leeungno', name: '이응노미술관', addr: '대전 서구 둔산대로 157', home: 'https://www.leeungnomuseum.or.kr', url: 'https://www.leeungnomuseum.or.kr/bbs/bbsList.do?bbsId=exhibit', aliases: ['Lee Ungno Museum'] },
  { id: 'cmoa', name: '청주시립미술관', addr: '충북 청주시 서원구 충렬로18번길 50', home: 'https://cmoa.cheongju.go.kr', url: 'https://cmoa.cheongju.go.kr', branch: '본관', aliases: ['Cheongju Museum of Art'] },
  { id: 'arario-cheonan', name: '아라리오갤러리 천안', addr: '충남 천안시 동남구 만남로 43', home: 'https://www.arariogallery.com', url: 'https://www.arariogallery.com', branch: '천안만', aliases: ['Arario Gallery Cheonan'] },
  // 강원
  { id: 'solol', name: '강릉시립미술관 솔올', addr: '강원 강릉시 원대로 45', home: 'https://www.gn.go.kr/mu/', url: 'https://www.gn.go.kr/mu/', aliases: ['솔올미술관','강릉 솔올미술관'] },
  { id: 'parksookeun', name: '박수근미술관', addr: '강원 양구군 양구읍 박수근로 265-15', home: 'http://www.parksookeun.or.kr', url: 'http://www.parksookeun.or.kr', aliases: ['양구 박수근미술관'] },
  // 제주
  { id: 'jmoa', name: '제주도립미술관', addr: '제주 제주시 1100로 2894-78', home: 'https://www.jeju.go.kr/jmoa/index.htm', url: 'https://www.jeju.go.kr/jmoa/index.htm', aliases: ['Jeju Museum of Art'] },
  { id: 'kimtschang', name: '제주도립 김창열미술관', addr: '제주 제주시 한림읍 용금로 883-5', home: 'https://kimtschang-yeul.jeju.go.kr', url: 'https://kimtschang-yeul.jeju.go.kr', aliases: ['김창열미술관'] },
  { id: 'podo', name: '포도뮤지엄', addr: '제주 서귀포시 안덕면 산록남로 788', home: 'https://www.podomuseum.com', url: 'https://www.podomuseum.com', render: true, aliases: ['PODO Museum'] },
  { id: 'bonte', name: '본태박물관', addr: '제주 서귀포시 안덕면 산록남로762번길 69', home: 'http://www.bontemuseum.com', url: 'http://www.bontemuseum.com', aliases: ['Bonte Museum'] },
  { id: 'arario-jeju', name: '아라리오뮤지엄 탑동시네마', addr: '제주 제주시 탑동로 14', home: 'https://www.arariomuseum.org', url: 'https://www.arariomuseum.org', aliases: ['아라리오뮤지엄 제주','아라리오뮤지엄 동문모텔'] }
];
