/**
 * HS Code 유권해석(Ruling) 주간 모니터링 시스템
 * ─────────────────────────────────────────────
 * [변경 이력]
 * v4.3 (코드 리뷰 반영 — 버그/성능/보안/가독성 전면 수정)
 *  - [성능/핵심] 6분 실행제한으로 인한 전체 유실 방지:
 *      · 시간예산(EXEC_BUDGET_MS) 도입 — 재시도/URL검증이 예산을 넘기면 조기 중단하고
 *        저장(_saveToSheet)·발송(_sendEmail)은 항상 실행되도록 파이프라인 재구성
 *      · URL 검증을 항목별 순차 리다이렉트 추적(최대 300회 순차 호출)에서 라운드 단위
 *        UrlFetchApp.fetchAll() 배치 처리(O(홉수) 호출)로 재작성
 *      · Gemini 재시도: 대량 실패(과반) 시 재시도 자체를 생략(모델명/쿼터 문제로 판단),
 *        재시도 루프도 시간예산 확인 후 조기 종료
 *      · CBP CROSS 수집도 배치+재시도 재사용(_fetchAllInBatches)으로 전환 — 조용히 0건 되는 문제 완화
 *  - [핵심] EU 직수집 결과가 스코프 필터에 전부 걸려 0건 처리되던 문제 수정:
 *      공식 API/DB 직수집 항목(provenance='공식')은 수집 시점에 명시적으로 태깅하고
 *      스코프 필터를 건너뛰도록 변경 (기존엔 출처 문자열 정규식으로 provenance를 추론해
 *      EU Gemini 패스까지 '공식'으로 오분류되던 문제도 함께 해결)
 *  - [버그] 한국어 등 현지어 전용 Gemini 결과가 영어 키워드만으로 스코프 매칭에서 탈락하던 문제 수정
 *      (MONITORED_COMPANIES_LOCAL / MONITORED_PRODUCT_TERMS_LOCAL 추가)
 *  - [버그] 중복 제거 오탐 수정: ruling_number가 있으면 그것만으로 판정(N-키 단독) —
 *      제목이 정형화된 문구라 서로 다른 번호의 룰링이 영문제목 접두어로 오탐 제거되던 문제 해결.
 *      번호가 없는 항목은 국가+HS코드+게시일+한글제목 복합키를 추가해 dedup 우회 방지
 *  - [버그] 재발송(_loadLastReportData)이 시트의 Date 객체 참조비교(===) 실패로 1건만 반환하던 문제 수정
 *  - [버그] 오래된 룰링 제외(STALE_RULING_MONTHS) 필터가 "과거 발행·신규 보도 허용" 프롬프트 지시와
 *      모순되어 정상 수집분을 제외하던 문제 — 필터 제거
 *  - [버그] isGroup 지역 country 필드에 복합 국가 라벨이 그대로 반향되던 문제 수정 —
 *      템플릿 시딩값을 단일 국가 예시로 변경 + 런타임에 countries 목록과 대조해 보정
 *  - [버그] 중요도 '상'의 미검증 예외가 company 필드 유무에 따라 경로별로 다르게 동작하던 문제 수정
 *      (모델 루브릭상 '상' 자체가 이미 요건을 충족하므로 company 재확인 제거)
 *  - [보안] GEMINI_API_KEY를 URL 쿼리스트링(?key=) 대신 x-goog-api-key 헤더로 전달
 *  - [보안] URL 리다이렉트 추적 시 validateHttpsCertificates:false(TLS 검증 비활성) 제거
 *  - [보안] "HS 요청" 자동 재발송 시 발신자를 수신자 화이트리스트와 재대조 후 발송
 *      (스푸핑된 From 또는 화이트리스트 스레드에 끼어든 제3자에게 발송되던 문제 차단)
 *  - [가독성] 회사 목록을 COMPANY_DISPLAY_NAMES 단일 소스로 통합 (General Electric 누락 버그 수정)
 *  - [가독성] 이메일 CATEGORY_ORDER를 MONITORING_REGIONS에서 자동 파생 — 카테고리 누락 버그 클래스 원천 차단
 *  - [가독성] url_status 매직스트링 'OK(API)'를 URL_STATUS_OFFICIAL 상수로 통일
 *  - _fetchAllInBatches 재시도 시 UrlFetchApp.fetch(url, paramsWithUrlKey) 오작동 가능성 수정
 *    (payload 객체에서 url 키를 제외하고 전달)
 *
 * v4.2 (정확성·필터 레이어 + EU 직수집 강화)
 *  - [정확성] 수집·검증 후 정확성/필터 레이어(_refineResults) 신설:
 *      · 스코프 필터(_scopeMatch): 회사/제품군/HS류(MONITORED_HS_CHAPTERS) 중 하나라도 매칭해야 채택 + 매칭근거 태깅
 *        → 죽어 있던 MONITORED_HS_CHAPTERS를 HS코드 정규화(_normalizeHs) 후 실제 작동
 *      · 미검증 AI검색 항목(원문 URL 없음/접속실패)은 제외 (DROP_UNVERIFIED_AI) — 단 회사 직접 '상'은 예외 유지
 *      · 너무 과거(STALE_RULING_MONTHS) 게시일 항목 제외
 *      · 출처유형(공식/AI검색) 판정 → 메일 배지 + 시트 컬럼으로 신뢰도 명시
 *  - [EU 강화] EU 분류규칙 직수집(EUR-Lex/CELLAR SPARQL, 무인증) — CELEX 영구 URL.
 *      EU Gemini 패스를 2개(분류규칙·CJEU / EBTI·회원국 BTI)로 분리해 recall 확대.
 *      OFFICIAL_DB EU 검색링크를 EUR-Lex 쿼리형으로 개선. testEuEurlex() 진단 추가.
 *  - 동향DB 컬럼 추가: 출처유형 / HS류 / 매칭근거
 *
 * v4.1 (미국 결과 정밀화 — 분류 룰링 사례만)
 *  - 미국 수집에 일반 관세정책(관세율·반덤핑·301/232조·쿼터·수수료·FTA/원산지 등)이 섞이던 문제 수정:
 *      · CBP CROSS: category 필드가 비면 전부 통과하던 버그 수정 → HTS 분류번호 보유 + 비분류(평가/원산지/마킹) 제목 제외
 *      · Federal Register: 정책 고시 발행물 특성상 노이즈가 많아, '분류 룰링레터 수정/철회 고시'만 채택하고
 *        정책 키워드(POLICY_EXCLUDE_TERMS)는 제외
 *      · 미국 Gemini 패스: Section 301 등 정책 항목 제거 → CIT/CAFC '품목분류 판결'만 수집
 *      · 전 지역 Gemini 프롬프트에 [MANDATORY GATE] 추가 — 제품 분류 결정/판결만, 일반 관세정책은 강제 제외
 *
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
var URL_VERIFY_MAX      = 60;
var URL_VERIFY_MAX_HOPS = 5;      // 리다이렉트 추적 최대 홉 수 (라운드 단위 배치 처리)

// ─── 실행시간 예산 (Apps Script 6분 하드 한도 대응) ──────────────────────────
// runHSRulingMonitor() 시작 시각을 기록해두고, 검증/재시도처럼 시간이 걸리는 단계에서
// 남은 예산을 확인해 조기 종료 → 저장(_saveToSheet)·발송(_sendEmail)은 항상 실행되도록 보장.
var EXEC_START_MS          = null;
var EXEC_BUDGET_MS         = 270000; // 4.5분 — 이후로는 검증/재시도를 중단하고 저장·발송으로 넘어감
var RETRY_TIME_RESERVE_MS  = 60000;  // 재시도 단계: 남은 예산 60초 미만이면 생략
var VERIFY_TIME_RESERVE_MS = 20000;  // URL 검증: 남은 예산 20초 미만이면 중단

function _elapsedMs() { return EXEC_START_MS ? (new Date().getTime() - EXEC_START_MS) : 0; }
function _budgetLeft() { return EXEC_BUDGET_MS - _elapsedMs(); }

// url_status 매직스트링 통일 (여러 곳에서 참조 — 오타로 인한 분류 오류 방지)
var URL_STATUS_OFFICIAL = 'OK(API)';   // 공식 API/DB 직수집 — 접속 검증 불필요, 영구 URL 보장

// ─── 공식 API 직접 수집 (하이브리드) ─────────────────────────────────────────
// API가 있는 소스는 직접 수집 → 전수에 가까운 수집 + 영구 원문 URL 확보.
// 나머지 국가는 Gemini google_search 그라운딩으로 보완.
var USE_CBP_API          = true;   // 美 CBP CROSS 분류 결정 JSON API (무인증)
var USE_FEDERAL_REGISTER = true;   // 美 Federal Register API (무인증) — CBP 분류 고시/결정
var USE_EU_EURLEX        = true;   // EU EUR-Lex(CELLAR SPARQL) 분류규칙 직수집 (무인증, best-effort)
var CBP_PAGE_SIZE        = 50;     // CBP 검색어당 최대 조회 건수 (최신순)
var CBP_MAX_PER_TERM     = 50;     // 검색어당 기간 내 채택 상한
var EURLEX_MAX           = 80;     // EU 분류규칙 최대 수집 건수

// ─── 정확성/출처 정책 (1단계) ───────────────────────────────────────────────
// 검증되지 않은 AI검색 항목(원문 URL 없음/접속실패)은 제외한다. 단, 중요도 '상'은 예외로 유지
// (모델 루브릭상 '상'은 이미 "모니터링 기업 직접 관련" 또는 "핵심 품목 분류 변경/분쟁"을 요구하므로
//  company 필드가 별도로 채워지지 않았다는 이유로 예외를 거부하지 않는다).
var DROP_UNVERIFIED_AI   = true;
// ※ v4.2의 STALE_RULING_MONTHS(오래된 룰링 제외) 필터는 v4.3에서 제거함 —
//   프롬프트가 명시적으로 "발행은 과거지만 이번 기간에 새로 보도/공개된 룰링도 허용"이라 지시하는 것과
//   정면으로 모순되어 일본 事前教示 등 공개 지연이 흔한 지역의 정상 수집 건을 잘못 제외시켰다.

// CBP CROSS 검색어 — 모니터링 품목/기업 (검색어 1개 = API 1회 호출)
var CBP_SEARCH_TERMS = [
  'smartphone', 'mobile phone', 'tablet computer', 'smartwatch', 'smart glasses',
  'wireless earphones', 'earbuds', 'air conditioner', 'heat pump', 'chiller',
  'oven', 'refrigerator', 'vacuum cleaner', 'television', 'monitor', 'soundbar',
  'interactive whiteboard', 'clothing care', 'camera', 'base station', 'antenna',
  'X-ray', 'Samsung', 'LG Electronics', 'Apple', 'Huawei', 'Xiaomi', 'Whirlpool', 'Haier'
];

// ─── 자동 중요도/필터 기준 (모델 없이 수집되는 API 항목용) ───────────────────
// 회사명은 여기 한 곳에서만 관리 (표시용 대문자 표기 ↔ 매칭용 소문자 키를 단일 소스로 통합).
// _detectCompany()가 이 맵을 그대로 사용하므로, 여기 추가하면 검색/필터/뱃지 표시가 자동으로 일치한다.
var COMPANY_DISPLAY_NAMES = {
  'apple': 'Apple', 'samsung': 'Samsung', 'lg electronics': 'LG Electronics',
  'huawei': 'Huawei', 'xiaomi': 'Xiaomi', 'oppo': 'Oppo', 'vivo': 'Vivo',
  'whirlpool': 'Whirlpool', 'general electric': 'General Electric', 'haier': 'Haier'
};
var MONITORED_COMPANIES = Object.keys(COMPANY_DISPLAY_NAMES);

// 한국어/현지어 Gemini 결과(특히 한국·일본·중국 등 로컬 소스)가 영어 키워드만으로는 스코프 매칭에서
// 탈락하는 문제 보완 — _scopeMatch()에서 MONITORED_COMPANIES/PRODUCT_TERMS와 함께 사용.
var MONITORED_COMPANIES_LOCAL = ['삼성전자', '삼성', 'lg전자', 'lg 전자', '엘지전자', '애플', '화웨이', '샤오미', '오포', '비보', '월풀', '하이얼'];
var MONITORED_PRODUCT_TERMS_LOCAL = ['스마트폰', '휴대폰', '태블릿', '스마트워치', '이어폰', '이어버드', '헤드폰',
  '에어컨', '히트펌프', '칠러', '오븐', '냉장고', '청소기', '텔레비전', '모니터', '사운드바', '전자칠판',
  '에어드레서', '슈드레서', '카메라', '목업', '기지국', '안테나', '엑스레이'];

var MONITORED_PRODUCT_TERMS = ['smartphone', 'mobile phone', 'cellular', 'tablet', 'smartwatch',
  'smart glass', 'earphone', 'earbud', 'headphone', 'air conditioner', 'heat pump', 'chiller',
  'oven', 'refrigerator', 'vacuum', 'television', 'tv ', 'monitor', 'soundbar', 'whiteboard',
  'clothing care', 'shoe care', 'camera', 'mock-up', 'base station', 'antenna', 'wireless',
  'x-ray', 'medical imaging'];
var MONITORED_HS_CHAPTERS = ['39', '40', '42', '72', '73', '83', '84', '85', '90', '91', '94'];

// HS 품목분류 '결정/룰링'이 아닌 일반 관세정책·통상조치를 걸러내기 위한 제외 키워드.
// (관세율 변경·반덤핑/상계관세·세이프가드·232/301조·쿼터·수수료·환급·원산지/FTA·통계 등)
var POLICY_EXCLUDE_TERMS = [
  'antidumping', 'anti-dumping', 'countervailing', 'safeguard', 'section 301', 'section 232',
  'section 201', 'duty rate', 'tariff rate', 'rate of duty', 'tariff increase', 'tariff hike',
  'quota', 'tariff-rate quota', 'trq', 'cobra fee', 'user fee', 'mpf ', 'drawback',
  'de minimis', 'reciprocal tariff', 'ieepa', 'trade agreement', 'free trade', 'fta ',
  'rules of origin', 'country of origin marking', 'forced labor', 'uflpa', 'sanction',
  'export control', 'aphis', 'statistical', 'comment period', 'meeting', 'COAC'
];

// FedReg에서 '분류 룰링 사례'로 인정할 신호어 (룰링레터 수정/철회 고시 등)
var FEDREG_RULING_SIGNALS = ['ruling letter', 'classification ruling', 'revocation of', 'modification of',
  'revoke', 'modify', 'tariff classification of', 'reconsideration of'];

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
    source  : 'U.S. CIT/CAFC 품목분류 판결 (CROSS는 API 직수집)',
    // ※ 일상적 CROSS 결정은 CBP API로 전수 수집하므로, 여기서는 그 外 '분류 판결'만 보완
    prompt  : 'Search ONLY for actual HS tariff CLASSIFICATION ruling cases or court decisions from the US in the last {DAYS} days, EXCLUDING routine CBP CROSS ruling letters (collected separately). ' +
              'Collect ONLY: Court of International Trade (CIT) or Federal Circuit (CAFC) JUDGMENTS that decide the correct HTSUS classification of a specific product, and formal classification disputes that turn on which HTS heading applies. ' +
              'STRICTLY EXCLUDE general trade-policy items: Section 301/232/201 actions, tariff-rate or duty-rate changes, antidumping/countervailing duties, quotas, fees, FTA/origin, sanctions, export controls. ' +
              'Look in: cit.uscourts.gov, cafc.uscourts.gov, Sandler Travis, law firm trade alerts, Lexology, Law360. ' +
              'Keywords: "CIT tariff classification decision" "CAFC HTSUS classification holding" "proper classification under heading" "smartphone" "air conditioner" "Samsung" "Apple" "LG" "{YEAR}". ' +
              'Each result MUST be about how a specific product is classified (an HTS heading/subheading determination), not a tariff-rate or policy measure.'
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

  // ── 유럽 ── (EU는 EUR-Lex 분류규칙을 API로도 직수집하며, Gemini는 2개 보완 패스로 분리)
  {
    category: '유럽', region: 'EU',
    source  : 'EU 분류규칙(Official Journal) / CJEU 판결',
    prompt  : 'Search for EU HS tariff CLASSIFICATION acts published in the last {DAYS} days. ' +
              'Focus on: (1) Commission Implementing Regulations "concerning the classification of certain goods in the Combined Nomenclature" in the EU Official Journal (find them on EUR-Lex, eur-lex.europa.eu), and ' +
              '(2) Court of Justice of the EU (CJEU) judgments deciding the CN/HS classification of a specific product (curia.europa.eu). ' +
              'For each, capture the CELEX number (e.g. 32026Rxxxx) or case number (e.g. C-123/25) as ruling_number, the EUR-Lex/CURIA URL, the CN code, and the product. ' +
              'Keywords: "classification of certain goods in the Combined Nomenclature" "Commission Implementing Regulation (EU) classification" "CJEU tariff classification judgment" "smartphone" "air conditioner" "monitor" "Samsung" "Apple" "{YEAR}".'
  },
  {
    category: '유럽', region: 'EU(BTI)', countryName: 'EU',
    source  : 'EU EBTI / 회원국 BTI (Binding Tariff Information)',
    prompt  : 'Search for newly issued EU Binding Tariff Information (BTI/EBTI) rulings and EU member-state customs classification decisions in the last {DAYS} days. ' +
              'Look in: the EU EBTI public database (ec.europa.eu/taxation_customs/dds2/ebti), German (Verbindliche Zolltarifauskunft / vZTA), French, Dutch, and other member-state customs BTI rulings, and EU customs trade press. ' +
              'For each, capture the BTI reference (e.g. DEBTIxxxxx) as ruling_number, the CN code, the product, and the issuing member state (put it in title_en, keep country as EU). ' +
              'Keywords: "Binding Tariff Information" "verbindliche Zolltarifauskunft" "EBTI reference" "renseignement tarifaire contraignant" "smartphone" "earbuds" "air conditioner" "Samsung" "Apple" "{YEAR}".'
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
  'EU'              : { agency: 'EUR-Lex / EBTI',         domain: 'eur-lex.europa.eu',
                        searchUrl: 'https://eur-lex.europa.eu/search.html?type=quick&lang=en&text={Q}' },
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
  EXEC_START_MS = new Date().getTime();  // 시간예산 기준점 — 검증/재시도 단계에서 남은 실행시간 확인용

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
  if (USE_EU_EURLEX) {
    try {
      var eu = _collectEuClassificationRegs(periodStart);
      allResults.push.apply(allResults, eu);
      Logger.log('[EU EUR-Lex API] ' + eu.length + '건 수집');
    } catch (e) { Logger.log('[EU EUR-Lex API] 오류: ' + e.message); }
  }

  responses.forEach(function(resp, i) {
    var region = MONITORING_REGIONS[i];
    if (!resp) { Logger.log('[' + region.region + '] 응답 없음(재시도 실패)'); return; }
    try {
      var items = _parseGeminiResponse(resp, region.region);
      items.forEach(function(item) {
        item.category   = region.category;
        item.provenance = 'AI검색';  // Gemini 그라운딩 결과 — 수집 시점에 명시(출처 문자열 정규식 추론 안 함)
        if (!region.isGroup) {
          item.country = region.countryName || region.region;
        } else {
          var countries = region.countries || [];
          var returned  = String(item.country || '').trim();
          if (countries.length && countries.indexOf(returned) === -1) {
            // 모델이 복합 라벨을 그대로 반향했거나 국가명을 비웠을 경우 보정
            var matched = countries.filter(function(c) { return returned.indexOf(c) !== -1; });
            item.country = matched.length ? matched[0] : countries[0];
          }
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

  // 1차: 스코프(회사/제품/HS류) 필터 — 네트워크 호출 없이 먼저 걸러 URL 검증 대상을 줄인다.
  var scoped = _scopeFilterAndTag(deduped, periodStart);

  // 2차: URL 실제 접속 검증 (시간예산 내에서 라운드 배치 처리 — 예산 소진 시 조기 중단, 이후 단계는 항상 실행)
  _verifyItemUrls(scoped);

  // 3차: 미검증 AI검색 항목 제외 (검증 결과 확정 후 적용)
  var refined = _applyUnverifiedDrop(scoped);

  _saveToSheet(refined, dateRangeStr);
  _sendEmail(refined, dateRangeStr, dupCount);

  Logger.log('[HSRulingMonitor] 완료. 발송 ' + refined.length + '건 / 수집 ' + deduped.length +
             '건 / 중복 제외 ' + dupCount + '건 / 소요시간 ' + Math.round(_elapsedMs() / 1000) + '초.');
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

  // 실패 인덱스 수집
  var failedIdx = [];
  for (var i = 0; i < responses.length; i++) {
    var code = responses[i] ? responses[i].getResponseCode() : 0;
    if (code === 200) continue;
    if (code !== 429 && code < 500 && responses[i]) continue; // 4xx(429 제외)는 재시도 무의미
    failedIdx.push(i);
  }

  // 대량 실패(과반 또는 5건 초과)는 모델명 오류/쿼터 소진 등 구조적 문제로 보고 개별 재시도를 생략
  // (재시도해도 성공 못할 요청에 10~20초씩 sleep을 쌓으면 6분 실행제한을 넘겨 그 주 수집이 전부 유실됨)
  var massFailure = failedIdx.length > Math.max(5, Math.floor(requests.length / 2));
  if (massFailure) {
    Logger.log('[fetchAll] 대량 실패 감지(' + failedIdx.length + '/' + requests.length +
               ') — 재시도 생략. MODEL_NAME 또는 API 쿼터를 확인하세요.');
    return responses;
  }

  failedIdx.forEach(function(i) {
    if (_budgetLeft() < RETRY_TIME_RESERVE_MS) return; // 남은 실행시간 부족 → 재시도 생략

    var req    = requests[i];
    var params = {};
    Object.keys(req).forEach(function(k) { if (k !== 'url') params[k] = req[k]; });

    for (var attempt = 1; attempt <= API_MAX_RETRY; attempt++) {
      if (_budgetLeft() < RETRY_TIME_RESERVE_MS) break;
      Utilities.sleep(Math.pow(2, attempt) * 5000); // 10초, 20초
      try {
        var retry = UrlFetchApp.fetch(req.url, params);
        responses[i] = retry;
        if (retry.getResponseCode() === 200) {
          Logger.log('[fetchAll] 재시도 성공 (idx ' + i + ', attempt ' + attempt + ')');
          break;
        }
      } catch (e) {
        Logger.log('[fetchAll] 재시도 실패 (idx ' + i + '): ' + e.message);
      }
    }
  });
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

  // 배치 분할 + 429/5xx 재시도 재사용 (원래 단일 fetchAll은 재시도 없이 조용히 전체 실패했음)
  var resps = _fetchAllInBatches(reqs);

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

      var tariffs = r.tariffs || r.tariff || r.htsNumbers || r.htsnumbers || [];
      if (!Array.isArray(tariffs)) tariffs = tariffs ? [tariffs] : [];
      var hs = tariffs.length ? String(tariffs[0]) : '';
      var subject = r.subject || r.title || r.rulingReference || r.description || '';

      // ── HS 한정: 품목분류(Tariff Classification) 결정만 채택 ──
      // CROSS는 분류 外에 평가(Valuation)·원산지(Marking/Origin)·기타 룰링도 포함하므로 엄격 필터.
      var cat = String(r.category || r.rulingType || r.type || '').toLowerCase();
      if (cat) {
        // category 필드가 있으면 'classification'을 명시한 건만
        if (cat.indexOf('class') === -1) return;
      } else {
        // category 필드가 없으면(필드명 변동 등) HTS 분류번호 존재 여부로 분류 룰링 판정
        if (!hs) return;
        // 제목이 명백히 비분류(평가/원산지/마킹)인 건 제외
        var subjLow = subject.toLowerCase();
        if (/\b(valuation|country of origin|marking|drawback|protest)\b/.test(subjLow)) return;
      }

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
        url_status     : URL_STATUS_OFFICIAL,  // 공식 API 영구 URL — 접속 검증 생략
        provenance     : '공식'  // 소스텍스트 정규식 추론 대신 수집 시점에 명시 (오분류 방지)
      };
      item.importance = _autoImportance(item);
      out.push(item);
    });
  });
  return out;
}

/**
 * 美 Federal Register 직접 수집 (무인증 JSON API).
 * ※ Federal Register는 본질적으로 정책·고시 발행물이라 관세율/반덤핑/301조 등 노이즈가 많다.
 *   따라서 '품목분류 룰링레터의 수정·철회 고시'처럼 실제 HS 분류 룰링 사례에 해당하는 건만 채택하고,
 *   일반 관세정책(POLICY_EXCLUDE_TERMS)은 제외한다. (revocation/modification of ruling letters)
 */
