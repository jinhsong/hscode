/**
 * HS Code 유권해석(Ruling) 주간 모니터링 시스템
 * ─────────────────────────────────────────────
 * [변경 이력]
 * v4.0 (HS 한정 · 최대 수집 · 원문 영구 확인)
 *  - [핵심] 공식 API 직접 수집(하이브리드) 도입:
 *      · 美 CBP CROSS 분류 결정 JSON API(rulings.cbp.gov/api/search) — 검색어별 최신순 전수 수집,
 *        원문은 rulings.cbp.gov/ruling/{번호} 영구 canonical URL (모델 요약 의존 탈피)
 *      · 美 Federal Register API(무인증) — CBP 분류 고시/결정 영구 html_url 수집
 *      · API 없는 국가는 기존 Gemini google_search 그라운딩으로 보완
 *      · 미국 Gemini 패스는 CROSS 外(CIT/CAFC 판결·통상 분쟁·언론)로 재조정해 중복 최소화
 *  - [핵심] 원문 URL 영구화: 그라운딩 vertexaisearch 리다이렉트(임시·만료)를 수동 추적해
 *      최종 도착 canonical URL을 잡아 저장 → 아카이브 링크가 시간이 지나도 살아 있음
 *  - API 항목 자동 중요도 산정(_autoImportance) + 제목/요약에서 모니터링 기업 탐지(_detectCompany)
 *  - URL 검증 한도 25 → 60, 공식 API URL은 검증 생략
 *  - 진단 함수 testCbpApi() / testFederalRegister() 추가
 *
 * v3.1
 *  - 디자인 리뉴얼 (레퍼런스 테마 적용):
 *      · 글로벌 테마 상수 도입 (FONT_STACK / CATEGORY_COLORS / IMPORTANCE_COLORS / IMPORTANCE_BG)
 *      · 이메일: 플랫 레이아웃(#eef1f5 배경, 680px, #dde1e7 보더), 네이비 헤더/푸터(#14294a, bgcolor 병기로 Outlook 호환),
 *        수록 기준 안내 영역(연초록 #eaf6ee + #2e8b57 상단 보더), 카테고리 섹션 헤더 솔리드 컬러
 *      · 아이템 카드: 좌측 5px 중요도 세로 컬러바, 공통 뱃지 UI(중요도/HS/기업), 타이틀 원문 링크(#15418c 언더라인)
 *      · 구글 시트: 헤더 네이비(#1a2a4a), 중요도 '상' 행 연한 빨강(#fff5f5) 하이라이트
 *  - importance(중요도 상/중/하) 필드 추가: Gemini가 판정(상=모니터링 기업 직접 관련/핵심 품목 분류 변경·분쟁,
 *    중=모니터링 품목, 하=HS류만 관련), 국가별 카드 상→중→하 정렬, 시트 '중요도' 컬럼 저장
 *
 * v3.0
 *  - [버그] 동북아(한국/일본) 카테고리가 이메일 CATEGORY_ORDER에 없어 메일에서 누락되던 문제 수정
 *  - [버그] 지역 프롬프트에 "last 30 days"가 하드코딩되어 MONITORING_DAYS(14일)와 모순되던 문제 수정
 *          → {DAYS}/{YEAR} 플레이스홀더로 동적 치환
 *  - [버그] 그룹 지역(아르헨티나/칠레/파나마 등)의 country → category 역매핑 실패 수정 (countries 배열 도입)
 *  - [핵심] 원문 URL 정확도 개선:
 *      ① Gemini google_search grounding 메타데이터(groundingChunks/Supports)에서 실제 검색 출처 URL 추출
 *      ② 모델이 URL을 지어내지 못하도록 프롬프트 강화 (모르면 빈 값)
 *      ③ 수집된 URL 실제 접속 검증(UrlFetchApp) 후 상태 기록
 *      ④ 이메일 링크 우선순위: 원문 URL → 공식 DB 직링크(미국 CBP 등) → 공식 사이트 한정 구글검색(site:) → 일반 구글검색
 *  - [핵심] 중복 수집 방지: 동향DB 기존 데이터와 비교해 (국가+Ruling번호 / 국가+영문제목) 중복 제거
 *  - API 호출 배치 처리 + 429/5xx 재시도 (전 지역 동시 호출로 인한 rate limit 대응)
 *  - 글로벌 통상언론/WCO 검색 패스 추가 (공식 DB 미공개 국가 커버리지 보완)
 *  - 동향DB에 카테고리/URL상태/URL출처 컬럼 추가
 *  - HTML 이스케이프 처리 (모델 출력에 <, >, & 포함 시 메일 레이아웃 깨짐 방지)
 *  - listAvailableModels() 진단 함수 추가 (사용 가능한 Gemini 모델명 확인용)
 *
 * v2.0
 *  - 모니터링 주기: 최근 30일 → 최근 14일(2주)
 *  - 수신자가 "HS 요청" 메일 발송 시 자동 재발송 기능 추가
 *
 * [초기 설정] — 총 2단계
 * ① 스크립트 속성에 GEMINI_API_KEY 등록
 * ② 구글 시트가 열린 상태에서 setupAllTriggers() 1회 실행
 */

// ─── 설정 상수 ──────────────────────────────────────────────────────────────

// ※ 'gemini-3.5-flash'는 존재하지 않는 모델명일 수 있음.
//    google_search 그라운딩을 지원하는 모델 사용 필수 (예: gemini-2.5-flash / gemini-2.5-pro).
//    listAvailableModels() 실행 → 로그에서 실제 사용 가능 모델명 확인 후 수정.
var MODEL_NAME      = 'gemini-2.5-flash';
var DB_SHEET_NAME   = '동향DB';
var RCPT_SHEET_NAME = '발송인 명단';

var MONITORING_DAYS = 14;

// API 호출 배치 크기/대기 — 무료 등급은 분당 요청 제한이 낮으므로 배치로 나눠 호출
var API_BATCH_SIZE     = 7;
var API_BATCH_PAUSE_MS = 2000;
var API_MAX_RETRY      = 2;     // 429/5xx 시 개별 재시도 횟수

// URL 실접속 검증 최대 건수 (Apps Script 6분 실행 제한 고려)
var URL_VERIFY_MAX = 60;

// ─── 공식 API 직접 수집 (하이브리드) ─────────────────────────────────────────
// API가 있는 소스는 직접 수집 → 전수에 가까운 수집 + 영구 원문 URL 확보.
// 나머지 국가는 Gemini google_search 그라운딩으로 보완.
var USE_CBP_API          = true;   // 美 CBP CROSS 분류 결정 JSON API (무인증)
var USE_FEDERAL_REGISTER = true;   // 美 Federal Register API (무인증) — CBP 분류 고시/결정
var CBP_PAGE_SIZE        = 50;     // CBP 검색어당 최대 조회 건수 (최신순)
var CBP_MAX_PER_TERM     = 50;     // 검색어당 기간 내 채택 상한

// CBP CROSS 검색어 — 모니터링 품목/기업 (검색어 1개 = API 1회 호출)
var CBP_SEARCH_TERMS = [
  'smartphone', 'mobile phone', 'tablet computer', 'smartwatch', 'smart glasses',
  'wireless earphones', 'earbuds', 'air conditioner', 'heat pump', 'chiller',
  'oven', 'refrigerator', 'vacuum cleaner', 'television', 'monitor', 'soundbar',
  'interactive whiteboard', 'clothing care', 'camera', 'base station', 'antenna',
  'X-ray', 'Samsung', 'LG Electronics', 'Apple', 'Huawei', 'Xiaomi', 'Whirlpool', 'Haier'
];

// ─── 자동 중요도/필터 기준 (모델 없이 수집되는 API 항목용) ───────────────────
var MONITORED_COMPANIES = ['apple', 'samsung', 'lg electronics', 'huawei', 'xiaomi',
                           'oppo', 'vivo', 'whirlpool', 'general electric', 'haier'];
var MONITORED_PRODUCT_TERMS = ['smartphone', 'mobile phone', 'cellular', 'tablet', 'smartwatch',
  'smart glass', 'earphone', 'earbud', 'headphone', 'air conditioner', 'heat pump', 'chiller',
  'oven', 'refrigerator', 'vacuum', 'television', 'tv ', 'monitor', 'soundbar', 'whiteboard',
  'clothing care', 'shoe care', 'camera', 'mock-up', 'base station', 'antenna', 'wireless',
  'x-ray', 'medical imaging'];
var MONITORED_HS_CHAPTERS = ['39', '40', '42', '72', '73', '83', '84', '85', '90', '91', '94'];

// Gmail 폴링용 라벨 (처리 완료 메일 마킹 — 없으면 자동 생성)
var PROCESSED_LABEL = 'HS-요청-처리완료';

// ─── 디자인 테마 상수 ────────────────────────────────────────────────────────

var FONT_STACK = "'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo',Arial,sans-serif";

// 카테고리별 테마 컬러 (이메일 섹션 헤더/뱃지) — MONITORING_REGIONS의 category와 일치해야 함
var CATEGORY_COLORS = {
  '동북아': '#14294a', '중국': '#990000', '북미': '#1a3c5e', '중남미': '#1b5e3b',
  '인도': '#7b3000', '유럽': '#003080', '중동': '#6d3b00', '동남아': '#00565a',
  '아프리카': '#4a2800', 'CIS': '#3a1a5a', '글로벌': '#37474f'
};

// 중요도별 뱃지/컬러바 색상
var IMPORTANCE_COLORS = { '상': '#c62828', '중': '#ef6c00', '하': '#2e7d32' };
var IMPORTANCE_BG     = { '상': '#fdecea', '중': '#fff3e0', '하': '#e8f5e9' };

// 구글 시트 스타일
var SHEET_HEADER_BG    = '#1a2a4a';  // 헤더 네이비 딥블루
var SHEET_HIGHLIGHT_BG = '#fff5f5';  // 중요도 '상' 행 하이라이트

