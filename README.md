# HS Code 유권해석(Ruling) 주간 모니터링 시스템

Google Apps Script + Gemini API(google_search 그라운딩) 기반으로 전 세계 관세당국의
HS 품목분류 유권해석 사례를 주간 수집하여 구글 시트에 저장하고 HTML 리포트 메일을 발송합니다.

- 메인 스크립트: [`hs-ruling-monitor.gs`](hs-ruling-monitor.gs)

## 초기 설정

1. Apps Script 프로젝트의 **스크립트 속성**에 `GEMINI_API_KEY` 등록
2. `listAvailableModels()` 1회 실행 → 로그에서 사용 가능한 모델명 확인 후 `MODEL_NAME` 수정
   (google_search 그라운딩 지원 모델이어야 함, 예: `gemini-2.5-flash`)
3. 구글 시트가 열린 상태에서 `setupAllTriggers()` 1회 실행
   - Spreadsheet ID 자동 저장
   - 매주 월요일 09:00 KST 정기 실행 트리거
   - 15분마다 "HS 요청" 메일 폴링 트리거
4. (선택) `testSingleRegion(3)` 으로 미국(CBP) 단일 패스 동작 확인

## v4.2 — 정확성·필터 레이어 + EU 직수집 강화

수집 후 **검증·필터 단계가 없던 구조**에 정확성/필터 레이어(`_refineResults`)를 신설하고, EU 수집을 대폭 보강.

### 정확성·필터 (회사·HS·제품군)
- **통합 스코프 필터**(`_scopeMatch`): 회사 / 제품군 / HS류(`MONITORED_HS_CHAPTERS`) 중 하나라도 매칭해야 채택, 매칭근거를 기록.
  → 정의만 되고 안 쓰이던 `MONITORED_HS_CHAPTERS`를 HS코드 정규화(`_normalizeHs`) 후 실제 작동.
- **미검증 항목 제외**: 원문 URL이 없거나 접속 실패한 AI검색 항목은 제외(`DROP_UNVERIFIED_AI`).
  단, **회사 직접 관련 '상' 중요도는 예외로 유지**. (단순 미점검 `SKIP`은 살림 — 쿼터로 인한 과도 누락 방지)
- **오래된 룰링 제외**: 게시일이 조회기간보다 `STALE_RULING_MONTHS`(기본 12개월) 이전이면 제외.
- **출처유형 명시**: 공식(검증) vs AI검색을 메일 배지 + 시트 컬럼으로 구분 → 신뢰도 한눈에.

### EU 수집 강화
- **EU 분류규칙 직수집**(EUR-Lex / CELLAR SPARQL, 무인증): Official Journal의 "classification of certain goods
  in the Combined Nomenclature" 시행규칙을 기간 내 조회 → **CELEX 영구 URL**(`eur-lex.europa.eu/.../CELEX:...`).
- **EU Gemini 패스 2분할**: ① 분류규칙 + CJEU 판결, ② EBTI/회원국 BTI(독일 vZTA 등) → recall 확대.
- `OFFICIAL_DB` EU 링크를 EUR-Lex 쿼리 검색형으로 개선. 진단 함수 `testEuEurlex()` 추가.
- 토글 `USE_EU_EURLEX` (best-effort, 실패 시 Gemini EU 패스가 보완).
- ※ SPARQL 술어명 변동 가능 → 최초 1회 `testEuEurlex()`로 수집 여부 확인 권장.

### 동향DB 컬럼 추가
`출처유형` / `HS류` / `매칭근거` (구버전 시트 자동 보강).

## v4.1 — 미국 결과 정밀화 (분류 룰링 사례만)

미국 수집에 일반 관세정책(관세율 변경·반덤핑/상계·Section 301/232·쿼터·수수료·FTA/원산지 등)이 섞이던 문제를 수정.

- **CBP CROSS**: `category` 필드가 비어 있으면 전부 통과하던 버그 수정 → HTS 분류번호가 있고, 비분류(평가/원산지/마킹) 제목이 아닌 건만 채택.
- **Federal Register**: 정책 고시 발행물이라 노이즈가 많아, **'분류 룰링레터 수정/철회 고시'(`FEDREG_RULING_SIGNALS`)만 채택**하고 정책 키워드(`POLICY_EXCLUDE_TERMS`)는 제외.
- **미국 Gemini 패스**: Section 301 등 정책 항목 제거 → **CIT/CAFC 품목분류 판결**만 수집.
- **전 지역 Gemini 프롬프트**: `[MANDATORY GATE]` 추가 — 특정 제품의 HS 분류 결정/판결만 수집하고, 일반 관세정책은 강제 제외.

## v4.0 — HS 한정 · 최대 수집 · 원문 영구 확인 (하이브리드)

모델 요약(Gemini google_search)에만 의존하던 구조에서, **공식 API 직접 수집 + Gemini 보완**의 하이브리드로 전환.

### 공식 API 직접 수집 (영구 원문 URL + 대량 수집)
- **美 CBP CROSS** (`rulings.cbp.gov/api/search`, 무인증 JSON): 모니터링 품목/기업 검색어별로 최신순 전수 조회 →
  기간 내 **품목분류(Tariff Classification) 결정만** 채택. 원문은 `rulings.cbp.gov/ruling/{번호}` **영구 canonical URL**.