function _collectFederalRegister(periodStart) {
  var url = 'https://www.federalregister.gov/api/v1/documents.json' +
    '?per_page=100&order=newest' +
    '&conditions[term]=' + encodeURIComponent('tariff classification ruling letters') +
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

  var out = [];
  (data.results || []).forEach(function(r) {
    var title = r.title || '';
    var hay   = (title + ' ' + (r.abstract || '')).toLowerCase();

    // ① 분류 룰링 신호어가 하나도 없으면 제외
    if (!FEDREG_RULING_SIGNALS.some(function(s) { return hay.indexOf(s) !== -1; })) return;
    // ② 일반 관세정책·통상조치 키워드가 있으면 제외 (단, 분류 룰링 수정/철회 고시는 신호어로 이미 통과)
    if (POLICY_EXCLUDE_TERMS.some(function(s) { return hay.indexOf(s.trim()) !== -1; })) return;

    var item = {
      category       : '북미',
      country        : '미국',
      source         : 'U.S. Federal Register (CBP 분류 룰링 고시)',
      ruling_number  : r.document_number || '',
      hs_code        : '',
      product_name   : '',
      product_name_en: '',
      company        : _detectCompany(hay),
      title          : '',
      title_en       : title,
      summary        : String(r.abstract || '품목분류 룰링레터 수정/철회 고시').substring(0, 300),
      issue_date     : r.publication_date || '',
      url            : r.html_url || '',
      url_source     : 'Federal Register',
      url_status     : r.html_url ? URL_STATUS_OFFICIAL : '',
      provenance     : '공식'
    };
    item.importance = _autoImportance(item);
    out.push(item);
  });
  return out;
}