// ─── 모니터링 지역/사이트 구성 ───────────────────────────────────────────────
// isGroup   : true → 묶음 호출. Gemini가 country 필드에 실제 국가명을 채움
// countries : 그룹 호출 시 포함 국가 목록 (category 역매핑 및 country 보정용)
// prompt 내 {DAYS} → MONITORING_DAYS, {YEAR} → 실행 연도로 자동 치환됨
var MONITORING_REGIONS = [

  // ── 동북아 ──
  {
    category: '동북아', region: '한국',
    source  : '관세청 CLIP (관세평가분류원)',
    prompt  : 'Search for HS Code tariff classification rulings from South Korea published in the last {DAYS} days. ' +
              'Look broadly in: Korea Customs CLIP / 관세법령정보포털 (unipass.customs.go.kr/clip), 관세평가분류원 보도자료, customs news sites (한국관세신문, 관세무역신문), trade publications, and any web source reporting on Korean customs rulings. ' +
              'Keywords: "품목분류 사전심사" "관세품목분류위원회 결정" "HS코드 유권해석" "품목분류 결정례" "스마트폰" "에어컨" "Samsung" "LG전자" "tariff classification ruling Korea {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '동북아', region: '일본',
    source  : 'Japan Customs 사전교시 DB',
    prompt  : 'Search for HS Code tariff classification rulings from Japan published in the last {DAYS} days. ' +
              'Look broadly in: Japan Customs 事前教示回答事例 (customs.go.jp), Japanese customs news, trade publications, and any web source reporting on Japanese customs rulings. ' +
              'Keywords: "事前教示" "関税分類" "品目分類" "税関 分類事例" "スマートフォン" "エアコン" "Samsung" "Apple" "Japan tariff classification ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 중국 ──
  {
    category: '중국', region: '중국',
    source  : '中国海关总署 (China General Administration of Customs)',
    prompt  : 'Search for HS Code tariff classification rulings from China published in the last {DAYS} days. ' +
              'Look broadly in: China customs (customs.gov.cn), 归类决定 announcements, Chinese trade news, WTO notifications, and any web source reporting on Chinese customs classification. ' +
              'Keywords: "商品归类" "归类决定" "税则归类" "海关总署公告 归类" "智能手机" "空调" "Samsung" "Huawei" "Apple" "China HS classification ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 북미 ──
  {
    category: '북미', region: '미국',
    source  : 'U.S. CIT/CAFC 판결 · 통상 분쟁 (CROSS는 API 직수집)',
    // ※ 일상적 CROSS 결정은 CBP API로 전수 수집하므로, 여기서는 그 外 보완 영역에 집중
    prompt  : 'Search for NOTABLE US HS tariff classification developments in the last {DAYS} days, EXCLUDING routine CBP CROSS ruling letters (those are collected separately). ' +
              'Focus on: Court of International Trade (CIT) and Federal Circuit (CAFC) classification judgments, classification disputes/litigation, Section 301/exclusion classification issues, and trade-press analysis of significant US classification decisions. ' +
              'Look in: cit.uscourts.gov, cafc.uscourts.gov, Sandler Travis, law firm trade alerts, Lexology, Law360. ' +
              'Keywords: "CIT tariff classification decision" "CAFC classification HTSUS" "classification litigation" "smartphone" "air conditioner" "Samsung" "Apple" "LG" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '북미', region: '캐나다',
    source  : 'CBSA National Tariff Classification Rulings',
    prompt  : 'Search for HS Code tariff classification rulings from Canada published in the last {DAYS} days. ' +
              'Look broadly in: CBSA advance rulings (cbsa-asfc.gc.ca), CITT appeal decisions, Canadian customs news, trade publications, and any web source reporting on Canadian customs rulings. ' +
              'Keywords: "CBSA tariff classification advance ruling" "CITT appeal tariff" "Canada customs classification" "smartphone" "Samsung" "Apple" "LG" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 중남미 ──
  {
    category: '중남미', region: '멕시코',
    source  : 'SAT Mexico',
    prompt  : 'Search for HS Code tariff classification rulings from Mexico published in the last {DAYS} days. ' +
              'Look broadly in: SAT Mexico (sat.gob.mx), ANAM, Diario Oficial de la Federación, Mexican trade news, customs publications, and any web source reporting on Mexican customs rulings. ' +
              'Keywords: "SAT clasificación arancelaria" "fracción arancelaria México" "TIGIE" "criterio de clasificación" "smartphone" "teléfono celular" "Samsung" "Apple" "Mexico tariff classification {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중남미', region: '브라질',
    source  : 'Receita Federal do Brasil (RFB)',
    prompt  : 'Search for HS Code tariff classification rulings from Brazil published in the last {DAYS} days. ' +
              'Look broadly in: Receita Federal Soluções de Consulta (normas.receita.fazenda.gov.br), Brazilian trade news, NCM updates, and any web source reporting on Brazilian customs classification. ' +
              'Keywords: "Solução de Consulta classificação fiscal NCM" "Receita Federal NCM" "smartphone" "telefone celular" "Samsung" "Apple" "Brazil tariff classification {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중남미', region: '콜롬비아',
    source  : 'DIAN Colombia',
    prompt  : 'Search for HS Code tariff classification rulings from Colombia published in the last {DAYS} days. ' +
              'Look broadly in: DIAN Colombia (dian.gov.co) clasificación arancelaria resolutions, Colombian customs news, trade publications. ' +
              'Keywords: "DIAN resolución clasificación arancelaria Colombia" "arancel Colombia aduanas" "Colombia tariff classification ruling {YEAR}" "smartphone" "Samsung" "Apple". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중남미', region: '페루',
    source  : 'SUNAT Peru',
    prompt  : 'Search for HS Code tariff classification rulings from Peru published in the last {DAYS} days. ' +
              'Look broadly in: SUNAT Peru (sunat.gob.pe) resoluciones de clasificación arancelaria, Peruvian customs news, trade publications. ' +
              'Keywords: "SUNAT resolución clasificación arancelaria Perú" "INTA Perú arancel" "Peru tariff classification ruling {YEAR}" "smartphone" "Samsung" "Apple". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중남미', region: '아르헨티나/칠레/파나마', isGroup: true,
    countries: ['아르헨티나', '칠레', '파나마'],
    source  : 'ARCA(아르헨티나) / Aduana Chile / ANA(파나마)',
    prompt  : 'Search for HS Code tariff classification rulings from Argentina, Chile, or Panama published in the last {DAYS} days. ' +
              'Look broadly in: Argentina ARCA/AFIP (afip.gob.ar), Chile Customs (aduana.cl) resoluciones de clasificación, Panama ANA (ana.gob.pa), and any web source reporting on these countries\' customs rulings. ' +
              'Keywords: "clasificación arancelaria Argentina" "Aduana Chile resolución clasificación" "ANA Panamá arancel" "smartphone" "Samsung" "Apple" "tariff classification ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (아르헨티나 / 칠레 / 파나마) in the country field for each ruling found.'
  },

  // ── 인도 ──
  {
    category: '인도', region: '인도',
    source  : 'India CBIC / Customs Authority for Advance Rulings',
    prompt  : 'Search for HS Code tariff classification rulings from India published in the last {DAYS} days. ' +
              'Look broadly in: CBIC (cbic.gov.in), Customs Authority for Advance Rulings (CAAR Mumbai / CAAR Delhi), CESTAT classification decisions, customs circulars, TaxGuru, Taxscan, trade news. ' +
              'Keywords: "CAAR advance ruling classification" "CESTAT classification" "CBIC circular classification" "HSN classification India" "customs tariff heading" "smartphone" "air conditioner" "Samsung" "Apple" "LG" "India ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 유럽 ──
  {
    category: '유럽', region: 'EU',
    source  : 'EU BTI (Binding Tariff Information)',
    prompt  : 'Search for HS Code tariff classification rulings from the European Union published in the last {DAYS} days. ' +
              'Look broadly in: EU BTI/EBTI database (ec.europa.eu), EU Classification Regulations published in the Official Journal (EUR-Lex), CJEU tariff classification judgments, EU customs news, and any web source reporting on EU customs classification. ' +
              'Keywords: "EU classification regulation Combined Nomenclature" "Commission Implementing Regulation classification" "BTI binding tariff information" "CJEU tariff classification" "smartphone" "air conditioner" "Samsung" "Apple" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '유럽', region: '영국',
    source  : 'UK HMRC ADD (Advance Tariff Ruling)',
    prompt  : 'Search for HS Code tariff classification rulings from the United Kingdom published in the last {DAYS} days. ' +
              'Look broadly in: UK HMRC Advance Tariff Rulings, UK Trade Tariff (trade-tariff.service.gov.uk), First-tier Tribunal tariff classification decisions, UK customs news, trade publications. ' +
              'Keywords: "UK HMRC advance tariff ruling" "UK commodity code classification" "tribunal tariff classification UK" "smartphone" "Samsung" "Apple" "UK tariff ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },

  // ── 중동 ──
  {
    category: '중동', region: '사우디아라비아/UAE', isGroup: true,
    countries: ['사우디아라비아', 'UAE'],
    source  : 'ZATCA(사우디) / UAE FCA',
    prompt  : 'Search for HS Code tariff classification rulings from Saudi Arabia or UAE published in the last {DAYS} days. ' +
              'Look broadly in: Saudi ZATCA (zatca.gov.sa), UAE Federal Customs Authority, Dubai Customs, GCC customs news, trade publications, and any web source reporting on these countries\' customs rulings. ' +
              'Keywords: "ZATCA tariff classification Saudi" "Dubai Customs HS classification" "GCC tariff ruling" "تصنيف جمركي" "smartphone" "Samsung" "Apple" "Huawei" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (사우디아라비아 / UAE) in the country field.'
  },
  {
    category: '중동', region: '튀르키예',
    source  : 'Turkish Ministry of Trade (Ticaret Bakanlığı)',
    prompt  : 'Search for HS Code tariff classification rulings from Turkey published in the last {DAYS} days. ' +
              'Look broadly in: Turkish Ministry of Trade (ticaret.gov.tr), Gümrükler Genel Müdürlüğü, Bağlayıcı Tarife Bilgisi (BTB), Turkish customs news, trade publications. ' +
              'Keywords: "bağlayıcı tarife bilgisi" "gümrük tarife sınıflandırması" "tarife kararı" "Turkey customs classification ruling {YEAR}" "smartphone" "Samsung" "Apple". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable.'
  },
  {
    category: '중동', region: '이집트/요르단/이라크/모로코/파키스탄/이스라엘', isGroup: true,
    countries: ['이집트', '요르단', '이라크', '모로코', '튀니지', '알제리', '파키스탄', '이스라엘'],
    source  : '이집트 / 요르단 / 이라크 / 모로코 / 튀니지 / 알제리 / 파키스탄 / 이스라엘',
    prompt  : 'Search for HS Code tariff classification rulings from any of these countries published in the last {DAYS} days: ' +
              'Egypt, Jordan, Iraq, Morocco, Tunisia, Algeria, Pakistan, Israel. ' +
              'Look broadly in official customs authorities and any web source (news, trade publications) reporting on customs rulings from these countries. ' +
              'Keywords: "Egypt customs classification ruling" "Morocco ADII tariff" "Tunisia douane classification" "Algeria douane tariff" ' +
              '"Pakistan FBR customs classification ruling" "Pakistan Customs Appellate Tribunal classification" "Israel customs tariff ruling" "Jordan customs classification" ' +
              '"تصنيف جمركي" "classification tarifaire" "smartphone" "Samsung" "Apple". ' +
              'Do NOT limit results to official DB only. ' +
              'Use the actual country name (이집트 / 요르단 / 이라크 / 모로코 / 튀니지 / 알제리 / 파키스탄 / 이스라엘) in the country field.'
  },

  // ── 동남아/오세아니아 ──
  {
    category: '동남아', region: '인도네시아/말레이시아/태국', isGroup: true,
    countries: ['인도네시아', '말레이시아', '태국'],
    source  : '인도네시아 Bea Cukai / 말레이시아 Royal Customs / 태국 Customs',
    prompt  : 'Search for HS Code tariff classification rulings from Indonesia, Malaysia, or Thailand published in the last {DAYS} days. ' +
              'Look broadly in: Indonesia Bea Cukai (beacukai.go.id) penetapan klasifikasi, Malaysia Customs (customs.gov.my) ketetapan kastam / customs ruling, Thailand Customs (customs.go.th) advance tariff ruling, ASEAN trade news. ' +
              'Keywords: "penetapan klasifikasi barang Indonesia" "Malaysia customs ruling tariff classification" "Thailand advance tariff ruling" "smartphone" "Samsung" "Apple" "ASEAN tariff classification {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (인도네시아 / 말레이시아 / 태국) in the country field.'
  },
  {
    category: '동남아', region: '베트남/필리핀/싱가포르', isGroup: true,
    countries: ['베트남', '필리핀', '싱가포르'],
    source  : '베트남 General Customs / 필리핀 BOC / 싱가포르 Customs',
    prompt  : 'Search for HS Code tariff classification rulings from Vietnam, Philippines, or Singapore published in the last {DAYS} days. ' +
              'Look broadly in: Vietnam Customs (customs.gov.vn) phân loại hàng hóa decisions, Philippines Tariff Commission / BOC tariff classification rulings, Singapore Customs (customs.gov.sg), ASEAN trade news. ' +
              'Keywords: "quyết định phân loại hàng hóa" "Philippines tariff classification ruling" "Singapore customs classification" "smartphone" "Samsung" "Apple" "ASEAN tariff ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (베트남 / 필리핀 / 싱가포르) in the country field.'
  },
  {
    category: '동남아', region: '호주/뉴질랜드', isGroup: true,
    countries: ['호주', '뉴질랜드'],
    source  : 'Australian Border Force / New Zealand Customs',
    prompt  : 'Search for HS Code tariff classification rulings from Australia or New Zealand published in the last {DAYS} days. ' +
              'Look broadly in: ABF Australia tariff advice / Tariff Classification Gazette (abf.gov.au), New Zealand Customs rulings (customs.govt.nz), trade news. ' +
              'Keywords: "Australia tariff advice classification" "ABF tariff classification gazette" "New Zealand customs tariff ruling" "smartphone" "Samsung" "Apple" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (호주 / 뉴질랜드) in the country field.'
  },

  // ── 아프리카 ──
  {
    category: '아프리카', region: '아프리카', isGroup: true,
    countries: ['남아프리카공화국', '나이지리아', '케냐'],
    source  : 'SARS(남아공) / Nigeria Customs / KRA(케냐)',
    prompt  : 'Search for HS Code tariff classification rulings from South Africa, Nigeria, or Kenya published in the last {DAYS} days. ' +
              'Look broadly in: SARS tariff determinations (sars.gov.za), Nigeria Customs (customs.gov.ng), Kenya KRA customs rulings (kra.go.ke), African trade news. ' +
              'Keywords: "SARS tariff determination classification" "Nigeria customs HS code ruling" "Kenya KRA customs classification" "smartphone" "Samsung" "Apple" "Africa tariff ruling {YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (남아프리카공화국 / 나이지리아 / 케냐) in the country field.'
  },

  // ── CIS ──
  {
    category: 'CIS', region: 'CIS', isGroup: true,
    countries: ['러시아', '카자흐스탄', '우즈베키스탄'],
    source  : 'ФТС(러시아) / КГД(카자흐스탄) / ГТК(우즈베키스탄)',
    prompt  : 'Search for HS Code tariff classification rulings from Russia, Kazakhstan, or Uzbekistan published in the last {DAYS} days. ' +
              'Look broadly in: Russia FCS классификационные решения (customs.gov.ru), EAEU/ЕЭК classification decisions (eec.eaeunion.org), Kazakhstan KGD (kgd.gov.kz), Uzbekistan customs (customs.uz), CIS trade news. ' +
              'Keywords: "классификационное решение ТН ВЭД" "решение ЕЭК классификация" "Kazakhstan customs tariff classification" "смартфон" "кондиционер" "Samsung" "Huawei" "Apple" "{YEAR}". ' +
              'Do NOT limit results to official DB only — news articles and trade reports are acceptable. ' +
              'Use the actual country name (러시아 / 카자흐스탄 / 우즈베키스탄) in the country field.'
  },

  // ── 글로벌 (통상 전문지/WCO — 공식 DB 미공개 국가 보완) ──
  {
    category: '글로벌', region: '글로벌 통상언론/WCO', isGroup: true,
    countries: [],
    source  : 'WCO / 글로벌 통상 전문지 / 로펌 Trade Alert',
    prompt  : 'Search global trade press, law firm alerts and WCO sources for NEW or notable HS / tariff classification rulings, disputes or court decisions from ANY country, published in the last {DAYS} days. ' +
              'Look broadly in: WCO news (wcoomd.org), Lexology, Mondaq, Law360, Bloomberg Law, Reuters, Sandler Travis trade report, KPMG/EY/Deloitte/PwC trade & customs alerts, CustomsMobile, customs law firm newsletters. ' +
              'Keywords: "tariff classification ruling" "HS code classification dispute" "customs classification decision court" "advance ruling classification" "smartphone" "air conditioner" "TV" "Samsung" "LG" "Apple" "{YEAR}". ' +
              'Do NOT report items already covered by official customs DB monitoring (CBP CROSS routine weekly rulings) unless they are notable. ' +
              'Use the actual country name in KOREAN in the country field (예: 미국, 독일, 인도, 베트남).'
  }

];

// ─── 국가별 공식 DB 정보 ─────────────────────────────────────────────────────
// rulingUrl : ruling_number만으로 원문 직링크 생성 가능한 경우의 템플릿 ({NUM} 치환)
// searchUrl : 공식 DB 검색 페이지에 검색어를 넘길 수 있는 경우의 템플릿 ({Q} 치환)
// domain    : 위 둘이 없으면 구글 site: 검색으로 공식 사이트 내 검색 링크 생성
var OFFICIAL_DB = {
  '미국'            : { agency: 'CBP CROSS',            domain: 'rulings.cbp.gov',
                        rulingUrl: 'https://rulings.cbp.gov/ruling/{NUM}',
                        searchUrl: 'https://rulings.cbp.gov/search?term={Q}' },
  '한국'            : { agency: '관세법령정보포털(CLIP)', domain: 'unipass.customs.go.kr' },
  '일본'            : { agency: 'Japan Customs 事前教示', domain: 'customs.go.jp' },
  '중국'            : { agency: '海关总署',              domain: 'customs.gov.cn' },
  '캐나다'          : { agency: 'CBSA',                  domain: 'cbsa-asfc.gc.ca' },
  '멕시코'          : { agency: 'SAT',                   domain: 'sat.gob.mx' },
  '브라질'          : { agency: 'Receita Federal',       domain: 'normas.receita.fazenda.gov.br' },
  '콜롬비아'        : { agency: 'DIAN',                  domain: 'dian.gov.co' },
  '페루'            : { agency: 'SUNAT',                 domain: 'sunat.gob.pe' },
  '아르헨티나'      : { agency: 'ARCA',                  domain: 'afip.gob.ar' },
  '칠레'            : { agency: 'Aduana Chile',          domain: 'aduana.cl' },
  '파나마'          : { agency: 'ANA',                   domain: 'ana.gob.pa' },
  '인도'            : { agency: 'CBIC',                  domain: 'cbic.gov.in' },
  'EU'              : { agency: 'EU EBTI',               domain: 'ec.europa.eu',
                        searchUrl: 'https://ec.europa.eu/taxation_customs/dds2/ebti/ebti_consultation.jsp?Lang=en' },
  '영국'            : { agency: 'UK Trade Tariff',       domain: 'gov.uk',
                        searchUrl: 'https://www.trade-tariff.service.gov.uk/search?q={Q}' },
  '튀르키예'        : { agency: 'Ticaret Bakanlığı',     domain: 'ticaret.gov.tr' },
  '사우디아라비아'  : { agency: 'ZATCA',                 domain: 'zatca.gov.sa' },
  'UAE'             : { agency: 'UAE Customs',           domain: 'gov.ae' },
  '이집트'          : { agency: 'Egyptian Customs',      domain: 'customs.gov.eg' },
  '요르단'          : { agency: 'Jordan Customs',        domain: 'customs.gov.jo' },
  '모로코'          : { agency: 'ADII',                  domain: 'douane.gov.ma' },
  '파키스탄'        : { agency: 'FBR',                   domain: 'fbr.gov.pk' },
  '이스라엘'        : { agency: 'Israel Tax Authority',  domain: 'gov.il' },
  '인도네시아'      : { agency: 'Bea Cukai',             domain: 'beacukai.go.id' },
  '말레이시아'      : { agency: 'Royal Malaysian Customs', domain: 'customs.gov.my' },
  '태국'            : { agency: 'Thai Customs',          domain: 'customs.go.th' },
  '베트남'          : { agency: 'Vietnam Customs',       domain: 'customs.gov.vn' },
  '필리핀'          : { agency: 'Philippine Tariff Commission', domain: 'tariffcommission.gov.ph' },
  '싱가포르'        : { agency: 'Singapore Customs',     domain: 'customs.gov.sg' },
  '호주'            : { agency: 'ABF',                   domain: 'abf.gov.au' },
  '뉴질랜드'        : { agency: 'NZ Customs',            domain: 'customs.govt.nz' },
  '남아프리카공화국': { agency: 'SARS',                  domain: 'sars.gov.za' },
  '나이지리아'      : { agency: 'Nigeria Customs',       domain: 'customs.gov.ng' },
  '케냐'            : { agency: 'KRA',                   domain: 'kra.go.ke' },
  '러시아'          : { agency: 'ФТС России',            domain: 'customs.gov.ru' },
  '카자흐스탄'      : { agency: 'КГД',                   domain: 'kgd.gov.kz' },
  '우즈베키스탄'    : { agency: 'Customs Uzbekistan',    domain: 'customs.uz' }
};

// ─── 국가별 Google 검색 언어 설정 ────────────────────────────────────────────
var COUNTRY_SEARCH_LANG = {
  '한국'          : { hl: 'ko',    gl: 'KR', queryField: 'title'    },
  '일본'          : { hl: 'ja',    gl: 'JP', queryField: 'title_en' },
  '중국'          : { hl: 'zh-CN', gl: 'CN', queryField: 'title_en' },
  '미국'          : { hl: 'en',    gl: 'US', queryField: 'title_en' },
  '캐나다'        : { hl: 'en',    gl: 'CA', queryField: 'title_en' },
  '멕시코'        : { hl: 'es',    gl: 'MX', queryField: 'title_en' },
  '브라질'        : { hl: 'pt-BR', gl: 'BR', queryField: 'title_en' },
  '콜롬비아'      : { hl: 'es',    gl: 'CO', queryField: 'title_en' },
  '페루'          : { hl: 'es',    gl: 'PE', queryField: 'title_en' },
  '아르헨티나'    : { hl: 'es',    gl: 'AR', queryField: 'title_en' },
  '칠레'          : { hl: 'es',    gl: 'CL', queryField: 'title_en' },
  '파나마'        : { hl: 'es',    gl: 'PA', queryField: 'title_en' },
  '인도'          : { hl: 'en',    gl: 'IN', queryField: 'title_en' },
  'EU'            : { hl: 'en',    gl: 'BE', queryField: 'title_en' },
  '영국'          : { hl: 'en',    gl: 'GB', queryField: 'title_en' },
  '사우디아라비아': { hl: 'ar',    gl: 'SA', queryField: 'title_en' },
  'UAE'           : { hl: 'ar',    gl: 'AE', queryField: 'title_en' },
  '이스라엘'      : { hl: 'iw',    gl: 'IL', queryField: 'title_en' },
  '이라크'        : { hl: 'ar',    gl: 'IQ', queryField: 'title_en' },
  '요르단'        : { hl: 'ar',    gl: 'JO', queryField: 'title_en' },
  '이집트'        : { hl: 'ar',    gl: 'EG', queryField: 'title_en' },
  '모로코'        : { hl: 'fr',    gl: 'MA', queryField: 'title_en' },
  '튀니지'        : { hl: 'fr',    gl: 'TN', queryField: 'title_en' },
  '알제리'        : { hl: 'fr',    gl: 'DZ', queryField: 'title_en' },
  '튀르키예'      : { hl: 'tr',    gl: 'TR', queryField: 'title_en' },
  '파키스탄'      : { hl: 'en',    gl: 'PK', queryField: 'title_en' },
  '인도네시아'    : { hl: 'id',    gl: 'ID', queryField: 'title_en' },
  '말레이시아'    : { hl: 'ms',    gl: 'MY', queryField: 'title_en' },
  '태국'          : { hl: 'th',    gl: 'TH', queryField: 'title_en' },
  '베트남'        : { hl: 'vi',    gl: 'VN', queryField: 'title_en' },
  '필리핀'        : { hl: 'en',    gl: 'PH', queryField: 'title_en' },
  '싱가포르'      : { hl: 'en',    gl: 'SG', queryField: 'title_en' },
  '호주'          : { hl: 'en',    gl: 'AU', queryField: 'title_en' },
  '뉴질랜드'      : { hl: 'en',    gl: 'NZ', queryField: 'title_en' },
  '남아프리카공화국': { hl: 'en',  gl: 'ZA', queryField: 'title_en' },
  '나이지리아'    : { hl: 'en',    gl: 'NG', queryField: 'title_en' },
  '케냐'          : { hl: 'en',    gl: 'KE', queryField: 'title_en' },
  '러시아'        : { hl: 'ru',    gl: 'RU', queryField: 'title_en' },
  '카자흐스탄'    : { hl: 'ru',    gl: 'KZ', queryField: 'title_en' },
  '우즈베키스탄'  : { hl: 'ru',    gl: 'UZ', queryField: 'title_en' }
};

// ─── 원문/검색 링크 생성 ─────────────────────────────────────────────────────

/**
 * 링크 우선순위:
 *  ① item.url (grounding/모델 제공 + 접속 검증 통과) → "원문 보기"
 *  ② 공식 DB 직링크 템플릿 (예: 미국 CBP rulings.cbp.gov/ruling/{번호}) → "원문 보기 (기관명)"
 *  ③ 공식 DB 검색 / 공식 도메인 한정 구글 검색(site:) → "공식 DB 검색"
 *  ④ 일반 구글 검색 (현지 언어 hl/gl) → "구글 검색"
 * 항상 ①or② 버튼 + ③ + ④ 순으로 최대 3개 버튼을 표시한다.
 */
/** 수집 URL(검증 통과) 또는 공식 DB 직링크 중 가장 신뢰할 수 있는 원문 URL 반환 (없으면 '') */
function _directOriginalUrl(item) {
  var urlOk = item.url && /^https?:\/\//i.test(item.url) &&
              String(item.url_status || '').indexOf('FAIL') === -1;
  if (urlOk) return item.url;
  var official = OFFICIAL_DB[item.country] || null;
  if (official && official.rulingUrl && item.ruling_number) {
    return official.rulingUrl.replace('{NUM}', encodeURIComponent(String(item.ruling_number).trim()));
  }
  return '';
}

function _buildSourceLink(item) {
  var buttons  = [];
  var official = OFFICIAL_DB[item.country] || null;

  function btn(url, label, color) {
    return '<a href="' + url + '" target="_blank" ' +
           'style="display:inline-block;color:' + color + ';text-decoration:none;font-size:11px;font-weight:bold;' +
           'border:1px solid ' + color + ';padding:2px 8px;border-radius:3px;margin-right:6px;margin-bottom:3px;">' +
           label + '</a>';
  }

  // ① 수집된 원문 URL (검증 실패 'FAIL'은 제외, 미검증은 표시)
  var urlOk = item.url && /^https?:\/\//i.test(item.url) &&
              String(item.url_status || '').indexOf('FAIL') === -1;
  if (urlOk) {
    var srcName = item.url_source ? ' (' + _escapeHtml(item.url_source) + ')' : '';
    buttons.push(btn(_escapeHtml(item.url), '원문 보기' + srcName, '#c62828'));
  }
  // ② 공식 DB 직링크 (ruling_number 기반) — ①이 없을 때 보조 제공
  else if (official && official.rulingUrl && item.ruling_number) {
    var directUrl = official.rulingUrl.replace('{NUM}', encodeURIComponent(String(item.ruling_number).trim()));
    buttons.push(btn(directUrl, '원문 보기 (' + official.agency + ')', '#c62828'));
  }

  // 검색어 조합: Ruling번호 + 제목(현지/영문) + 기관명
  var langCfg   = COUNTRY_SEARCH_LANG[item.country] || { hl: 'en', gl: 'US', queryField: 'title_en' };
  var queryText = (langCfg.queryField === 'title' && item.title)
                  ? item.title
                  : (item.title_en || item.product_name_en || item.product_name || '');
  var searchParts = [];
  if (item.ruling_number) searchParts.push(item.ruling_number);
  if (queryText)          searchParts.push(queryText);
  var baseQuery = searchParts.join(' ').trim();

  // ③ 공식 DB 검색
  if (official && baseQuery) {
    if (official.searchUrl) {
      buttons.push(btn(official.searchUrl.replace('{Q}', encodeURIComponent(baseQuery)),
                       '공식 DB 검색 (' + official.agency + ')', '#2e8b57'));
    } else if (official.domain) {
      var siteUrl = 'https://www.google.com/search?q=' +
                    encodeURIComponent(baseQuery + ' site:' + official.domain);
      buttons.push(btn(siteUrl, '공식 사이트 검색 (' + official.agency + ')', '#2e8b57'));
    }
  }

  // ④ 일반 구글 검색 (현지 언어)
  if (baseQuery || item.source) {
    var gParts = searchParts.slice();
    if (item.source) gParts.push(String(item.source).split(' ')[0]);
    var googleUrl = 'https://www.google.com/search?q=' + encodeURIComponent(gParts.join(' ')) +
                    '&hl=' + langCfg.hl + '&gl=' + langCfg.gl;
    buttons.push(btn(googleUrl, '구글 검색', '#15418c'));
  }

  if (!buttons.length) return '<span style="color:#aaa;font-size:12px;">링크 정보 없음</span>';
  return buttons.join('');
}

// ─── Spreadsheet 헬퍼 ───────────────────────────────────────────────────────

function _getSpreadsheet() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!ssId) {
    throw new Error(
      '[오류] Spreadsheet ID를 찾을 수 없습니다.\n' +
      '구글 시트가 열린 상태에서 setupAllTriggers()를 먼저 실행하세요.'
    );
  }
  return SpreadsheetApp.openById(ssId);
}

function _saveSpreadsheetId() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('[오류] 구글 시트가 열려 있지 않습니다.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', active.getId());
  Logger.log('[init] Spreadsheet ID 저장: ' + active.getId());
}

// ─── 메인 실행 함수 ──────────────────────────────────────────────────────────

function runHSRulingMonitor() {
  var props  = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('[오류] GEMINI_API_KEY가 설정되지 않았습니다.');

  var today        = new Date();
  var periodStart  = new Date(today.getTime() - MONITORING_DAYS * 24 * 60 * 60 * 1000);
  var dateRangeStr = _fmtDate(periodStart) + ' ~ ' + _fmtDate(today);

  Logger.log('[HSRulingMonitor] 실행 시작: ' + dateRangeStr);

  var requests = MONITORING_REGIONS.map(function(r) {
    return _buildRequest(r, apiKey, dateRangeStr, today.getFullYear());
  });

  // 배치 단위로 호출 + 429/5xx 재시도 (rate limit 대응)
  var responses = _fetchAllInBatches(requests);

  var allResults = [];

  // ── 공식 API 직접 수집 (하이브리드) — 영구 원문 URL + 대량 수집 ──
  if (USE_CBP_API) {
    try {
      var cbp = _collectCbpRulings(periodStart);
      allResults.push.apply(allResults, cbp);
      Logger.log('[CBP CROSS API] ' + cbp.length + '건 수집');
    } catch (e) { Logger.log('[CBP CROSS API] 오류: ' + e.message); }
  }
  if (USE_FEDERAL_REGISTER) {
    try {
      var fr = _collectFederalRegister(periodStart);
      allResults.push.apply(allResults, fr);
      Logger.log('[Federal Register API] ' + fr.length + '건 수집');
    } catch (e) { Logger.log('[Federal Register API] 오류: ' + e.message); }
  }

  responses.forEach(function(resp, i) {
    var region = MONITORING_REGIONS[i];
    if (!resp) { Logger.log('[' + region.region + '] 응답 없음(재시도 실패)'); return; }
    try {
      var items = _parseGeminiResponse(resp, region.region);
      items.forEach(function(item) {
        item.category = region.category;
        if (!region.isGroup) {
          item.country = region.region;
        } else if (!item.country && region.countries && region.countries.length) {
          item.country = region.countries[0];
        }
      });
      if (items.length > 0) {
        allResults.push.apply(allResults, items);
        Logger.log('[' + region.category + '/' + region.region + '] ' + items.length + '건 수집');
      } else {
        Logger.log('[' + region.category + '/' + region.region + '] 결과 없음');
      }
    } catch (e) {
      Logger.log('[' + region.region + '] 파싱 오류: ' + e.message);
    }
  });

  // 중복 제거: ① 이번 배치 내 ② 동향DB 기존 데이터 대비
  var deduped  = _dedupResults(allResults);
  var dupCount = allResults.length - deduped.length;
  if (dupCount > 0) Logger.log('[HSRulingMonitor] 중복 ' + dupCount + '건 제외');

  // 수집된 URL 실제 접속 검증
  _verifyItemUrls(deduped);

  _saveToSheet(deduped, dateRangeStr);
  _sendEmail(deduped, dateRangeStr, dupCount);

  Logger.log('[HSRulingMonitor] 완료. 신규 ' + deduped.length + '건 / 중복 제외 ' + dupCount + '건.');
}

// ─── API 호출 배치/재시도 ────────────────────────────────────────────────────

/**
 * 요청 배열을 API_BATCH_SIZE 단위로 나눠 fetchAll 호출.
 * 429/5xx 응답은 개별적으로 최대 API_MAX_RETRY회 재시도 (지수 백오프).
 * @returns {Array<HTTPResponse|null>} 요청 인덱스 순서 유지
 */
function _fetchAllInBatches(requests) {
  var responses = new Array(requests.length);

  for (var start = 0; start < requests.length; start += API_BATCH_SIZE) {
    var batch = requests.slice(start, start + API_BATCH_SIZE);
    var batchResp;
    try {
      batchResp = UrlFetchApp.fetchAll(batch);
    } catch (e) {
      Logger.log('[fetchAll] 배치 오류(idx ' + start + '~): ' + e.message);
      batchResp = batch.map(function() { return null; });
    }
    batchResp.forEach(function(r, j) { responses[start + j] = r; });
    if (start + API_BATCH_SIZE < requests.length) Utilities.sleep(API_BATCH_PAUSE_MS);
  }

  // 실패 건 개별 재시도
  for (var i = 0; i < responses.length; i++) {
    var code = responses[i] ? responses[i].getResponseCode() : 0;
    if (code === 200) continue;
    if (code !== 429 && code < 500 && responses[i]) continue; // 4xx(429 제외)는 재시도 무의미

    for (var attempt = 1; attempt <= API_MAX_RETRY; attempt++) {
      Utilities.sleep(Math.pow(2, attempt) * 5000); // 10초, 20초
      try {
        var retry = UrlFetchApp.fetch(requests[i].url, requests[i]);
        responses[i] = retry;
        if (retry.getResponseCode() === 200) {
          Logger.log('[fetchAll] 재시도 성공 (idx ' + i + ', attempt ' + attempt + ')');
          break;
        }
      } catch (e) {
        Logger.log('[fetchAll] 재시도 실패 (idx ' + i + '): ' + e.message);
      }
    }
  }
  return responses;
}

// ─── 공식 API 직접 수집 (CBP CROSS / Federal Register) ───────────────────────

/**
 * 美 CBP CROSS 분류 결정 직접 수집.
 * 검색어별로 rulings.cbp.gov/api/search 를 최신순 호출 → 기간 내 분류(Tariff Classification) 결정만 채택.
 * 원문 URL은 rulings.cbp.gov/ruling/{번호} 형태의 영구 canonical URL.
 * ※ CBP API 응답 필드명은 변동 가능 → 여러 후보 필드명을 폴백 처리. testCbpApi()로 실제 구조 확인 가능.
 */
function _collectCbpRulings(periodStart) {
  var reqs = CBP_SEARCH_TERMS.map(function(term) {
    return {
      url: 'https://rulings.cbp.gov/api/search?term=' + encodeURIComponent(term) +
           '&collection=ALL&sortBy=DATE_DESC&pageSize=' + CBP_PAGE_SIZE + '&page=1',
      method: 'get', muteHttpExceptions: true,
      headers: { 'Accept': 'application/json' }
    };
  });

  var resps;
  try { resps = UrlFetchApp.fetchAll(reqs); }
  catch (e) { Logger.log('[CBP] fetchAll 오류: ' + e.message); return []; }

  var bySeen = {};   // ruling number 기준 중복 제거 (검색어 간)
  var out    = [];

  resps.forEach(function(resp, ti) {
    if (!resp || resp.getResponseCode() !== 200) {
      Logger.log('[CBP] "' + CBP_SEARCH_TERMS[ti] + '" HTTP ' + (resp ? resp.getResponseCode() : '없음'));
      return;
    }
    var data;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { return; }
    var rulings = data.rulings || data.results || data.Rulings || (data.data && data.data.rulings) || [];
    var kept = 0;

    rulings.forEach(function(r) {
      if (kept >= CBP_MAX_PER_TERM) return;
      var num  = r.rulingNumber || r.ruling_number || r.number || r.RulingNumber || '';
      if (!num || bySeen[num]) return;

      var dateStr = r.rulingDate || r.date || r.publicationDate || r.RulingDate || '';
      var d = dateStr ? new Date(dateStr) : null;
      if (d && !isNaN(d.getTime()) && d < periodStart) return;  // 기간 밖

      // 분류(Tariff Classification) 결정만 — HS 한정
      var cat = String(r.category || r.rulingType || r.type || '').toLowerCase();
      if (cat && cat.indexOf('class') === -1) return;

      var tariffs = r.tariffs || r.tariff || r.htsNumbers || r.htsnumbers || [];
      if (!Array.isArray(tariffs)) tariffs = tariffs ? [tariffs] : [];
      var hs = tariffs.length ? String(tariffs[0]) : '';
      var subject = r.subject || r.title || r.rulingReference || r.description || '';

      bySeen[num] = true;
      kept++;

      var item = {
        category       : '북미',
        country        : '미국',
        source         : 'U.S. CBP CROSS',
        ruling_number  : String(num).trim(),
        hs_code        : hs,
        product_name   : '',
        product_name_en: '',
        company        : _detectCompany(subject),
        title          : '',
        title_en       : subject,
        summary        : '품목분류 결정' + (tariffs.length ? ' (HTS ' + tariffs.join(', ') + ')' : ''),
        issue_date     : (d && !isNaN(d.getTime())) ? _fmtDate(d) : String(dateStr).substring(0, 10),
        url            : 'https://rulings.cbp.gov/ruling/' + encodeURIComponent(String(num).trim()),
        url_source     : 'CBP CROSS',
        url_status     : 'OK(API)'   // 공식 API 영구 URL — 접속 검증 생략
      };
      item.importance = _autoImportance(item);
      out.push(item);
    });
  });
  return out;
}

/**
 * 美 Federal Register 직접 수집 (무인증 JSON API).
 * CBP가 발행하는 분류 관련 고시/결정(Customs Bulletin 등)을 영구 html_url과 함께 수집.
 */
function _collectFederalRegister(periodStart) {
  var url = 'https://www.federalregister.gov/api/v1/documents.json' +
    '?per_page=80&order=newest' +
    '&conditions[term]=' + encodeURIComponent('tariff classification') +
    '&conditions[agencies][]=u-s-customs-and-border-protection' +
    '&conditions[publication_date][gte]=' + _fmtDate(periodStart) +
    '&fields[]=title&fields[]=html_url&fields[]=publication_date&fields[]=abstract&fields[]=document_number';

  var resp;
  try { resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true }); }
  catch (e) { Logger.log('[FedReg] fetch 오류: ' + e.message); return []; }
  if (resp.getResponseCode() !== 200) {
    Logger.log('[FedReg] HTTP ' + resp.getResponseCode());
    return [];
  }
  var data;
  try { data = JSON.parse(resp.getContentText()); } catch (e) { return []; }

  return (data.results || []).map(function(r) {
    var title = r.title || '';
    var item = {
      category       : '북미',
      country        : '미국',
      source         : 'U.S. Federal Register (CBP)',
      ruling_number  : r.document_number || '',
      hs_code        : '',
      product_name   : '',
      product_name_en: '',
      company        : _detectCompany(title + ' ' + (r.abstract || '')),
      title          : '',
      title_en       : title,
      summary        : String(r.abstract || '품목분류 관련 고시/결정').substring(0, 300),
      issue_date     : r.publication_date || '',
      url            : r.html_url || '',
      url_source     : 'Federal Register',
      url_status     : r.html_url ? 'OK(API)' : ''
    };
    item.importance = _autoImportance(item);
    return item;
  });
}