- **美 Federal Register** (무인증 JSON API): CBP 분류 고시/결정을 영구 `html_url`과 함께 수집.
- API가 없는 국가(중남미·중동·아프리카·CIS 등)는 기존 Gemini 그라운딩으로 보완.
- 미국 Gemini 패스는 CROSS 중복을 피해 **CIT/CAFC 분류 판결·통상 분쟁·언론** 보완용으로 재조정.
- 토글: `USE_CBP_API`, `USE_FEDERAL_REGISTER` / 검색어: `CBP_SEARCH_TERMS`.

### 원문 URL 영구화 (가장 중요)
- Gemini 그라운딩이 주는 `vertexaisearch...redirect` URL은 **임시 링크(만료)** 라 아카이브엔 부적합.
- `_resolveFinalUrl()` 이 리다이렉트를 수동 추적해 **최종 도착 canonical URL**을 잡아 저장 →
  동향DB에 쌓인 원문 링크가 몇 주 뒤에도 살아 있음. 접속 상태(`OK`/`FAIL`/`SKIP`)도 함께 기록.
- 공식 API URL은 영구 보장되므로 검증 생략(`OK(API)`).

### 설정/진단
- 최초 1회 `testCbpApi()` 실행 → 로그에서 CBP API 실제 응답 필드 확인(다르면 `_collectCbpRulings` 폴백 필드 조정).
- `testFederalRegister()` 로 Federal Register 수집 확인.
- API 항목은 모델 판정이 없으므로 `_autoImportance()`(상=기업 직접 / 중=품목 / 하=HS류)로 중요도 자동 산정.

## v3.1 디자인 리뉴얼

- **테마 상수**: `FONT_STACK`, `CATEGORY_COLORS`(카테고리별 다크 톤), `IMPORTANCE_COLORS`/`IMPORTANCE_BG`(상 빨강 / 중 주황 / 하 초록)
- **이메일**: 플랫 레이아웃(전체 배경 `#eef1f5`, 본문 680px, 보더 `#dde1e7`), 네이비 헤더·푸터(`#14294a`,
  `bgcolor` 속성 병기로 Outlook 호환), 수록 기준 안내 영역(연초록 `#eaf6ee` + `#2e8b57` 상단 보더),
  카테고리 섹션 헤더 솔리드 컬러
- **아이템 카드**: 좌측 5px 중요도 세로 컬러바, 공통 뱃지 UI(중요도/HS코드/기업), 타이틀에 원문 링크
  (`#15418c` 언더라인 — 검증된 URL 또는 공식 DB 직링크)
- **구글 시트**: 헤더 네이비 딥블루(`#1a2a4a`) + 흰색 볼드, 중요도 '상' 행 전체 연한 빨강(`#fff5f5`) 하이라이트
- **중요도 필드 추가**: Gemini가 상(모니터링 기업 직접 관련·핵심 품목 분류 변경/분쟁) / 중(모니터링 품목) /
  하(HS류만 관련)로 판정 → 카드 정렬(상→중→하), 시트 `중요도` 컬럼 저장

## v3.0 주요 개선 사항

### 원문 URL 정확도 (핵심)
- Gemini `google_search` 그라운딩 응답의 `groundingMetadata`(groundingChunks/Supports)에서
  **실제 검색 출처 URL**을 추출해 각 ruling에 매칭 — 모델이 URL을 지어내는 문제를 구조적으로 해결
- 프롬프트에 "URL을 모르면 빈 값, 절대 추측 금지" 지시 강화
- 수집된 URL은 `UrlFetchApp`으로 실제 접속 검증 후 상태(`OK`/`FAIL`/`SKIP`)를 시트에 기록
- 이메일 링크 우선순위: ① 원문 URL → ② 공식 DB 직링크(미국 CBP `rulings.cbp.gov/ruling/{번호}` 등)
  → ③ 공식 DB 검색·공식 도메인 한정 구글검색(`site:`) → ④ 현지 언어 일반 구글검색

### 버그 수정
- 한국/일본(`동북아` 카테고리) 수집 결과가 이메일 `CATEGORY_ORDER`에 없어 **메일에서 통째로 누락**되던 문제
- 지역 프롬프트의 "last 30 days" 하드코딩이 `MONITORING_DAYS=14`와 모순되던 문제 (`{DAYS}` 치환)
- 키워드의 "2026" 하드코딩 (`{YEAR}` 치환)
- 그룹 지역(아르헨티나/칠레/파나마 등)의 country → category 역매핑 실패 (`countries` 배열 도입)
- 프롬프트 내 "▶ A." 블록 중복
- 발신자 주소 파싱 시 `<...>` 미포함 형식 대응

### 수집 품질/안정성
- **중복 제거**: 동향DB 기존 데이터와 (국가+Ruling번호 / 국가+영문제목) 키로 비교 — 14일 윈도우 × 주간 실행으로
  매주 절반가량 중복되던 문제 해결
- API 호출을 배치(7건)로 분할 + 429/5xx 지수 백오프 재시도 — rate limit 대응
- `maxOutputTokens` 8192 → 16384, `MAX_TOKENS` 잘림 경고 로그
- 글로벌 통상언론/WCO/로펌 Trade Alert 검색 패스 추가 (공식 DB 미공개 국가 보완)
- 국가별 프롬프트에 고유 제도명 보강 (CAAR/CESTAT(인도), 事前教示(일본), 归类决定(중국),
  Solução de Consulta(브라질), BTB(튀르키예), EU Classification Regulation/EUR-Lex 등)
- 모델 출력 HTML 이스케이프 처리 (메일 레이아웃 깨짐 방지)
- 동향DB에 `카테고리`/`URL상태`/`URL출처` 컬럼 추가 (구버전 14컬럼 시트 자동 보강)