/**
 * EU 분류규칙 직접 수집 (EUR-Lex / CELLAR SPARQL — 무인증 공개 엔드포인트).
 * "classification of certain goods in the Combined Nomenclature" 제목의 Commission Implementing Regulation을
 * 기간 내로 조회 → CELEX 번호로 EUR-Lex 영구 URL 생성.
 * ※ EU 온톨로지(cdm) 술어명은 변동 가능 → 실패 시 graceful(빈 배열) 반환, Gemini EU 패스가 보완.
 *   testEuEurlex()로 실제 응답 구조 확인 가능.
 */
function _collectEuClassificationRegs(periodStart) {
  var sparql =
    'PREFIX cdm: <http://publications.europa.eu/ontology/cdm#> ' +
    'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> ' +
    'SELECT DISTINCT ?celex ?title ?date WHERE { ' +
    '  ?work cdm:resource_legal_id_celex ?celex . ' +
    '  ?work cdm:work_date_document ?date . ' +
    '  ?exp cdm:expression_belongs_to_work ?work . ' +
    '  ?exp cdm:expression_title ?title . ' +
    '  FILTER(CONTAINS(LCASE(STR(?title)), "classification of certain goods in the combined nomenclature")) ' +
    '  FILTER(?date >= "' + _fmtDate(periodStart) + '"^^xsd:date) ' +
    '} ORDER BY DESC(?date) LIMIT ' + EURLEX_MAX;

  var url = 'https://publications.europa.eu/webapi/rdf/sparql?query=' +
            encodeURIComponent(sparql) + '&format=application%2Fsparql-results%2Bjson';

  var resp;
  try { resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true,
                                        headers: { 'Accept': 'application/sparql-results+json' } }); }
  catch (e) { Logger.log('[EU EUR-Lex] fetch 오류: ' + e.message); return []; }
  if (resp.getResponseCode() !== 200) {
    Logger.log('[EU EUR-Lex] HTTP ' + resp.getResponseCode() + ' — Gemini EU 패스로 보완');
    return [];
  }

  var bindings;
  try { bindings = JSON.parse(resp.getContentText()).results.bindings; }
  catch (e) { Logger.log('[EU EUR-Lex] 파싱 오류'); return []; }

  var seen = {}, out = [];
  (bindings || []).forEach(function(b) {
    var celex = b.celex && b.celex.value ? b.celex.value : '';
    var title = b.title && b.title.value ? b.title.value : '';
    var date  = b.date && b.date.value ? String(b.date.value).substring(0, 10) : '';
    if (!celex || seen[celex]) return;
    seen[celex] = true;

    var item = {
      category       : '유럽',
      country        : 'EU',
      source         : 'EU 분류규칙 (Official Journal / EUR-Lex)',
      ruling_number  : celex,
      hs_code        : '',
      product_name   : '',
      product_name_en: '',
      company        : _detectCompany(title),
      title          : '',
      title_en       : title,
      summary        : 'EU 통합명명법(CN) 품목분류 시행규칙',
      issue_date     : date,
      url            : 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:' + encodeURIComponent(celex),
      url_source     : 'EUR-Lex',
      url_status     : URL_STATUS_OFFICIAL,  // 공식 영구 URL
      provenance     : '공식'
    };
    item.importance = _autoImportance(item);
    out.push(item);
  });
  return out;
}