/** 텍스트에서 모니터링 기업명 탐지 (API 항목은 기업 필드가 없으므로 제목/요약에서 추출) */
function _detectCompany(text) {
  var low = String(text || '').toLowerCase();
  var names = { 'apple': 'Apple', 'samsung': 'Samsung', 'lg electronics': 'LG Electronics',
                'huawei': 'Huawei', 'xiaomi': 'Xiaomi', 'oppo': 'Oppo', 'vivo': 'Vivo',
                'whirlpool': 'Whirlpool', 'haier': 'Haier' };
  var found = '';
  Object.keys(names).forEach(function(k) { if (!found && low.indexOf(k) !== -1) found = names[k]; });
  return found;
}

/** 모델 판정 없는 API 항목의 중요도 자동 산정 (상=기업 직접 / 중=품목 / 하=HS류) */
function _autoImportance(item) {
  var hay = (String(item.title_en || '') + ' ' + String(item.summary || '') + ' ' +
             String(item.product_name_en || '')).toLowerCase();
  if (item.company) return '상';
  if (MONITORED_COMPANIES.some(function(c) { return hay.indexOf(c) !== -1; })) return '상';
  if (MONITORED_PRODUCT_TERMS.some(function(p) { return hay.indexOf(p) !== -1; })) return '중';
  return '하';
}

