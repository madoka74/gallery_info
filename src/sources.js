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
  { id: 'platforml', name: '플랫폼엘', addr: '강남구 언주로133길 11', lat: 37.5163, lng: 127.0352, home: 'https://www.platform-l.org', url: 'https://www.platform-l.org' },
  { id: 'spacec', name: '코리아나미술관 스페이스씨', addr: '강남구 언주로 827', lat: 37.5236, lng: 127.0326, home: 'http://www.spacec.co.kr', url: 'http://www.spacec.co.kr', aliases: ['스페이스씨','코리아나미술관','스페이스 씨'] },
  { id: 'posco', name: '포스코미술관', addr: '강남구 테헤란로 440', lat: 37.5059, lng: 127.0557, home: 'https://www.poscoartmuseum.org', url: 'https://www.poscoartmuseum.org', aliases: ['포스코 미술관','POSCO Art Museum'] },
  { id: 'lotte', name: '롯데뮤지엄', addr: '송파구 올림픽로 300 롯데월드타워 7층', lat: 37.5126, lng: 127.1025, home: 'https://www.lottemuseum.com', url: 'https://www.lottemuseum.com', aliases: ['롯데뮤지엄 LOTTE MUSEUM OF ART','롯데월드타워 롯데뮤지엄'] },
  { id: 'mamuone', name: '마이아트뮤지엄 원그로브', addr: '강서구 공항대로 165 원그로브 C동 2층', lat: 37.5606, lng: 126.8310, home: 'https://www.mamuone.com', url: 'https://www.mamuone.com/7', aliases: ['마이아트뮤지엄','마이아트 뮤지엄'] },
  { id: 'horim', name: '호림박물관 신사분관', addr: '강남구 도산대로 317', lat: 37.5223, lng: 127.0365, home: 'http://www.horimmuseum.org', url: 'http://www.horimmuseum.org', branch: '신사분관' },
  { id: 'kmca', name: 'K현대미술관', addr: '강남구 선릉로 807', lat: 37.5256, lng: 127.0400, home: 'http://www.kmcaseoul.org', url: 'http://www.kmcaseoul.org', aliases: ['KMCA'] },
  { id: 'groundseesaw', name: '그라운드시소 성수', addr: '성동구 아차산로 19', lat: 37.5440, lng: 127.0560, home: 'https://groundseesaw.co.kr', url: 'https://groundseesaw.co.kr', branch: '성수점', aliases: ['그라운드시소'] },
  { id: 'piknic', name: '피크닉', addr: '중구 퇴계로6가길 30', lat: 37.5555, lng: 126.9790, home: 'https://piknic.kr', url: 'https://piknic.kr', aliases: ['piknic'] },
  { id: 'spacek', name: '스페이스K 서울', addr: '강서구 마곡중앙8로 32', lat: 37.5613, lng: 126.8270, home: 'https://spacek.co.kr', url: 'https://spacek.co.kr', branch: '서울' },

  // ---- 갤러리: 삼청·종로 ----
  { id: 'kukje', name: '국제갤러리', addr: '종로구 삼청로 54', lat: 37.5806, lng: 126.9806, home: 'https://www.kukjegallery.com', url: 'https://www.kukjegallery.com/exhibitions', branch: '서울 (부산 제외)', aliases: ['Kukje Gallery','국제갤러리 서울'] },
  { id: 'hyundai', name: '갤러리현대', addr: '종로구 삼청로 14', lat: 37.5800, lng: 126.9810, home: 'https://www.galleryhyundai.com', url: 'https://www.galleryhyundai.com/exhibition', aliases: ['갤러리 현대','Gallery Hyundai'] },
  { id: 'hakgojae', name: '학고재', addr: '종로구 삼청로 50', lat: 37.5797, lng: 126.9815, home: 'https://www.hakgojae.com', url: 'https://www.hakgojae.com' },
  { id: 'arario', name: '아라리오갤러리 서울', addr: '종로구 율곡로 83', lat: 37.5793, lng: 126.9853, home: 'https://www.arariogallery.com', url: 'https://www.arariogallery.com', branch: '서울 (천안·상하이 제외)', aliases: ['아라리오갤러리','ARARIO GALLERY'] },
  { id: 'pkm', name: 'PKM 갤러리', addr: '종로구 삼청로7길 40', lat: 37.5823, lng: 126.9819, home: 'https://www.pkmgallery.com', url: 'https://www.pkmgallery.com', aliases: ['PKM갤러리','PKM Gallery'] },
  { id: 'leeahn', name: '리안갤러리 서울', addr: '종로구 창성동', lat: 37.5795, lng: 126.9757, home: 'http://www.leeahngallery.com', url: 'http://www.leeahngallery.com', branch: '서울 (대구 제외)' },
  { id: 'sun', name: '선화랑', addr: '종로구 인사동5길 8', lat: 37.5729, lng: 126.9852, home: 'http://www.sungallery.co.kr', url: 'http://www.sungallery.co.kr' },
  { id: 'gana', name: '가나아트센터', addr: '종로구 평창30길 28', lat: 37.6046, lng: 126.9587, home: 'http://www.ganaart.com', url: 'http://www.ganaart.com', branch: '평창동 가나아트센터' },

  // ---- 갤러리: 한남·이태원 ----
  { id: 'ropac', name: '타데우스 로팍 서울', addr: '용산구 한남대로 122', lat: 37.5355, lng: 127.0060, home: 'https://ropac.net', url: 'https://ropac.net/exhibitions/', branch: 'Seoul', aliases: ['Thaddaeus Ropac'] },
  { id: 'pace', name: '페이스 서울', addr: '용산구 이태원로 267', lat: 37.5347, lng: 127.0006, home: 'https://www.pacegallery.com', url: 'https://www.pacegallery.com/exhibitions/', branch: 'Seoul', aliases: ['Pace Gallery','페이스갤러리'] },
  { id: 'lehmann', name: '리만머핀 서울', addr: '용산구 이태원로 213', lat: 37.5367, lng: 126.9960, home: 'https://www.lehmannmaupin.com', url: 'https://www.lehmannmaupin.com/exhibitions', branch: 'Seoul' },
  { id: 'baton', name: '갤러리바톤', addr: '용산구 독서당로 116', lat: 37.5369, lng: 127.0070, home: 'https://www.gallerybaton.com', url: 'https://www.gallerybaton.com' },
  { id: 'johyun', name: '조현화랑 서울', addr: '용산구 한남동', lat: 37.5340, lng: 127.0050, home: 'https://johyungallery.com', url: 'https://johyungallery.com', branch: '서울 (부산 제외)' },
  { id: 'oneandj', name: '원앤제이갤러리', addr: '용산구 한남동', lat: 37.5385, lng: 126.9988, home: 'https://www.oneandj.com', url: 'https://www.oneandj.com' },
  { id: 'parkryusook', name: '박여숙화랑', addr: '용산구 이태원동', lat: 37.5410, lng: 127.0005, home: 'https://www.parkryusookgallery.com', url: 'https://www.parkryusookgallery.com' },

  // ---- 갤러리: 청담·신사·성수 ----
  { id: 'perrotin', name: '페로탕 서울', addr: '강남구 도산대로45길 10', lat: 37.5241, lng: 127.0379, home: 'https://www.perrotin.com', url: 'https://www.perrotin.com/exhibitions', branch: 'Seoul', aliases: ['Perrotin','페로탕'] },
  { id: 'whitecube', name: '화이트큐브 서울', addr: '강남구 도산대로45길 6', lat: 37.5243, lng: 127.0386, home: 'https://www.whitecube.com', url: 'https://www.whitecube.com/gallery-exhibitions', branch: 'Seoul', aliases: ['White Cube','화이트큐브'] },
  { id: 'koenig', name: '쾨닉 서울', addr: '강남구 압구정로 412', lat: 37.5253, lng: 127.0451, home: 'https://www.koeniggalerie.com', url: 'https://www.koeniggalerie.com', branch: 'Seoul' },
  { id: 'gladstone', name: '글래드스톤 서울', addr: '강남구 청담동', lat: 37.5249, lng: 127.0495, home: 'https://www.gladstonegallery.com', url: 'https://www.gladstonegallery.com/exhibitions', branch: 'Seoul' },
  { id: 'tang', name: '탕 컨템포러리 아트 서울', addr: '강남구 청담동', lat: 37.5248, lng: 127.0440, home: 'https://www.tangcontemporary.com', url: 'https://www.tangcontemporary.com', branch: 'Seoul' },
  { id: 'yehwa', name: '예화랑', addr: '강남구 신사동', lat: 37.5245, lng: 127.0400, home: 'https://www.galleryyeh.com', url: 'https://www.galleryyeh.com' },
  { id: 'thepage', name: '더페이지갤러리', addr: '성동구 성수동', lat: 37.5446, lng: 127.0560, home: 'https://thepagegallery.com', url: 'https://thepagegallery.com' }
];