/** 텍스트에서 모니터링 기업명 탐지 (API 항목은 기업 필드가 없으므로 제목/요약에서 추출) */
function _detectCompany(text) {
  var low = String(text || '').toLowerCase();
  var found = '';
  MONITORED_COMPANIES.forEach(function(k) { if (!found && low.indexOf(k) !== -1) found = COMPANY_DISPLAY_NAMES[k]; });
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

// ─── 정확성·필터 레이어 (1단계) ─────────────────────────────────────────────

/** HS코드 문자열에서 숫자만 추출해 {chapter(2자리), code6} 반환 */
function _normalizeHs(hs) {
  var digits = String(hs || '').replace(/[^0-9]/g, '');
  return { chapter: digits.substring(0, 2), code6: digits.substring(0, 6), digits: digits };
}

/**
 * 항목이 모니터링 범위(회사/제품군/HS류)에 드는지 판정 + 매칭근거 반환.
 * 영어 키워드뿐 아니라 한국어 등 현지어 키워드(MONITORED_*_LOCAL)도 함께 검사해
 * 한국·일본·중국 등 로컬 소스 Gemini 결과가 언어 차이만으로 탈락하지 않도록 한다.
 * ※ 이 함수는 provenance==='공식'(공식 API 직수집) 항목에는 적용하지 않는다 — _scopeFilterAndTag 참고.
 */
function _scopeMatch(item) {
  var hay = (String(item.title_en || '') + ' ' + String(item.title || '') + ' ' +
             String(item.summary || '') + ' ' + String(item.product_name_en || '') + ' ' +
             String(item.product_name || '') + ' ' + String(item.company || '')).toLowerCase();
  var co = String(item.company || '').toLowerCase();
  var allCompanies = MONITORED_COMPANIES.concat(MONITORED_COMPANIES_LOCAL);
  var allProducts  = MONITORED_PRODUCT_TERMS.concat(MONITORED_PRODUCT_TERMS_LOCAL);

  if (co && allCompanies.some(function(c) { return co.indexOf(c) !== -1; }))
    return { pass: true, reason: '회사:' + item.company };
  var hitCo = allCompanies.filter(function(c) { return hay.indexOf(c) !== -1; });
  if (hitCo.length) return { pass: true, reason: '회사:' + hitCo[0] };

  var hitP = allProducts.filter(function(p) { return hay.indexOf(p) !== -1; });
  if (hitP.length) return { pass: true, reason: '제품:' + hitP[0].trim() };

  var ch = _normalizeHs(item.hs_code).chapter;
  if (ch && MONITORED_HS_CHAPTERS.indexOf(ch) !== -1) return { pass: true, reason: 'HS류:' + ch };

  return { pass: false, reason: '' };
}

/**
 * 1차 필터: 스코프(회사/제품/HS류) 판정 + hs_chapter 태깅. 네트워크 호출 없음(저비용) — URL 검증 전에 실행해
 * 검증 대상 건수를 줄인다.
 * provenance==='공식'(CBP/FedReg/EUR-Lex 직수집) 항목은 스코프 검사를 건너뛴다: 이미 검색어/신호어 자체가
 * 관세 분류 룰링으로 좁혀져 있고(CBP_SEARCH_TERMS, FEDREG_RULING_SIGNALS, EU 분류규칙 SPARQL 필터),
 * EU 관보 시행규칙처럼 title에 품목명이 아예 없는 정상 항목까지 스코프 미달로 버려지는 것을 방지한다.
 */
function _scopeFilterAndTag(items, periodStart) {
  var dropScope = 0;
  var out = [];
  items.forEach(function(it) {
    if (it.provenance === '공식') {
      it.match_reason = it.match_reason || '공식출처(직수집)';
    } else {
      var m = _scopeMatch(it);
      if (!m.pass) { dropScope++; return; }
      it.match_reason = m.reason;
    }
    it.hs_chapter = _normalizeHs(it.hs_code).chapter;
    out.push(it);
  });
  Logger.log('[refine] 스코프 제외 ' + dropScope + '건 → ' + out.length + '건 통과 (URL 검증 대상)');
  return out;
}

/**
 * 2차 필터: URL 검증(_verifyItemUrls) 결과를 반영해 미검증 AI검색 항목을 제외.
 * 단, 중요도 '상'은 예외로 유지(모델 루브릭상 '상'은 이미 기업 직접관련/핵심품목 분쟁 요건을 충족한 것이므로
 * company 필드가 비어 있다는 이유만으로 예외를 거부하지 않는다).
 */
function _applyUnverifiedDrop(items) {
  var dropUnverified = 0;
  var out = [];
  items.forEach(function(it) {
    var hasUrl = it.url && /^https?:\/\//i.test(it.url);
    var failed = String(it.url_status || '').indexOf('FAIL') !== -1;
    if (DROP_UNVERIFIED_AI && it.provenance === 'AI검색' && (!hasUrl || failed)) {
      if (it.importance !== '상') { dropUnverified++; return; }
      it.url_status = it.url_status || '미검증';
    }
    out.push(it);
  });
  Logger.log('[refine] 미검증 제외 ' + dropUnverified + '건 → 최종 ' + out.length + '건');
  return out;
}

// ─── 중복 제거 ───────────────────────────────────────────────────────────────

/**
 * 중복판정 키 목록 생성.
 *  - ruling_number가 있으면 그것만으로 판정한다(N-키 단독) — CBP 룰링처럼 제목이 정형화된 문구
 *    ("The tariff classification of a smartphone from China" 등)라서 서로 다른 번호의 룰링이
 *    영문제목 80자 접두어가 우연히 같아지는 경우, T-키까지 같이 반환하면 keys.some() 방식의
 *    _dedupResults가 번호가 다른 진짜 신규 룰링을 오탐 제거하기 때문.
 *  - ruling_number가 없으면(주로 한국어 로컬 소스) 영문제목 T-키와, 국가+HS코드+게시일+한국어제목
 *    복합키(C-키)를 함께 반환해 완전히 키가 비어 dedup을 우회하는 것을 방지한다.
 */
function _itemKeys(item) {
  var country = String(item.country || '').trim();
  var num     = String(item.ruling_number || '').trim();
  if (num) return ['N|' + country + '|' + num];

  var keys = [];
  var titleEn = String(item.title_en || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (titleEn) keys.push('T|' + country + '|' + titleEn.substring(0, 80));

  var titleKo = String(item.title || item.product_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (titleKo) {
    var composite = country + '|' + String(item.hs_code || '').trim() + '|' +
                    String(item.issue_date || '').trim() + '|' + titleKo.substring(0, 60);
    keys.push('C|' + composite);
  }
  return keys;
}

/** 동향DB의 기존 (국가+Ruling번호 / 국가+영문제목 / 국가+HS+게시일+한글제목) 키 집합 로드 — 최근 2000행만 */
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
      _itemKeys({ country: row[2], ruling_number: row[4], hs_code: row[5],
                  title: row[9], title_en: row[10], issue_date: row[12] })
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
 *  - 401/403/405/429  : OK — URL은 존재하나 봇 차단으로 추정 → 링크 유지
 *  - 그 외(404 등)    : FAIL — 이메일에서 원문 버튼 대신 검색 버튼으로 대체
 *  - SKIP             : 검증 미완료(한도 초과 또는 시간예산 소진) — FAIL 아님이므로 링크는 유지
 *
 * ラウンド(hop) 단위 배치 처리: 항목별로 순차 리다이렉트를 추적하던 이전 방식은 검증 대상 60건 ×
 * 최대 5홉 = 최대 300회의 순차 HTTP 요청이 되어 Apps Script 6분 실행 한도를 검증 단계 혼자 넘길 수 있었다.
 * 이제 모든 대상의 "현재 홉"을 UrlFetchApp.fetchAll()로 한 번에(라운드당 1회) 병렬 조회하므로,
 * 총 호출 횟수가 O(대상 수 × 홉 수)에서 O(홉 수)로 줄어든다. 남은 실행시간이 부족하면 그 라운드에서
 * 중단하고 나머지는 SKIP 처리 — 이 함수가 전체 실행시간을 소진해 저장/발송이 아예 안 되는 사태를 방지한다.
 * validateHttpsCertificates는 지정하지 않아 기본값(true, 인증서 검증)을 사용한다 — 모델이 제공한 임의
 * URL의 리다이렉트를 인증서 검증 없이 추적하면 MITM에 의해 저장 URL이 조작될 수 있기 때문.
 */
function _verifyItemUrls(items) {
  var targets = [];
  items.forEach(function(it) {
    if (String(it.url_status || '').indexOf(URL_STATUS_OFFICIAL) !== -1) return;  // 공식 API URL은 검증 불필요
    if (!it.url) { it.url_status = it.url_status || ''; return; }
    if (!/^https?:\/\//i.test(it.url)) { it.url = ''; it.url_status = 'FAIL(형식)'; return; }
    if (targets.length < URL_VERIFY_MAX) targets.push(it);
    else it.url_status = 'SKIP';
  });
  if (!targets.length) return;

  var state = targets.map(function(it) { return { item: it, current: it.url, done: false, status: '' }; });

  for (var hop = 0; hop < URL_VERIFY_MAX_HOPS; hop++) {
    if (_budgetLeft() < VERIFY_TIME_RESERVE_MS) {
      Logger.log('[verifyUrls] 시간예산 부족 — 나머지 ' + state.filter(function(s) { return !s.done; }).length + '건은 SKIP');
      break;
    }
    var pending = state.filter(function(s) { return !s.done; });
    if (!pending.length) break;

    var reqs = pending.map(function(s) {
      return { url: s.current, method: 'get', muteHttpExceptions: true, followRedirects: false };
    });
    var resps;
    try { resps = UrlFetchApp.fetchAll(reqs); }
    catch (e) {
      pending.forEach(function(s) { s.done = true; s.status = 'SKIP'; });
      break;
    }
    resps.forEach(function(resp, i) {
      var s = pending[i];
      var c = resp.getResponseCode();
      if (c >= 300 && c < 400) {
        var loc = resp.getAllHeaders()['Location'] || resp.getAllHeaders()['location'] || '';
        if (Array.isArray(loc)) loc = loc[0];
        if (!loc) { s.done = true; s.status = 'OK'; return; }
        if (/^https?:\/\//i.test(loc)) { s.current = loc; }
        else { s.current = s.current.replace(/^(https?:\/\/[^\/]+).*$/, '$1') + (loc.charAt(0) === '/' ? '' : '/') + loc; }
        // 다음 라운드에서 이 URL로 계속 추적
      } else if ((c >= 200 && c < 300) || c === 401 || c === 403 || c === 405 || c === 429) {
        s.done = true; s.status = 'OK';
      } else {
        s.done = true; s.status = 'FAIL(' + c + ')';
      }
    });
  }

  state.forEach(function(s) {
    if (!s.done) s.status = 'SKIP'; // 홉 소진 또는 시간예산 부족 — 진행 중이던 URL은 유지
    if (s.current && /^https?:\/\//i.test(s.current)) s.item.url = s.current; // 최종 canonical URL로 치환
    s.item.url_status = s.status;
  });
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
  var searchQuery = '(' + fromFilter + ') subject:("HS 요청") -label:' + PROCESSED_LABEL + ' newer_than:1d';

  var threads = GmailApp.search(searchQuery);
  Logger.log('[checkHsRequestEmails] 감지된 스레드 수: ' + threads.length);
  if (!threads.length) return;

  var lastData = _loadLastReportData();
  if (!lastData.results.length) {
    Logger.log('[checkHsRequestEmails] 저장된 리포트 데이터 없음 — 재발송 생략');
    threads.forEach(function(t) { t.addLabel(label); });
    return;
  }

  // 수신자 화이트리스트 (소문자 정규화) — 스레드 매칭은 "스레드 내 아무 메시지나 whitelist 발신"이면
  // 성립하므로, 실제 발송 전 마지막 메시지의 발신자를 다시 한번 화이트리스트와 대조해야 한다.
  // (그렇지 않으면 스푸핑된 From, 또는 화이트리스트 스레드에 끼어든 제3자에게 리포트가 발송될 수 있음)
  var recipientSet = {};
  recipients.forEach(function(e) { recipientSet[e.toLowerCase()] = true; });

  threads.forEach(function(thread) {
    var messages = thread.getMessages();
    var lastMsg  = messages[messages.length - 1];
    var fromRaw  = lastMsg.getFrom();
    var m        = fromRaw.match(/<([^>]+)>/);
    var requester = (m ? m[1] : fromRaw).trim();

    if (!recipientSet[requester.toLowerCase()]) {
      Logger.log('[checkHsRequestEmails] 화이트리스트에 없는 발신자 — 발송 생략: ' + requester);
      thread.addLabel(label);
      return;
    }

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
/** 시트 셀 값(문자열 또는 시트가 자동 변환한 Date 객체)을 비교 가능한 문자열로 정규화 */
function _dateKey(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return _fmtDateTime(v);
  return String(v);
}

function _loadLastReportData() {
  var ss    = _getSpreadsheet();
  var sheet = ss.getSheetByName(DB_SHEET_NAME);
  if (!sheet || sheet.getLastRow() <= 1) return { results: [], dateRange: '' };

  var data        = sheet.getDataRange().getValues();
  // '수집일시' 셀은 문자열로 썼지만 시트가 locale에 따라 Date로 자동 변환할 수 있어,
  // Date 객체끼리 === 비교하면 참조가 달라 항상 false가 된다 → 문자열로 정규화해 비교.
  var lastRunKey  = _dateKey(data[data.length - 1][0]);
  var recentRows  = data.slice(1).filter(function(row) { return _dateKey(row[0]) === lastRunKey; });

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
      importance     : row.length > 17 ? row[17] : '',
      provenance     : row.length > 18 ? row[18] : '',
      hs_chapter     : row.length > 19 ? row[19] : '',
      match_reason   : row.length > 20 ? row[20] : ''
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

    '[ MANDATORY GATE — collect ONLY genuine HS classification rulings ]\n' +
    'Every item MUST be a specific HS/tariff CLASSIFICATION decision — i.e. a customs authority advance/binding classification ruling, ' +
    'a classification determination, or a court/tribunal judgment deciding which HS heading/subheading a specific product falls under. ' +
    'Each item MUST be tied to an identifiable product and (ideally) an HS code.\n' +
    'STRICTLY EXCLUDE general tariff/trade policy that is NOT a product classification decision: ' +
    'tariff-rate or duty-rate changes, antidumping/countervailing/safeguard duties, Section 301/232/201 actions, reciprocal/IEEPA tariffs, ' +
    'quotas, customs fees, drawback, de minimis, FTA/preferential-origin or rules-of-origin, export controls, sanctions, ' +
    'general trade statistics, agendas, or meeting/comment notices. If an item is not a product classification ruling, DO NOT include it.\n\n' +

    '[ COLLECTION CRITERIA — OR condition (applied AFTER the mandatory gate above) ]\n\n' +

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
    // isGroup 지역은 복합 라벨(예: '아르헨티나/칠레/파나마')이 아니라 실제 단일 국가명 예시를 시딩해
    // 모델이 템플릿 문자열을 그대로 echo하는 것을 방지 (런타임 검증은 runHSRulingMonitor에서 재확인)
    '    "country": "' + ((region.isGroup && region.countries && region.countries.length) ? region.countries[0] : region.region) + '",\n' +
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
    url               : 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL_NAME + ':generateContent',
    method            : 'post',
    contentType       : 'application/json',
    headers           : { 'x-goog-api-key': apiKey },  // 쿼리스트링 대신 헤더로 전달 — 로그 노출 방지
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
                  '게시일', 'URL', '카테고리', 'URL상태', 'URL출처', '중요도',
                  '출처유형', 'HS류', '매칭근거'];

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
            r.category || '', r.url_status || '', r.url_source || '', r.importance || '중',
            r.provenance || '', r.hs_chapter || '', r.match_reason || ''];
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
  // 출처유형: 공식(검증) vs AI검색 — 신뢰도 구분
  if (item.provenance === '공식') badges += _badge('공식·검증', '#1b5e3b', '#e7f4ec', '#bfe0cc');
  else if (item.provenance === 'AI검색') badges += _badge('AI검색', '#6d3b00', '#fbf0e3', '#e7cfb0');
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

  // 선호 순서는 유지하되, MONITORING_REGIONS에 새 카테고리가 추가돼도 자동으로 뒤에 포함되도록 파생.
  // (v3.0에서 '동북아'를 이 배열에 손으로 추가하지 않아 한국·일본 결과가 메일에서 통째로 빠졌던 사고가
  //  재발하지 않도록, 수동 목록을 "1차 정렬 힌트"로만 쓰고 실제 포함 여부는 MONITORING_REGIONS가 결정한다.)
  var CATEGORY_ORDER = (function() {
    var preferred = ['동북아', '중국', '북미', '중남미', '인도', '유럽', '중동', '동남아', '아프리카', 'CIS', '글로벌'];
    var seen = {};
    preferred.forEach(function(c) { seen[c] = true; });
    MONITORING_REGIONS.forEach(function(r) {
      if (!seen[r.category]) { seen[r.category] = true; preferred.push(r.category); }
    });
    return preferred;
  })();
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
    'https://generativelanguage.googleapis.com/v1beta/models',
    { muteHttpExceptions: true, headers: { 'x-goog-api-key': apiKey } }
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
 * EU EUR-Lex(CELLAR SPARQL) 분류규칙 수집 확인용 — 최초 1회 실행 권장.
 * 0건이면 SPARQL 술어명(cdm) 변동 가능 → 로그의 raw 응답을 보고 _collectEuClassificationRegs 조정.
 */
function testEuEurlex() {
  var since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  var items = _collectEuClassificationRegs(since);
  Logger.log('[testEuEurlex] 최근 180일 분류규칙 ' + items.length + '건');
  items.slice(0, 8).forEach(function(it) {
    Logger.log('  - [' + it.ruling_number + '] ' + it.title_en + ' | ' + it.issue_date + ' | ' + it.url);
  });
  if (!items.length) {
    Logger.log('[testEuEurlex] 0건 — SPARQL 응답 직접 확인:');
    var sparql = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 1';
    var url = 'https://publications.europa.eu/webapi/rdf/sparql?query=' + encodeURIComponent(sparql) +
              '&format=application%2Fsparql-results%2Bjson';
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    Logger.log('  endpoint HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 400));
  }
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