// ─── 중복 제거 ───────────────────────────────────────────────────────────────

function _itemKeys(item) {
  var keys = [];
  var country = String(item.country || '').trim();
  var num     = String(item.ruling_number || '').trim();
  var titleEn = String(item.title_en || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (num)     keys.push('N|' + country + '|' + num);
  if (titleEn) keys.push('T|' + country + '|' + titleEn.substring(0, 80));
  return keys;
}

/** 동향DB의 기존 (국가+Ruling번호 / 국가+영문제목) 키 집합 로드 — 최근 2000행만 */
function _loadExistingKeys() {
  var keySet = {};
  try {
    var ss    = _getSpreadsheet();
    var sheet = ss.getSheetByName(DB_SHEET_NAME);
    if (!sheet || sheet.getLastRow() <= 1) return keySet;
    var lastRow  = sheet.getLastRow();
    var startRow = Math.max(2, lastRow - 2000 + 1);
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 14).getValues();
    data.forEach(function(row) {
      _itemKeys({ country: row[2], ruling_number: row[4], title_en: row[10] })
        .forEach(function(k) { keySet[k] = true; });
    });
  } catch (e) {
    Logger.log('[dedup] 기존 키 로드 실패: ' + e.message);
  }
  return keySet;
}

function _dedupResults(results) {
  var seen  = _loadExistingKeys();
  var fresh = [];
  results.forEach(function(item) {
    var keys = _itemKeys(item);
    var dup  = keys.some(function(k) { return seen[k]; });
    if (dup) return;
    keys.forEach(function(k) { seen[k] = true; });
    fresh.push(item);
  });
  return fresh;
}

// ─── URL 검증 ────────────────────────────────────────────────────────────────

/**
 * 수집된 url을 실제 접속해 검증하고 item.url_status에 기록.
 *  - 200~399          : OK
 *  - 401/403/405/429  : OK(차단) — URL은 존재하나 봇 차단으로 추정 → 링크 유지
 *  - 그 외(404 등)    : FAIL — 이메일에서 원문 버튼 대신 검색 버튼으로 대체
 * Apps Script 실행시간 제한을 고려해 최대 URL_VERIFY_MAX건만 검증.
 */
function _verifyItemUrls(items) {
  var targets = [];
  items.forEach(function(it) {
    if (String(it.url_status || '').indexOf('OK(API)') !== -1) return;  // 공식 API URL은 검증 불필요
    if (!it.url) { it.url_status = it.url_status || ''; return; }
    if (!/^https?:\/\//i.test(it.url)) { it.url = ''; it.url_status = 'FAIL(형식)'; return; }
    if (targets.length < URL_VERIFY_MAX) targets.push(it);
    else it.url_status = 'SKIP';
  });

  targets.forEach(function(it) {
    var resolved = _resolveFinalUrl(it.url);
    if (resolved.finalUrl && /^https?:\/\//i.test(resolved.finalUrl)) {
      it.url = resolved.finalUrl;   // 그라운딩 임시 리다이렉트 → 영구 canonical URL로 치환
    }
    it.url_status = resolved.status;
  });
}

/**
 * URL을 수동으로 리다이렉트 추적해 ① 최종 도착 URL(canonical) ② 접속 상태를 반환.
 * Gemini 그라운딩의 vertexaisearch 리다이렉트 URL은 임시(만료)이므로,
 * 최종 도착 URL을 잡아 저장해야 동향DB 아카이브 링크가 나중에도 살아 있다.
 * @returns {{ finalUrl: string, status: string }}
 */
function _resolveFinalUrl(url) {
  var current = url, finalUrl = url, status = 'SKIP';
  try {
    for (var hop = 0; hop < 5; hop++) {
      var resp = UrlFetchApp.fetch(current, {
        method: 'get', muteHttpExceptions: true,
        followRedirects: false, validateHttpsCertificates: false
      });
      var c = resp.getResponseCode();
      if (c >= 300 && c < 400) {
        var loc = resp.getAllHeaders()['Location'] || resp.getAllHeaders()['location'] || '';
        if (Array.isArray(loc)) loc = loc[0];
        if (!loc) { status = 'OK'; break; }
        // 상대경로 보정
        if (/^https?:\/\//i.test(loc)) { current = loc; }
        else { current = current.replace(/^(https?:\/\/[^\/]+).*$/, '$1') + (loc.charAt(0) === '/' ? '' : '/') + loc; }
        finalUrl = current;
        continue;
      }
      if ((c >= 200 && c < 300) || c === 401 || c === 403 || c === 405 || c === 429) {
        finalUrl = current; status = 'OK';
      } else {
        status = 'FAIL(' + c + ')';
      }
      break;
    }
  } catch (e) {
    status = 'SKIP';
  }
  return { finalUrl: finalUrl, status: status };
}

// ─── "HS 요청" 메일 수신 감지 및 자동 재발송 ─────────────────────────────────

function checkHsRequestEmails() {
  Logger.log('[checkHsRequestEmails] 폴링 시작');

  var label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!label) {
    label = GmailApp.createLabel(PROCESSED_LABEL);
    Logger.log('[checkHsRequestEmails] 라벨 생성: ' + PROCESSED_LABEL);
  }

  var recipients = _getRecipients();
  if (!recipients.length) {
    Logger.log('[checkHsRequestEmails] 발송인 명단 없음 — 종료');
    return;
  }

  var fromFilter  = recipients.map(function(e) { return 'from:' + e; }).join(' OR ');
  var searchQuery = '(' + fromFilter + ') ("HS 요청") -label:' + PROCESSED_LABEL + ' newer_than:1d';

  var threads = GmailApp.search(searchQuery);
  Logger.log('[checkHsRequestEmails] 감지된 스레드 수: ' + threads.length);
  if (!threads.length) return;

  var lastData = _loadLastReportData();
  if (!lastData.results.length) {
    Logger.log('[checkHsRequestEmails] 저장된 리포트 데이터 없음 — 재발송 생략');
    threads.forEach(function(t) { t.addLabel(label); });
    return;
  }

  threads.forEach(function(thread) {
    var messages = thread.getMessages();
    var lastMsg  = messages[messages.length - 1];
    var fromRaw  = lastMsg.getFrom();
    var m        = fromRaw.match(/<([^>]+)>/);
    var requester = (m ? m[1] : fromRaw).trim();

    Logger.log('[checkHsRequestEmails] "HS 요청" 감지: ' + requester);

    try {
      var html    = _buildEmailHtml(lastData.results, lastData.dateRange, 0);
      var subject = '[HS Ruling 동향] 재발송 요청 응답 | HS Classification Ruling Report (' + lastData.dateRange + ')';
      GmailApp.sendEmail(
        requester, subject,
        '이 메일은 HTML 형식을 지원하는 메일 클라이언트에서 확인하세요.',
        { htmlBody: html, name: 'HS Ruling 모니터링 시스템' }
      );
      Logger.log('[checkHsRequestEmails] 재발송 완료 → ' + requester);
    } catch (e) {
      Logger.log('[checkHsRequestEmails] 발송 실패 (' + requester + '): ' + e.message);
    }

    thread.addLabel(label);
  });
}

/**
 * 동향DB 시트에서 가장 마지막 실행분 데이터를 로드해 반환
 * (v3.0에서 추가된 카테고리/URL상태/URL출처 컬럼은 있으면 사용, 없으면 역매핑)
 */
function _loadLastReportData() {
  var ss    = _getSpreadsheet();
  var sheet = ss.getSheetByName(DB_SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= 1) return { results: [], dateRange: '' };

  var data        = sheet.getDataRange().getValues();
  var lastRunTime = data[data.length - 1][0];
  var recentRows  = data.slice(1).filter(function(row) { return row[0] === lastRunTime; });

  var results = recentRows.map(function(row) {
    return {
      category       : row.length > 14 ? row[14] : '',
      country        : row[2],
      source         : row[3],
      ruling_number  : row[4],
      hs_code        : row[5],
      product_name   : row[6],
      product_name_en: row[7],
      company        : row[8],
      title          : row[9],
      title_en       : row[10],
      summary        : row[11],
      issue_date     : row[12],
      url            : row[13],
      url_status     : row.length > 15 ? row[15] : '',
      url_source     : row.length > 16 ? row[16] : '',
      importance     : row.length > 17 ? row[17] : ''
    };
  });

  // category 없는 구버전 행 → country 기준 역매핑
  var countryToCat = {};
  MONITORING_REGIONS.forEach(function(r) {
    countryToCat[r.region] = r.category;
    (r.countries || []).forEach(function(c) { countryToCat[c] = r.category; });
  });
  results.forEach(function(r) {
    if (!r.category) r.category = countryToCat[r.country] || r.country;
  });

  return { results: results, dateRange: recentRows[0] ? recentRows[0][1] : '' };
}

// ─── Gemini 요청 생성 ────────────────────────────────────────────────────────

function _buildRequest(region, apiKey, dateRangeStr, year) {
  var regionPrompt = region.prompt
    .replace(/\{DAYS\}/g, String(MONITORING_DAYS))
    .replace(/\{YEAR\}/g, String(year));

  var userPrompt =
    'You are an HS Code tariff classification expert. ' +
    'Use web search to investigate recent tariff classification rulings from the customs authority specified below.\n\n' +

    '[ TARGET CUSTOMS AUTHORITY ]\n' +
    regionPrompt + '\n\n' +

    '[ SEARCH PERIOD ]\n' +
    dateRangeStr + ' (last ' + MONITORING_DAYS + ' days). ' +
    'Rulings ISSUED earlier but newly REPORTED/PUBLISHED within this period are also acceptable.\n\n' +

    '[ COLLECTION CRITERIA — OR condition ]\n\n' +

    '▶ A. Collect if the ruling relates to ANY of the following products:\n' +
    '   Smartphone, mobile phone, tablet, smartwatch, smart glasses, Bluetooth earphones, earbuds,\n' +
    '   air conditioner, heat pump, chiller, oven, refrigerator, vacuum cleaner,\n' +
    '   TV, television, monitor, soundbar, interactive whiteboard (electronic whiteboard),\n' +
    '   air dresser (clothing care machine), shoe dresser (shoe care machine), camera,\n' +
    '   mock-up (display model / non-functional sample),\n' +
    '   5G base station, antenna, wireless communication equipment, X-ray equipment, medical imaging device\n\n' +

    '▶ B. Collect if ANY of the following companies is mentioned as applicant or related party:\n' +
    '   Apple, Samsung, LG Electronics, Huawei, Xiaomi, Oppo, Vivo,\n' +
    '   Whirlpool, General Electric, Haier\n\n' +

    '▶ C. Collect if the ruling involves a product classified under HS Chapter 39, 40, 42, 72, 73, 83, 84, 85, 90, 91 or 94\n\n' +

    '[ OUTPUT INSTRUCTIONS ]\n' +
    '1. Report ONLY rulings you actually found in the web search results. NEVER fabricate rulings, ruling numbers, dates, HS codes or URLs.\n' +
    '2. "url" field — CRITICAL: copy the EXACT URL of the web page where you found this ruling, taken directly from your search results. ' +
       'If you are not 100% sure of the exact URL, set "url" to "" (empty string). NEVER construct, guess or recall a URL from memory.\n' +
    '3. "url_source": the name of the website/publication the url belongs to (e.g., "CBP CROSS", "Lexology", "관세청 보도자료"). Empty if url is empty.\n' +
    '4. "importance": rate each ruling — "상" if a monitored company (Samsung, LG Electronics, Apple, etc.) is directly involved as applicant/party, ' +
       'or the classification of a core monitored product was changed or disputed; "중" if it concerns a monitored product category; ' +
       '"하" if relevant only by HS chapter. Use exactly one of: 상 / 중 / 하.\n' +
    '5. Return AT MOST 15 rulings, most recent first.\n' +
    '6. Output STRICTLY VALID JSON between the markers: double-quoted keys and strings, no trailing commas, no comments, ' +
       'escape internal double quotes as \\". Do not wrap the JSON in markdown code fences.\n' +
    '7. Briefly describe findings in natural language first, then output the JSON block.\n' +
    '8. Even if no results: output JSON_RESULT_START\\n[]\\nJSON_RESULT_END\n\n' +

    'JSON_RESULT_START\n' +
    '[\n' +
    '  {\n' +
    '    "country": "' + region.region + '",\n' +
    '    "source": "' + region.source + '",\n' +
    '    "ruling_number": "",\n' +
    '    "hs_code": "",\n' +
    '    "product_name": "Korean product name",\n' +
    '    "product_name_en": "English product name",\n' +
    '    "company": "",\n' +
    '    "title": "Korean title or key summary",\n' +
    '    "title_en": "English title or key summary",\n' +
    '    "summary": "Classification rationale in Korean (2-3 sentences)",\n' +
    '    "issue_date": "YYYY-MM-DD",\n' +
    '    "url": "",\n' +
    '    "url_source": "",\n' +
    '    "importance": "상 | 중 | 하"\n' +
    '  }\n' +
    ']\n' +
    'JSON_RESULT_END';

  var payload = {
    contents: [
      { role: 'user', parts: [{ text: userPrompt }] }
    ],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0, maxOutputTokens: 16384 }
  };

  return {
    url               : 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL_NAME + ':generateContent?key=' + apiKey,
    method            : 'post',
    contentType       : 'application/json',
    payload           : JSON.stringify(payload),
    muteHttpExceptions: true
  };
}

// ─── 응답 파싱 ───────────────────────────────────────────────────────────────

function _parseGeminiResponse(response, regionName) {
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) {
    Logger.log('[' + regionName + '] HTTP ' + code + ': ' + body.substring(0, 500));
    return [];
  }
  var parsed;
  try { parsed = JSON.parse(body); } catch (e) { return []; }

  var candidate = (parsed.candidates || [])[0];
  if (!candidate) return [];

  var finishReason = candidate.finishReason || '';
  if (finishReason === 'SAFETY' || finishReason === 'RECITATION') return [];
  if (finishReason === 'MAX_TOKENS') {
    Logger.log('[' + regionName + '] 경고: MAX_TOKENS로 응답 잘림 — 일부 결과 유실 가능');
  }

  var parts = (candidate.content && candidate.content.parts) ? candidate.content.parts : [];
  var textContent = parts.map(function(p) { return p.text || ''; }).join('\n').trim();
  if (!textContent) return [];

  var items = _robustJsonParse(textContent, regionName);

  // grounding 메타데이터에서 실제 검색 출처 URL을 추출해 url이 비어있는 항목에 보충
  try {
    _attachGroundingUrls(items, candidate);
  } catch (e) {
    Logger.log('[' + regionName + '] grounding URL 매핑 오류: ' + e.message);
  }

  return items;
}

/**
 * google_search grounding 메타데이터(groundingChunks/groundingSupports)에서
 * 실제 검색 출처 URL을 꺼내, url이 비어있는 항목에 매칭해 채운다.
 * 매칭 기준: groundingSupports의 텍스트 구간(segment.text)에
 * 해당 ruling의 ruling_number / 영문제목 / 영문물품명이 등장하는지 여부.
 * ※ chunk URI는 vertexaisearch 리다이렉트 URL이지만 클릭 시 실제 원문으로 이동한다.
 */
function _attachGroundingUrls(items, candidate) {
  if (!items || !items.length) return;
  var gm = candidate.groundingMetadata || candidate.grounding_metadata || {};
  var chunks = (gm.groundingChunks || gm.grounding_chunks || []).map(function(c) {
    var web = c.web || {};
    return { uri: web.uri || '', title: web.title || '' };
  });
  if (!chunks.length) return;
  var supports = gm.groundingSupports || gm.grounding_supports || [];

  items.forEach(function(item) {
    if (item.url && /^https?:\/\//i.test(item.url)) return; // 모델이 URL 제공 → 검증 단계에서 확인

    var keys = [item.ruling_number, item.title_en, item.product_name_en]
      .map(function(k) { return String(k || '').trim(); })
      .filter(function(k) { return k.length >= 4; });
    if (!keys.length) return;

    for (var i = 0; i < supports.length; i++) {
      var seg     = supports[i].segment || {};
      var segText = String(seg.text || '');
      if (!segText) continue;
      var hit = keys.some(function(k) { return segText.indexOf(k) !== -1; });
      if (!hit) continue;
      var idxList = supports[i].groundingChunkIndices || supports[i].grounding_chunk_indices || [];
      for (var j = 0; j < idxList.length; j++) {
        var chunk = chunks[idxList[j]];
        if (chunk && chunk.uri) {
          item.url        = chunk.uri;
          item.url_source = item.url_source || chunk.title || '검색 출처';
          return;
        }
      }
    }
  });
}

function _robustJsonParse(text, regionName) {
  // 1단계: 마커 추출
  try {
    var ms = text.indexOf('JSON_RESULT_START');
    var me = text.indexOf('JSON_RESULT_END');
    if (ms !== -1 && me > ms) {
      var between = text.substring(ms + 'JSON_RESULT_START'.length, me).trim();
      between = between.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      if (between === '' || between === '[]') return [];
      var d0 = JSON.parse(between);
      if (Array.isArray(d0)) return d0;
    }
  } catch (e) {}
  // 2단계: 직접 파싱
  try { var d1 = JSON.parse(text.trim()); if (Array.isArray(d1)) return d1; } catch (e) {}
  // 3단계: 마크다운 제거
  try {
    var cleaned = text.replace(/```json[\s\S]*?```/gi, function(m) {
      return m.replace(/```json\s*/i, '').replace(/```\s*$/, '');
    }).replace(/```/g, '').trim();
    var d2 = JSON.parse(cleaned);
    if (Array.isArray(d2)) return d2;
  } catch (e) {}
  // 4단계: 배열 패턴 추출
  try {
    var allMatches = [];
    var re = /\[[\s\S]*?\]/g; var m;
    while ((m = re.exec(text)) !== null) {
      try {
        var c = JSON.parse(m[0]);
        if (Array.isArray(c) && c.length > 0 && typeof c[0] === 'object') allMatches.push(c);
      } catch (e) {}
    }
    if (allMatches.length > 0) {
      allMatches.sort(function(a, b) { return b.length - a.length; });
      return allMatches[0];
    }
  } catch (e) {}
  // 5단계: 첫[~마지막] 범위
  try {
    var s = text.indexOf('['); var e = text.lastIndexOf(']');
    if (s !== -1 && e > s) { var d4 = JSON.parse(text.substring(s, e + 1)); if (Array.isArray(d4)) return d4; }
  } catch (e) {}
  // 6단계: 자연어 "결과 없음" 감지
  var noResult = ['찾지 못했', '없습니다', '확인되지 않', '발견되지 않', 'no ruling', 'not found', 'no results', 'could not find', 'no new ruling'];
  var low = text.toLowerCase();
  if (noResult.some(function(p) { return low.indexOf(p) !== -1; })) return [];

  Logger.log('[' + regionName + '] JSON 복구 실패: ' + text.substring(0, 300));
  return [];
}

// ─── 동향DB 저장 ─────────────────────────────────────────────────────────────

var DB_HEADERS = ['수집일시', '조회기간', '국가', '기관', 'Ruling번호', 'HS코드',
                  '물품명(KO)', '물품명(EN)', '기업명', '제목(KO)', '제목(EN)', '주요내용',
                  '게시일', 'URL', '카테고리', 'URL상태', 'URL출처', '중요도'];

function _saveToSheet(results, dateRangeStr) {
  var ss    = _getSpreadsheet();
  var sheet = ss.getSheetByName(DB_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(DB_SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(DB_HEADERS);
    sheet.getRange(1, 1, 1, DB_HEADERS.length)
      .setFontWeight('bold').setBackground(SHEET_HEADER_BG).setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < DB_HEADERS.length) {
    // 구버전(14컬럼) 시트 → 신규 컬럼 헤더 보강
    sheet.getRange(1, sheet.getLastColumn() + 1, 1, DB_HEADERS.length - sheet.getLastColumn())
      .setValues([DB_HEADERS.slice(sheet.getLastColumn())])
      .setFontWeight('bold').setBackground(SHEET_HEADER_BG).setFontColor('#ffffff');
  }
  if (!results.length) return;

  var now  = _fmtDateTime(new Date());
  var rows = results.map(function(r) {
    return [now, dateRangeStr, r.country || '', r.source || '', r.ruling_number || '', r.hs_code || '',
            r.product_name || '', r.product_name_en || '', r.company || '', r.title || '',
            r.title_en || '', r.summary || '', r.issue_date || '', r.url || '',
            r.category || '', r.url_status || '', r.url_source || '', r.importance || '중'];
  });
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);
  // 중요도 '상' 행 전체에 연한 빨간색 하이라이트
  for (var r = 0; r < rows.length; r++) {
    if (rows[r][17] === '상') {
      sheet.getRange(startRow + r, 1, 1, rows[0].length).setBackground(SHEET_HIGHLIGHT_BG);
    }
  }
  Logger.log('[saveToSheet] ' + rows.length + '건 저장 완료');
}

// ─── 수신자 조회 ─────────────────────────────────────────────────────────────

function _getRecipients() {
  var ss    = _getSpreadsheet();
  var sheet = ss.getSheetByName(RCPT_SHEET_NAME);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < data.length; i++) {
    var email  = String(data[i][0]).trim();
    var active = String(data[i][1]).trim().toUpperCase();
    if (email && active === 'Y') list.push(email);
  }
  return list;
}

// ─── 메일 발송 ───────────────────────────────────────────────────────────────

function _sendEmail(results, dateRangeStr, dupCount) {
  var recipients = _getRecipients();
  if (!recipients.length) return;
  var html    = _buildEmailHtml(results, dateRangeStr, dupCount || 0);
  var subject = '[HS Ruling 동향] 주간 유권해석 모니터링 | HS Classification Ruling Report (' + dateRangeStr + ')';
  recipients.forEach(function(email) {
    try {
      GmailApp.sendEmail(email, subject,
        '이 메일은 HTML 형식을 지원하는 메일 클라이언트에서 확인하세요.',
        { htmlBody: html, name: 'HS Ruling 모니터링 시스템' });
      Logger.log('[sendEmail] 발송: ' + email);
    } catch (e) {
      Logger.log('[sendEmail] 실패 (' + email + '): ' + e.message);
    }
  });
}

// ─── HTML 이메일 생성 ────────────────────────────────────────────────────────

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 뱃지 공통 UI (둥근 테두리, 패딩, 볼드) */
function _badge(text, fg, bg, border) {
  return '<span style="display:inline-block;padding:2px 8px;font-size:11px;font-weight:bold;color:' + fg +
         ';background-color:' + bg + ';border:1px solid ' + (border || bg) +
         ';border-radius:3px;margin-right:4px;">' + text + '</span>';
}

/** 아이템 카드: 좌측 중요도 컬러바 + 뱃지 + 타이틀 원문 링크(#15418c 언더라인) */
function _buildItemCard(item) {
  var imp      = (item.importance === '상' || item.importance === '하') ? item.importance : '중';
  var impColor = IMPORTANCE_COLORS[imp];
  var impBg    = IMPORTANCE_BG[imp];

  var badges = _badge('중요도 ' + imp, impColor, impBg, impColor);
  if (item.hs_code) badges += _badge('HS ' + _escapeHtml(item.hs_code), '#15418c', '#e8eef7', '#c9d6ea');
  if (item.company) badges += _badge(_escapeHtml(item.company), '#7b3000', '#fdf3e7', '#ecd9c0');
  if (item.ruling_number) {
    badges += '<span style="font-size:11px;color:#8a93a3;">[' + _escapeHtml(item.ruling_number) + ']</span>';
  }

  var titleKo   = _escapeHtml(item.title || item.product_name || '제목 없음');
  var titleEn   = _escapeHtml(item.title_en || item.product_name_en || '');
  var directUrl = _directOriginalUrl(item);
  var titleHtml = directUrl
    ? '<a href="' + _escapeHtml(directUrl) + '" target="_blank" style="color:#15418c;text-decoration:underline;">' + titleKo + '</a>'
    : '<span style="color:#1f2733;">' + titleKo + '</span>';

  return '<table width="100%" cellpadding="0" cellspacing="0" border="0" ' +
         'style="border:1px solid #dde1e7;background-color:#ffffff;">' +
    '<tr>' +
      '<td width="5" bgcolor="' + impColor + '" style="width:5px;background-color:' + impColor + ';font-size:0;line-height:0;">&nbsp;</td>' +
      '<td style="padding:12px 16px;">' +
        '<div style="margin-bottom:7px;">' + badges + '</div>' +
        '<div style="font-size:13px;font-weight:bold;line-height:1.5;">' + titleHtml + '</div>' +
        (titleEn ? '<div style="font-size:11px;color:#6b7686;margin-top:3px;line-height:1.5;">' + titleEn + '</div>' : '') +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:9px;">' +
          '<tr>' +
            '<td style="width:70px;font-size:11px;color:#8a93a3;font-weight:bold;padding-bottom:5px;vertical-align:top;">물품명</td>' +
            '<td style="font-size:12px;color:#333333;padding-bottom:5px;line-height:1.6;">' +
              _escapeHtml(item.product_name || '-') +
              (item.product_name_en ? '<span style="color:#999999;margin-left:6px;font-size:11px;">(' + _escapeHtml(item.product_name_en) + ')</span>' : '') +
            '</td>' +
          '</tr>' +
          '<tr>' +
            '<td style="width:70px;font-size:11px;color:#8a93a3;font-weight:bold;padding-bottom:5px;vertical-align:top;">주요내용</td>' +
            '<td style="font-size:12px;color:#333333;line-height:1.7;padding-bottom:5px;">' + _escapeHtml(item.summary || '-') + '</td>' +
          '</tr>' +
          '<tr>' +
            '<td style="width:70px;font-size:11px;color:#8a93a3;font-weight:bold;vertical-align:top;">게시일</td>' +
            '<td style="font-size:12px;color:#333333;">' + _escapeHtml(item.issue_date || '-') + '</td>' +
          '</tr>' +
        '</table>' +
        '<div style="border-top:1px solid #eef1f5;padding-top:9px;margin-top:10px;">' + _buildSourceLink(item) + '</div>' +
      '</td>' +
    '</tr>' +
  '</table>';
}

function _buildEmailHtml(results, dateRangeStr, dupCount) {
  var now        = _fmtDateTime(new Date());
  var totalCount = results.length;

  // ※ MONITORING_REGIONS의 category와 반드시 일치해야 함 (불일치 시 해당 카테고리 메일 누락)
  var CATEGORY_ORDER = ['동북아', '중국', '북미', '중남미', '인도', '유럽', '중동', '동남아', '아프리카', 'CIS', '글로벌'];
  var IMP_RANK = { '상': 0, '중': 1, '하': 2 };

  var byCat = {};
  results.forEach(function(r) {
    var cat = r.category || '기타'; var country = r.country || '기타';
    if (!byCat[cat])          byCat[cat] = {};
    if (!byCat[cat][country]) byCat[cat][country] = [];
    byCat[cat][country].push(r);
  });

  // CATEGORY_ORDER에 없는 카테고리도 누락 없이 뒤에 렌더링
  var renderOrder = CATEGORY_ORDER.slice();
  Object.keys(byCat).forEach(function(cat) {
    if (renderOrder.indexOf(cat) === -1) renderOrder.push(cat);
  });

  var statsBadges = '';
  renderOrder.forEach(function(cat) {
    if (!byCat[cat]) return;
    var cnt      = Object.keys(byCat[cat]).reduce(function(s, c) { return s + byCat[cat][c].length; }, 0);
    var catColor = CATEGORY_COLORS[cat] || '#546e7a';
    statsBadges +=
      '<td align="center" style="padding:6px 10px;">' +
        '<div style="font-size:17px;font-weight:bold;color:' + catColor + ';">' + cnt + '</div>' +
        '<div style="font-size:10px;color:#666666;margin-top:1px;">' + _escapeHtml(cat) + '</div>' +
      '</td>';
  });

  var cardHtml = '';
  if (totalCount === 0) {
    cardHtml =
      '<tr><td style="padding:40px 28px;text-align:center;">' +
        '<div style="background-color:#f4f6f8;padding:30px;border:1px dashed #c3ccd6;">' +
          '<p style="font-size:15px;color:#555555;margin:0 0 8px 0;font-weight:bold;">이번 기간 신규 Ruling 사례 없음</p>' +
          '<p style="font-size:13px;color:#888888;margin:0;">검색 기간 ' + dateRangeStr + ' (최근 ' + MONITORING_DAYS + '일) 내 조건에 맞는 신규 Ruling이 확인되지 않았습니다.' +
          (dupCount > 0 ? '<br>(기존 수집분과 중복된 ' + dupCount + '건은 제외되었습니다.)' : '') + '</p>' +
        '</div>' +
      '</td></tr>';
  } else {
    renderOrder.forEach(function(cat) {
      if (!byCat[cat]) return;
      var catColor = CATEGORY_COLORS[cat] || '#546e7a';
      var catCount = Object.keys(byCat[cat]).reduce(function(s, c) { return s + byCat[cat][c].length; }, 0);

      // 카테고리 섹션 헤더: 카테고리 테마 컬러 솔리드 배경 + 흰색 텍스트
      cardHtml +=
        '<tr><td style="padding:20px 28px 4px 28px;">' +
          '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
            '<td bgcolor="' + catColor + '" style="background-color:' + catColor + ';padding:9px 16px;">' +
              '<span style="font-size:14px;font-weight:bold;color:#ffffff;">' + _escapeHtml(cat) + '</span>' +
              '<span style="display:inline-block;margin-left:10px;background-color:#ffffff;color:' + catColor + ';' +
                   'font-size:11px;font-weight:bold;padding:1px 8px;border-radius:9px;">' + catCount + '건</span>' +
            '</td>' +
          '</tr></table>' +
        '</td></tr>';

      Object.keys(byCat[cat]).forEach(function(country) {
        var items = byCat[cat][country];
        // 중요도 상 → 중 → 하 순으로 정렬
        items.sort(function(a, b) {
          var ra = IMP_RANK[a.importance] !== undefined ? IMP_RANK[a.importance] : 1;
          var rb = IMP_RANK[b.importance] !== undefined ? IMP_RANK[b.importance] : 1;
          return ra - rb;
        });
        var source = items[0].source || '';

        cardHtml +=
          '<tr><td style="padding:10px 28px 4px 28px;">' +
            '<span style="font-size:13px;font-weight:bold;color:' + catColor + ';' +
                 'border-bottom:2px solid ' + catColor + ';padding-bottom:2px;">' + _escapeHtml(country) + '</span>' +
            '<span style="font-size:11px;color:#8a93a3;margin-left:8px;">' + _escapeHtml(source) + '</span>' +
            '<span style="display:inline-block;font-size:11px;color:#ffffff;background-color:' + catColor + ';' +
                 'border-radius:8px;padding:1px 7px;margin-left:6px;font-weight:bold;">' + items.length + '건</span>' +
          '</td></tr>';

        items.forEach(function(item) {
          cardHtml += '<tr><td style="padding:4px 28px 8px 28px;">' + _buildItemCard(item) + '</td></tr>';
        });
      });
    });
  }

  return '<!DOCTYPE html>' +
  '<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>' +
  '<body style="margin:0;padding:0;background-color:#eef1f5;">' +
  '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef1f5;"><tr><td align="center" style="padding:24px 0;">' +
  '<table width="680" cellpadding="0" cellspacing="0" border="0" ' +
         'style="width:680px;max-width:680px;background-color:#ffffff;border:1px solid #dde1e7;font-family:' + FONT_STACK + ';">' +

  // 헤더 (네이비 #14294a — bgcolor 속성 병기로 Outlook 호환)
  '<tr><td bgcolor="#14294a" style="padding:26px 28px;background-color:#14294a;">' +
    '<div style="color:#8fb3e8;font-size:11px;font-weight:bold;letter-spacing:2.5px;text-transform:uppercase;margin-bottom:6px;">Trade Compliance Intelligence</div>' +
    '<div style="color:#ffffff;font-size:21px;font-weight:bold;line-height:1.35;margin-bottom:3px;">HS Code 유권해석 주간 동향 보고서</div>' +
    '<div style="color:#b8cdf0;font-size:13px;line-height:1.5;margin-bottom:10px;">Weekly HS Classification Ruling Monitoring Report</div>' +
    '<div style="color:#b8cdf0;font-size:12px;line-height:1.6;">조회 기간&nbsp;' + dateRangeStr + '&nbsp;&nbsp;|&nbsp;&nbsp;발행일&nbsp;' + now + '</div>' +
  '</td></tr>' +

  // 수록 기준 안내 (연초록 배경 + 초록 상단 보더)
  '<tr><td bgcolor="#eaf6ee" style="padding:10px 28px;background-color:#eaf6ee;border-top:3px solid #2e8b57;border-bottom:1px solid #d6e9dd;">' +
    '<div style="font-size:12px;color:#1d4d33;line-height:1.7;">' +
      '<b>이번 기간 수집 현황</b>&nbsp;:&nbsp;신규 <b>' + totalCount + '</b>건' +
      (dupCount > 0 ? ' <span style="color:#5d7a68;">(중복 ' + dupCount + '건 제외)</span>' : '') +
      '&nbsp;&nbsp;|&nbsp;&nbsp;' + MONITORING_REGIONS.length + '개 검색 패스 · 최근 ' + MONITORING_DAYS + '일' +
      '&nbsp;&nbsp;|&nbsp;&nbsp;중요도&nbsp;' +
      '<b style="color:#c62828;">상</b>(모니터링 기업 직접 관련)&nbsp;·&nbsp;' +
      '<b style="color:#ef6c00;">중</b>(모니터링 품목)&nbsp;·&nbsp;' +
      '<b style="color:#2e7d32;">하</b>(HS류 관련)' +
    '</div>' +
  '</td></tr>' +

  (totalCount > 0
    ? '<tr><td style="padding:14px 28px 8px 28px;">' +
        '<div style="font-size:10px;font-weight:bold;color:#8a93a3;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;">카테고리별 수집 현황</div>' +
        '<table cellpadding="0" cellspacing="0" border="0"><tr>' + statsBadges + '</tr></table>' +
      '</td></tr>'
    : '') +

  // 재발송 안내 배너
  '<tr><td style="padding:10px 28px 4px 28px;">' +
    '<div style="background-color:#fff8e1;border:1px solid #ffe082;padding:9px 14px;font-size:12px;color:#795548;">' +
      '<b>재발송 요청</b>: 이 메일에 "<b>HS 요청</b>"이라고 답장하시면 최신 리포트를 즉시 재발송해 드립니다.' +
    '</div>' +
  '</td></tr>' +

  '<tr><td style="padding:14px 28px 8px 28px;border-top:1px solid #eef1f5;">' +
    '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td width="48%" style="vertical-align:top;padding-right:8px;">' +
        '<div style="background-color:#f4f6f8;border:1px solid #e3e7ec;padding:11px 14px;">' +
          '<div style="font-size:10px;font-weight:bold;color:#8a93a3;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">모니터링 품목</div>' +
          '<div style="font-size:12px;color:#333333;line-height:1.9;">' +
            '스마트폰 / 태블릿 / 스마트워치 / 블루투스 이어폰<br>' +
            '에어컨 / 오븐 / 냉장고 / 청소기 / TV / 모니터 / 사운드바<br>' +
            '스마트글래스 / 히트펌프 / 칠러(Chiller) / 전자칠판 / 에어드레서<br>' +
            '슈드레서 / 카메라 / 목업(mock-up, non-functional sample)<br>' +
            '5G 기지국 / 안테나 / X-ray 의료기기 / HS 39, 40, 42, 72, 73, 83, 84, 85, 90, 91, 94류 전체' +
          '</div>' +
        '</div>' +
      '</td>' +
      '<td width="52%" style="vertical-align:top;padding-left:8px;">' +
        '<div style="background-color:#f4f6f8;border:1px solid #e3e7ec;padding:11px 14px;">' +
          '<div style="font-size:10px;font-weight:bold;color:#8a93a3;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">모니터링 기업</div>' +
          '<div style="font-size:12px;color:#333333;line-height:1.9;">' +
            'Apple / Samsung Electronics / LG Electronics<br>' +
            'Huawei / Xiaomi / Oppo / Vivo<br>' +
            'Whirlpool / General Electric / Haier' +
          '</div>' +
        '</div>' +
      '</td>' +
    '</tr></table>' +
  '</td></tr>' +

  cardHtml +

  // 푸터 (네이비 #14294a)
  '<tr><td bgcolor="#14294a" style="padding:16px 28px;text-align:center;background-color:#14294a;">' +
    '<div style="color:#8fb3e8;font-size:11px;line-height:1.8;">' +
      'Gemini AI 기반 자동 모니터링 시스템 &nbsp;|&nbsp; 매주 월요일 오전 9시 KST 정기 발행 (최근 ' + MONITORING_DAYS + '일)<br>' +
      '원문 보기 링크는 AI 검색 출처 기반으로 자동 수집·검증되며, 부정확할 수 있으니 중요 사안은 반드시 공식 DB에서 재확인하세요.' +
    '</div>' +
  '</td></tr>' +

  '</table></td></tr></table></body></html>';
}

// ─── 트리거 설정 ─────────────────────────────────────────────────────────────

/**
 * 구글 시트가 열린 상태에서 이 함수를 1회 실행하세요.
 *  - Spreadsheet ID 자동 저장
 *  - 매주 월요일 09:00 KST 정기 실행 트리거
 *  - 15분마다 "HS 요청" 메일 폴링 트리거
 */
function setupAllTriggers() {
  _saveSpreadsheetId();

  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runHSRulingMonitor' || fn === 'checkHsRequestEmails') {
      ScriptApp.deleteTrigger(t);
      Logger.log('[setupAllTriggers] 기존 트리거 삭제: ' + fn);
    }
  });

  ScriptApp.newTrigger('runHSRulingMonitor')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .nearMinute(0)
    .inTimezone('Asia/Seoul')
    .create();
  Logger.log('[setupAllTriggers] 정기 실행 트리거 등록: 매주 월요일 09:00 KST');

  ScriptApp.newTrigger('checkHsRequestEmails')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('[setupAllTriggers] 이메일 폴링 트리거 등록: 15분마다');
}

// 기존 호환성 유지
function setupWeeklyTrigger() { setupAllTriggers(); }

// ─── 수동 재발송 ─────────────────────────────────────────────────────────────

function resendLastReport() {
  var lastData = _loadLastReportData();
  if (!lastData.results.length) { Logger.log('[resendLastReport] 저장 데이터 없음'); return; }
  _sendEmail(lastData.results, lastData.dateRange, 0);
  Logger.log('[resendLastReport] ' + lastData.results.length + '건 재발송 완료');
}

// ─── 진단 유틸리티 ───────────────────────────────────────────────────────────

/**
 * 사용 가능한 Gemini 모델명 확인용 — 실행 후 로그(보기 > 실행 기록)에서 확인.
 * MODEL_NAME이 유효하지 않으면 모든 호출이 404로 실패하므로, 최초 설정 시 1회 실행 권장.
 */
function listAvailableModels() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('[오류] GEMINI_API_KEY가 설정되지 않았습니다.');
  var resp = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey,
    { muteHttpExceptions: true }
  );
  var body = JSON.parse(resp.getContentText());
  (body.models || []).forEach(function(m) {
    if ((m.supportedGenerationMethods || []).indexOf('generateContent') !== -1) {
      Logger.log(m.name + '  —  ' + (m.displayName || ''));
    }
  });
}

/**
 * CBP CROSS API 실제 응답 구조 확인용 — 최초 설정 시 1회 실행 권장.
 * 응답 필드명(rulingNumber/subject/tariffs/rulingDate/category 등)이 다르면
 * 로그를 보고 _collectCbpRulings의 폴백 필드명을 조정하세요.
 */
function testCbpApi() {
  var resp = UrlFetchApp.fetch(
    'https://rulings.cbp.gov/api/search?term=smartphone&collection=ALL&sortBy=DATE_DESC&pageSize=3&page=1',
    { method: 'get', muteHttpExceptions: true, headers: { 'Accept': 'application/json' } }
  );
  Logger.log('[testCbpApi] HTTP ' + resp.getResponseCode());
  var body = resp.getContentText();
  Logger.log('[testCbpApi] 최상위 키: ' + Object.keys(JSON.parse(body || '{}')).join(', '));
  Logger.log(body.substring(0, 2500));

  var items = _collectCbpRulings(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
  Logger.log('[testCbpApi] 파싱 결과 ' + items.length + '건 (최근 1년 smartphone 외 전체 검색어)');
  items.slice(0, 5).forEach(function(it) {
    Logger.log('  - [' + it.ruling_number + '] ' + it.title_en + ' | HS ' + (it.hs_code || '-') +
               ' | ' + it.issue_date + ' | ' + it.url);
  });
}

/** Federal Register API 응답 구조 확인용 */
function testFederalRegister() {
  var items = _collectFederalRegister(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  Logger.log('[testFederalRegister] ' + items.length + '건');
  items.slice(0, 5).forEach(function(it) {
    Logger.log('  - ' + it.title_en + ' | ' + it.issue_date + ' | ' + it.url);
  });
}

/**
 * 단일 지역 테스트 실행 — 프롬프트/파싱/URL 추출 동작 확인용.
 * regionIndex: MONITORING_REGIONS 배열 인덱스 (기본 3 = 미국)
 */
function testSingleRegion(regionIndex) {
  var idx    = (regionIndex == null) ? 3 : regionIndex;
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('[오류] GEMINI_API_KEY가 설정되지 않았습니다.');

  var today        = new Date();
  var periodStart  = new Date(today.getTime() - MONITORING_DAYS * 24 * 60 * 60 * 1000);
  var dateRangeStr = _fmtDate(periodStart) + ' ~ ' + _fmtDate(today);

  var region = MONITORING_REGIONS[idx];
  var req    = _buildRequest(region, apiKey, dateRangeStr, today.getFullYear());
  var resp   = UrlFetchApp.fetch(req.url, req);
  var items  = _parseGeminiResponse(resp, region.region);
  _verifyItemUrls(items);

  Logger.log('[test] ' + region.region + ' → ' + items.length + '건');
  items.forEach(function(it) {
    Logger.log('  - [' + (it.ruling_number || '번호없음') + '] ' + (it.title_en || it.title) +
               ' | url=' + (it.url || '없음') + ' (' + (it.url_status || '미검증') + ')');
  });
}

// ─── 유틸리티 ────────────────────────────────────────────────────────────────

function _fmtDate(date) {
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}
function _fmtDateTime(date) {
  var h  = String(date.getHours()).padStart(2, '0');
  var mi = String(date.getMinutes()).padStart(2, '0');
  return _fmtDate(date) + ' ' + h + ':' + mi;
}
