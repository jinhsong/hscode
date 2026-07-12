/**
 * HS Code 유권해석(Ruling) 주간 모니터링 시스템
 * ─────────────────────────────────────────────
 * [변경 이력]
 * v5.0 (주간 운영 최적화 — 시간·비용 효율화 + 미국/유럽 직수집 중심 재편)
 *  - [주기] 조회기간 30 → 7일: 매주 월요일 발행 · 최근 일주일치 (dedup이 있어 경계 누락 없음)
 *  - [시간] 실행 순서 반전: 무료·고속 직수집(CBP/FedReg/EUR-Lex/GOV.UK/RSS)을 먼저 확보하고
 *      Gemini는 남은 시간예산으로 — 시간 초과 시에도 직수집분은 반드시 발송됨.
 *      _fetchAllInBatches에 배치 단위 시간예산 가드 추가 (예산 소진 시 나머지 배치 생략)
 *  - [비용] Gemini 패스 27 → 12 통합 (주당 그라운딩 호출 -56%): 직수집·RSS가 바닥을 깔아주므로
 *      Gemini는 보완역으로 축소 — 한국/일본/중국/인도 단독 유지, 북미 판결·중남미 7국·EU+영국·
 *      중동 11국·동남아+오세아니아 8국·아프리카·CIS·글로벌은 통합 그룹 패스(국가별 검색 전략은 유지).
 *      maxOutputTokens 16384 → 8192 (25건 JSON에 충분 — 출력 토큰 비용 절감)
 *  - [균형] 미국 CROSS 총량 캡(CBP_MAX_TOTAL=80/주) — 직수집 정상화 후 미국 편중 방지.
 *      번역 상한 80 → 50 (실행시간 절약)
 *
 * v4.9 (실측 로그 기반 직수집기 수정 — CBP 페이지 인덱스 / EUR-Lex 성능)
 *  - [CBP] 실측 진단({"rulings":[],"totalHits":28})으로 page 파라미터가 0-인덱스임을 확인 —
 *      page=1,2 → page=0,1로 수정. 그동안 모든 검색어가 빈 페이지를 받아 0건이었음.
 *  - [EUR-Lex] CONTAINS(제목) 풀스캔으로 호출당 2분+ 소요·타임아웃 → 쿼리 재설계:
 *      좁히는 조건(문서유형 REG_IMPL, 기간 xsd:date, 영어 표현)을 먼저 걸고 제목 필터는 마지막에.
 *      1차(REG_IMPL 한정) 0건 시 2차(문서유형 무제한, 기간·언어 유지) 폴백. 서버 타임아웃 30초 지정.
 *
 * v4.8 (표시 품질 + 소스 균형 + 직수집기 침묵실패 진단)
 *  - [표시] "제목 없음" 노출 수정: 한국어 제목이 없으면 원문 제목을 메인으로 표시(부제 중복 제거)
 *  - [번역] 발송 전 한국어 번역 단계(_translateToKorean, LanguageApp 내장 번역):
 *      한국어 제목이 없는 항목의 제목·요약을 한국어화 (원문은 title_en에 보존, 실패해도 발송 진행)
 *  - [균형] RSS 국가당 총량 캡(RSS_MAX_PER_COUNTRY=12) + 피드별 max — 인도(피드 3개) 편중 방지,
 *      인도 쿼리·필터 정밀화 ("tariff classification"/"advance ruling" 한정)
 *  - [진단] CBP 0건 대응: 전량 실패 시 최소 파라미터(term/pageSize/page)로 자동 재시도 +
 *      첫 실패 응답/구조를 로그로 남겨 필드 보정 가능하게
 *  - [진단] EUR-Lex 0건 대응: 타입 불일치에 취약한 SPARQL 날짜 FILTER 제거(최신순 LIMIT + 클라이언트
 *      기간 필터로 대체), 0건 시 응답 앞부분 진단 로그
 *
 * v4.7 (링크 정확도 + 같은 사건 중복 병합)
 *  - [링크 정확도] "Page not found" 방지: 접속 검증을 실제로 통과(OK/OK(API))했거나 항상 유효한
 *      리다이렉터(news.google.com)인 URL만 원문 링크로 노출(_isLinkTrusted). 미검증/SKIP URL은
 *      링크 대신 공식 DB 검색·구글 검색 버튼으로 대체(항목 자체는 유지).
 *  - [중복 병합] 같은 사건을 다룬 여러 매체 보도·RSS/Gemini/공식 소스 간 중복을 하나로(_dedupSimilar):
 *      ① 정규화 URL 동일 ② 같은 국가 내 제목 유사도(Jaccard ≥ 0.55, CJK는 문자 바이그램).
 *      서로 다른 룰링번호는 병합 금지(정형화 제목의 별개 룰링 보호).
 *      대표는 공식 > 뉴스RSS > AI검색 순으로 남기고 부족한 필드(hs_code 등)는 병합.
 *  - Google News 제목의 "제목 - 매체명"에서 매체명 분리(출처 표기·유사도 정확도↑),
 *      base64 링크에서 원 기사 URL best-effort 디코드(_decodeGnewsUrl — 중복판정용)
 *  - 구글뉴스 링크는 접속 검증 생략(항상 유효) — 검증 예산을 실제 의심 URL에 집중
 *  - 파이프라인 통계에 '같은 사건 병합' 건수 추가
 *
 * v4.6 (직수집기 추가 — 뉴스 RSS 14피드 + GOV.UK API)
 *  - [핵심] Google News RSS 직수집(_collectRssNews): 국가·현지어별 14개 피드
 *      (한국어/일본어/중국어/베트남어/포르투갈어/스페인어/터키어/러시아어/독일어/아랍어/영어 + 인도 Taxscan·TaxGuru RSS).
 *      Gemini 그라운딩과 달리 쿼리 결과를 결정적으로 전부 반환 → 지역 뉴스 커버리지의 바닥을 보장.
 *      Google News 리다이렉트 링크는 기존 URL 검증 단계가 최종 기사 URL로 해소.
 *  - [핵심] 英 GOV.UK Search API 직수집(_collectGovUkDecisions): "tariff classification" 심판결정·가이던스,
 *      gov.uk 영구 URL(공식 출처).
 *  - 출처유형 '뉴스RSS' 신설 (배지·시트 표기) — 공식/뉴스RSS/AI검색 3단계 신뢰도 구분
 *  - URL 검증 한도 60 → 90 (RSS 리다이렉트 해소 물량 반영)
 *  - 진단 함수 testRssNews() / testGovUk() 추가
 *
 * v4.5 (프롬프트 전면 재설계 — 그라운딩 검색 방식에 맞춤)
 *  - [공통] SEARCH RULES 신설: 최소 5회 개별 검색 / 현지어 우선 / site: 연산자 활용 /
 *      검색어에 제품·기업명 금지(넓게 검색 → 보고 단계에서 필터) / 날짜는 페이지 본문에서 확인
 *  - [공통] A/B/C 수집조건을 '제외 필터'에서 '우선순위(중요도) 마커'로 전환 —
 *      조건 미매칭 룰링도 중요도 '하'로 전부 보고 (모델 자기검열 제거, RECALL_MODE와 일관)
 *  - [재조준] 구글에 색인되지 않는 소스를 찾게 하던 헛수고 패스 수정:
 *      · EU(BTI) → EU(회원국): EBTI DB는 비색인 → 회원국 법원판결·로펌 얼럿 중심으로 재정의
 *      · 캐나다: CBSA advance ruling 비공개 → CITT 심판 판결 중심
 *      · 영국: HMRC ATaR 비공개 → First-tier Tribunal 판결 중심
 *      · CIS: 정기 공표되는 EAEU(ЕЭК) 분류결정을 1차 소스로
 *      · 한국(공식): CLIP 비색인 명시 → 보도자료·고시·행정예고 중심
 *  - [분할] 고수율 지역 패스 확대: 인도 → 공식(CAAR/CESTAT)/전문지(TaxGuru·Taxscan) 2패스,
 *      베트남 → 단독 패스 분리(분류 결정문 공개 활발) — 총 25 → 27개 패스
 *  - 모든 지역 프롬프트를 '키워드 나열'에서 '번호 붙은 검색 전략(현지어 쿼리 명시)'으로 재작성
 *
 * v4.4 (수집량 우선 모드 — "정보가 너무 안 잡힌다" 대응)
 *  - RECALL_MODE 도입 (기본 true): 스코프 재검사·URL 미검증을 이유로 항목을 버리지 않고
 *    '원문 미확인'/'모델판정' 태그로 구분만 한다 — Gemini 프롬프트의 MANDATORY GATE가 이미
 *    룰링/정책을 걸러주므로 코드 레벨 재필터는 태깅 역할만 수행. false로 바꾸면 기존 정확성 우선 동작.
 *  - 조회기간 14일 → 30일 (dedup이 있어 중복 없이 회수율만 상승)
 *  - 한국·중국을 공식 DB / 뉴스·업계 2개 패스로 분할 (검색 패스 23 → 25개)
 *  - Gemini 결과 상한 15 → 25건 + "빠짐없이 전부 보고(be EXHAUSTIVE)" 지시 추가
 *  - CBP CROSS 페이지네이션 (CBP_PAGES=2 → 검색어당 최대 100건)
 *  - 이메일 헤더에 수집 파이프라인 통계 표기 (수집→중복제외→스코프→최종/미확인) —
 *    어디서 몇 건이 걸러졌는지 리포트에서 바로 확인 가능
 *
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

var MONITORING_DAYS = 7;    // 조회기간 — 매주 월요일 발행 · 최근 일주일치 (dedup이 있어 경계 누락 없음)

// ─── 수집량 우선 모드 ────────────────────────────────────────────────────────
// true  : 최대 수집 — 스코프 재검사·URL 미검증을 이유로 버리지 않고 '미검증' 배지로 구분만 한다.
//         (Gemini 프롬프트의 MANDATORY GATE가 이미 룰링/정책을 걸러주므로 코드 재필터는 태깅만)
// false : 정확성 우선 — 기존 v4.2~4.3 동작 (스코프 미달·미검증 AI검색 항목 제외)
var RECALL_MODE = true;

// 발송 전 한국어 번역 (RSS·해외 소스 항목의 제목/요약) — Apps Script 내장 LanguageApp 사용
var TRANSLATE_TO_KO = true;
var TRANSLATE_MAX   = 50;   // 실행당 번역 호출 상한 (호출당 ~0.5초 — 실행시간·쿼터 보호)

// API 호출 배치 크기/대기 — 무료 등급은 분당 요청 제한이 낮으므로 배치로 나눠 호출
var API_BATCH_SIZE     = 7;
var API_BATCH_PAUSE_MS = 2000;
var API_MAX_RETRY      = 2;     // 429/5xx 시 개별 재시도 횟수

// URL 실접속 검증 최대 건수 (Apps Script 6분 실행 제한 고려 — RSS 리다이렉트 해소 물량 포함)
var URL_VERIFY_MAX      = 90;
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
var USE_UK_GOVUK         = true;   // 英 GOV.UK Search API — 분류 심판결정/가이던스 (무인증, 영구 URL)
var USE_RSS_NEWS         = true;   // Google News RSS + 전문지 RSS 직수집 — 전 지역 뉴스를 결정적으로 수집
var RSS_MAX_PER_FEED     = 20;     // RSS 피드당 채택 상한 (소스별 max로 개별 조정 가능)
var RSS_MAX_PER_COUNTRY  = 12;     // RSS 국가당 총 채택 상한 — 특정 국가(피드 다수) 편중 방지
var CBP_PAGE_SIZE        = 50;     // CBP 검색어당 페이지 크기 (최신순)
var CBP_PAGES            = 2;      // 검색어당 조회 페이지 수 (page 0부터) — 2면 최대 100건/검색어
var CBP_MAX_PER_TERM     = 100;    // 검색어당 기간 내 채택 상한
var CBP_MAX_TOTAL        = 80;     // 주간 총 채택 상한 — 미국 편중으로 리포트가 넘치는 것 방지
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

// ─── 뉴스 RSS 직수집 소스 ────────────────────────────────────────────────────
// Google News RSS는 무인증·언어별 검색이 가능한 기계판독 소스 — Gemini 그라운딩과 달리
// 쿼리당 결과를 결정적으로 전부 반환한다. 링크는 news.google.com 리다이렉트이지만
// _verifyItemUrls가 최종 기사 URL로 해소한다. (함수 선언은 호이스팅되므로 초기화에 사용 가능)
function _gnews(query, hl, gl, ceid) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) +
         '&hl=' + hl + '&gl=' + gl + '&ceid=' + encodeURIComponent(ceid);
}

// ko:true → 제목을 title(한국어 필드)에 저장. filter → 제목이 정규식과 일치할 때만 채택(범용 피드용).
var RSS_SOURCES = [
  { category: '동북아', country: '한국',   name: 'Google News 한국', ko: true,
    url: _gnews('품목분류 OR "사전심사" 관세', 'ko', 'KR', 'KR:ko') },
  { category: '동북아', country: '일본',   name: 'Google News 日本',
    url: _gnews('事前教示 OR 品目分類 税関', 'ja', 'JP', 'JP:ja') },
  { category: '중국',   country: '중국',   name: 'Google News 中国',
    url: _gnews('商品归类 OR 归类决定', 'zh-CN', 'CN', 'CN:zh-Hans') },
  { category: '동남아', country: '베트남', name: 'Google News Việt Nam',
    url: _gnews('"phân loại hàng hóa" hải quan', 'vi', 'VN', 'VN:vi') },
  { category: '중남미', country: '브라질', name: 'Google News Brasil',
    url: _gnews('"classificação fiscal" OR "Solução de Consulta" NCM', 'pt-BR', 'BR', 'BR:pt-419') },
  { category: '중남미', country: '멕시코', name: 'Google News México',
    url: _gnews('"clasificación arancelaria"', 'es-419', 'MX', 'MX:es-419') },
  // 인도는 피드가 3개라 편중되기 쉬움 — 피드별 max로 억제 + 분류 관련성 필터 강화
  { category: '인도',   country: '인도',   name: 'Google News India', max: 6,
    url: _gnews('"tariff classification" OR "advance ruling" customs', 'en-IN', 'IN', 'IN:en') },
  { category: '인도',   country: '인도',   name: 'Taxscan RSS', max: 4,
    filter: /classif|caar|tariff heading|hsn/i, url: 'https://www.taxscan.in/feed/' },
  { category: '인도',   country: '인도',   name: 'TaxGuru RSS', max: 4,
    filter: /classif|caar|tariff heading|hsn/i, url: 'https://taxguru.in/feed/' },
  { category: '중동',   country: '튀르키예', name: 'Google News Türkiye',
    url: _gnews('"tarife sınıflandırma" OR "bağlayıcı tarife bilgisi"', 'tr', 'TR', 'TR:tr') },
  { category: 'CIS',    country: '러시아', name: 'Google News Россия',
    url: _gnews('"классификационное решение" OR "ТН ВЭД" классификация', 'ru', 'RU', 'RU:ru') },
  { category: '유럽',   country: 'EU',     name: 'Google News Deutschland',
    url: _gnews('Zolltarif Einreihung Urteil', 'de', 'DE', 'DE:de') },
  { category: '중동',   country: '중동권', name: 'Google News العربية',
    url: _gnews('تصنيف جمركي', 'ar', 'EG', 'EG:ar') },
  { category: '글로벌', country: '글로벌', name: 'Google News Global',
    url: _gnews('"tariff classification" ruling OR decision', 'en-US', 'US', 'US:en') }
];

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
    category: '동북아', region: '한국', countryName: '한국',
    source  : '관세청 고시·보도자료 / 전문지',
    prompt  : 'Goal: find ALL Korean HS classification decisions and reported cases in the last {DAYS} days. ' +
              'Search strategy (run each, IN KOREAN): ' +
              '1) site:customs.go.kr 품목분류  ' +
              '2) "관세품목분류위원회" OR "품목분류 사전심사" 결정 {YEAR}  ' +
              '3) 품목분류 변경 고시 행정예고  ' +
              '4) 품목분류 쟁송 OR 심판 OR 소송 (한국관세신문·관세무역신문 등 전문지)  ' +
              '5) 조세심판원 OR 법원 품목분류 결정. ' +
              'Note: the CLIP database (unipass.customs.go.kr) is behind a search form and NOT indexed by Google — ' +
              'press releases, 고시/행정예고 notices and news are the findable sources.'
  },
  {
    category: '동북아', region: '일본',
    source  : 'Japan Customs 사전교시(事前教示)',
    prompt  : 'Goal: find ALL Japanese customs advance classification rulings (事前教示) and classification decisions in the last {DAYS} days. ' +
              'Search strategy (run each, IN JAPANESE): ' +
              '1) site:customs.go.jp 事前教示 回答事例  ' +
              '2) 事前教示 品目分類 {YEAR}  ' +
              '3) 関税分類 決定  ' +
              '4) 税関 品目分類 変更  ' +
              '5) English supplement: Japan customs classification ruling {YEAR}.'
  },

  // ── 중국 ──
  {
    category: '중국', region: '중국', countryName: '중국',
    source  : '海关总署 归类决定 / 전문지',
    prompt  : 'Goal: find ALL Chinese customs classification decisions (归类决定/商品归类) and reported cases in the last {DAYS} days. ' +
              'Search strategy (run each, IN CHINESE): ' +
              '1) site:customs.gov.cn 归类 公告  ' +
              '2) 海关总署公告 {YEAR} 归类决定  ' +
              '3) 商品归类决定 {YEAR}  ' +
              '4) 归类争议 OR 归类差错 案例  ' +
              '5) English supplement: China customs classification decision {YEAR}.'
  },

  // ── 북미 (판결·심판 — 일상적 CROSS 결정은 CBP API로 직수집) ──
  {
    category: '북미', region: '미국/캐나다 판결', isGroup: true,
    countries: ['미국', '캐나다'],
    source  : 'CIT/CAFC(미국) · CITT(캐나다) 분류 판결',
    prompt  : 'Goal: find US and Canadian tariff classification COURT/TRIBUNAL decisions in the last {DAYS} days. ' +
              'EXCLUDE routine CBP CROSS ruling letters (collected separately via API). ' +
              'Search strategy (run each): ' +
              '1) site:cit.uscourts.gov classification slip opinion {YEAR}  ' +
              '2) CAFC HTSUS classification opinion {YEAR}  ' +
              '3) site:citt-tcce.gc.ca tariff classification appeal  ' +
              '4) Lexology OR Mondaq US OR Canada tariff classification court  ' +
              '5) French: TCCE décision classement tarifaire. ' +
              'Each result MUST decide how a specific product is classified, not a tariff-rate/policy measure. ' +
              'Use the actual country name (미국 / 캐나다) in the country field.'
  },

  // ── 중남미 (통합) ──
  {
    category: '중남미', region: '중남미', isGroup: true,
    countries: ['멕시코', '브라질', '콜롬비아', '페루', '아르헨티나', '칠레', '파나마'],
    source  : 'RFB(브라질) / SAT(멕시코) / DIAN / SUNAT / 남미 관세당국',
    prompt  : 'Goal: find ALL Latin American tariff classification decisions in the last {DAYS} days ' +
              '(Mexico, Brazil, Colombia, Peru, Argentina, Chile, Panama). ' +
              'Search strategy (run each, IN PORTUGUESE/SPANISH): ' +
              '1) site:normas.receita.fazenda.gov.br "Solução de Consulta" classificação  ' +
              '2) "clasificación arancelaria" resolución (SAT OR DIAN OR SUNAT) {YEAR}  ' +
              '3) site:dof.gob.mx clasificación arancelaria criterio  ' +
              '4) Aduana Chile OR ANA Panamá OR Argentina resolución clasificación  ' +
              '5) notícias classificação NCM OR noticias clasificación arancelaria. ' +
              'Use the actual country name (멕시코 / 브라질 / 콜롬비아 / 페루 / 아르헨티나 / 칠레 / 파나마) in the country field.'
  },

  // ── 인도 (통합 — RSS 3개 피드가 뉴스를 별도 커버) ──
  {
    category: '인도', region: '인도', countryName: '인도',
    source  : 'CAAR / CESTAT / 세무 전문지',
    prompt  : 'Goal: find ALL Indian customs classification rulings in the last {DAYS} days — CAAR advance rulings, CESTAT decisions. ' +
              'Search strategy (run each): ' +
              '1) CAAR Mumbai OR Delhi advance ruling classification {YEAR}  ' +
              '2) CESTAT customs classification decision {YEAR}  ' +
              '3) site:taxguru.in OR site:taxscan.in CAAR classification  ' +
              '4) HSN classification ruling India {YEAR}  ' +
              '5) site:cbic.gov.in classification advance ruling.'
  },

  // ── 유럽 (통합 — EUR-Lex 분류규칙은 API 직수집, 영국 심판결정은 GOV.UK API 직수집) ──
  {
    category: '유럽', region: 'EU/영국', isGroup: true,
    countries: ['EU', '영국'],
    source  : 'CJEU · 회원국 법원 · UK FTT 분류 판결 / 로펌 얼럿',
    prompt  : 'Goal: find EU and UK tariff classification COURT decisions and professional alerts in the last {DAYS} days. ' +
              'EU Official Journal classification regulations and GOV.UK items are collected separately via API — focus on the rest. ' +
              'Search strategy (run each): ' +
              '1) site:curia.europa.eu Combined Nomenclature judgment  ' +
              '2) German: Zolltarif Einreihung Urteil Finanzgericht {YEAR}  ' +
              '3) Dutch: indeling gecombineerde nomenclatuur uitspraak / French: classement tarifaire arrêt  ' +
              '4) UK First-tier Tribunal tariff classification decision {YEAR}  ' +
              '5) Lexology OR Mondaq EU BTI tariff classification. ' +
              'Note: the EBTI database is NOT indexed by Google; HMRC ATaR rulings are not published — courts and press are the findable sources. ' +
              'Use EU or 영국 in the country field (member-state name goes in title_en).'
  },

  // ── 중동 (통합) ──
  {
    category: '중동', region: '중동', isGroup: true,
    countries: ['사우디아라비아', 'UAE', '튀르키예', '이집트', '요르단', '이라크', '모로코', '튀니지', '알제리', '파키스탄', '이스라엘'],
    source  : 'ZATCA / 두바이세관 / 튀르키예 GTB / 중동·북아프리카 관세당국',
    prompt  : 'Goal: find tariff classification decisions or reported cases across the Middle East in the last {DAYS} days ' +
              '(Saudi Arabia, UAE, Türkiye, Egypt, Jordan, Iraq, Morocco, Tunisia, Algeria, Pakistan, Israel). ' +
              'Search strategy (one per language bloc, run each): ' +
              '1) Arabic: تصنيف جمركي قرار {YEAR}  ' +
              '2) Turkish: bağlayıcı tarife bilgisi OR tarife sınıflandırma kararı  ' +
              '3) Turkish courts: Danıştay gümrük tarife pozisyonu karar  ' +
              '4) Pakistan FBR OR "Customs Appellate Tribunal" classification  ' +
              '5) English sweep: Middle East customs classification ruling {YEAR}. ' +
              'Most of these countries do not publish rulings — news and tribunal reports are the findable sources. ' +
              'Use the actual country name (사우디아라비아 / UAE / 튀르키예 / 이집트 / 요르단 / 이라크 / 모로코 / 튀니지 / 알제리 / 파키스탄 / 이스라엘) in the country field.'
  },

  // ── 동남아/오세아니아 (통합) ──
  {
    category: '동남아', region: '동남아/오세아니아', isGroup: true,
    countries: ['베트남', '인도네시아', '말레이시아', '태국', '필리핀', '싱가포르', '호주', '뉴질랜드'],
    source  : '베트남 분류결정문 / Bea Cukai / Tariff Commission / ABF·AAT',
    prompt  : 'Goal: find tariff classification decisions across Southeast Asia and Oceania in the last {DAYS} days ' +
              '(Vietnam, Indonesia, Malaysia, Thailand, Philippines, Singapore, Australia, New Zealand). ' +
              'Search strategy (one per language, run each): ' +
              '1) Vietnamese: "thông báo kết quả phân loại" OR "quyết định phân loại hàng hóa" (site:customs.gov.vn 우선)  ' +
              '2) Indonesian: penetapan klasifikasi barang keputusan {YEAR}  ' +
              '3) Thai: พิกัดศุลกากร คำวินิจฉัย / Malay: ketetapan kastam penjenisan  ' +
              '4) site:tariffcommission.gov.ph ruling OR AAT tribunal tariff classification decision  ' +
              '5) English sweep: ASEAN OR Australia OR "New Zealand" customs classification ruling {YEAR}. ' +
              'Vietnam publishes classification result notices actively — prioritize Vietnamese searches. ' +
              'Use the actual country name (베트남 / 인도네시아 / 말레이시아 / 태국 / 필리핀 / 싱가포르 / 호주 / 뉴질랜드) in the country field.'
  },

  // ── 아프리카 ──
  {
    category: '아프리카', region: '아프리카', isGroup: true,
    countries: ['남아프리카공화국', '나이지리아', '케냐'],
    source  : 'SARS(남아공) / Nigeria Customs / KRA(케냐)',
    prompt  : 'Goal: find tariff classification decisions or reported cases from South Africa, Nigeria, or Kenya in the last {DAYS} days. ' +
              'Search strategy (run each): ' +
              '1) site:sars.gov.za tariff classification  ' +
              '2) South Africa tariff classification court judgment {YEAR}  ' +
              '3) Nigeria customs classification decision news  ' +
              '4) Kenya KRA customs classification ruling news  ' +
              '5) Africa customs classification dispute {YEAR}. ' +
              'Use the actual country name (남아프리카공화국 / 나이지리아 / 케냐) in the country field.'
  },

  // ── CIS (EAEU 분류결정 중심) ──
  {
    category: 'CIS', region: 'CIS', isGroup: true,
    countries: ['러시아', '카자흐스탄', '우즈베키스탄'],
    source  : 'EAEU(ЕЭК) 분류결정 / ФТС / КГД',
    prompt  : 'Goal: find EAEU/CIS tariff classification decisions in the last {DAYS} days. ' +
              'PRIMARY source: Eurasian Economic Commission (ЕЭК) classification decisions — published regularly and indexed. ' +
              'Search strategy (run each, IN RUSSIAN): ' +
              '1) site:eec.eaeunion.org классификации решение  ' +
              '2) "решение Коллегии ЕЭК" классификация {YEAR}  ' +
              '3) классификационное решение ТН ВЭД {YEAR}  ' +
              '4) ФТС классификация товара решение новости  ' +
              '5) English supplement: EAEU classification decision {YEAR}. ' +
              'Use the actual country name (러시아 / 카자흐스탄 / 우즈베키스탄) in the country field (EAEU-wide → 러시아).'
  },

  // ── 글로벌 (통상 전문지/WCO — 공식 DB 미공개 국가 보완) ──
  {
    category: '글로벌', region: '글로벌 통상언론/WCO', isGroup: true,
    countries: [],
    source  : 'WCO / 글로벌 통상 전문지 / 로펌 Trade Alert',
    prompt  : 'Goal: find NEW or notable HS/tariff classification rulings, disputes or court decisions from ANY country reported in the last {DAYS} days by global professional media. ' +
              'Search strategy (run each): ' +
              '1) site:lexology.com tariff classification ruling {YEAR}  ' +
              '2) site:mondaq.com customs classification  ' +
              '3) WCO HS classification decisions news  ' +
              '4) trade alert tariff classification (KPMG OR EY OR Deloitte OR PwC OR "Sandler Travis")  ' +
              '5) customs classification dispute court decision {YEAR}. ' +
              'Do NOT report routine CBP CROSS ruling letters (collected separately). ' +
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
/**
 * 링크로 내보내도 되는 URL인지 판정 — "Page not found" 방지.
 * 접속 검증을 실제로 통과('OK'/'OK(API)')했거나, 안정적인 리다이렉터(news.google.com)인 경우만 신뢰.
 * 미검증('미검증'/'SKIP'/'')은 링크로 노출하지 않는다 — 모델이 지어낸 URL이 섞여 있을 수 있기 때문.
 */
function _isLinkTrusted(item) {
  if (!item.url || !/^https?:\/\//i.test(item.url)) return false;
  var st = String(item.url_status || '');
  if (st.indexOf('OK') === 0) return true;                       // 'OK', 'OK(API)'
  if (/^https?:\/\/news\.google\.com\//i.test(item.url)) return true; // 구글뉴스 리다이렉트는 항상 유효
  return false;
}

/** 수집 URL(검증 통과) 또는 공식 DB 직링크 중 가장 신뢰할 수 있는 원문 URL 반환 (없으면 '') */
function _directOriginalUrl(item) {
  if (_isLinkTrusted(item)) return item.url;
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

  // ① 수집된 원문 URL — 접속 검증을 통과한 링크만 노출 ("Page not found" 방지)
  if (_isLinkTrusted(item)) {
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

  var allResults = [];

  // ── 실행 순서: 무료·고속 직수집(공식 API·RSS)을 먼저 확보하고, 시간이 많이 드는
  //    Gemini 그라운딩은 남은 예산으로 수행 — 시간 초과 시에도 직수집분은 반드시 발송된다. ──

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
  if (USE_UK_GOVUK) {
    try {
      var uk = _collectGovUkDecisions(periodStart);
      allResults.push.apply(allResults, uk);
      Logger.log('[GOV.UK API] ' + uk.length + '건 수집');
    } catch (e) { Logger.log('[GOV.UK API] 오류: ' + e.message); }
  }
  if (USE_RSS_NEWS) {
    try {
      var rss = _collectRssNews(periodStart);
      allResults.push.apply(allResults, rss);
      Logger.log('[뉴스 RSS] ' + rss.length + '건 수집 (' + RSS_SOURCES.length + '개 피드)');
    } catch (e) { Logger.log('[뉴스 RSS] 오류: ' + e.message); }
  }

  // ── Gemini 그라운딩 보완 수집 — 직수집 확보 후 남은 시간예산으로 실행 ──
  Logger.log('[HSRulingMonitor] 직수집 완료(' + allResults.length + '건, ' +
             Math.round(_elapsedMs() / 1000) + '초 경과) — Gemini ' + MONITORING_REGIONS.length + '개 패스 시작');
  var requests = MONITORING_REGIONS.map(function(r) {
    return _buildRequest(r, apiKey, dateRangeStr, today.getFullYear());
  });
  var responses = _fetchAllInBatches(requests);

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

  // 3차: 같은 사건 중복 병합 — 여러 매체가 보도한 동일 사건, RSS·Gemini·공식 소스 간 중복을 하나로
  var uniq = _dedupSimilar(scoped);

  // 4차: 미검증 AI검색 항목 처리 (RECALL_MODE면 태깅만, 아니면 제외)
  var refined = _applyUnverifiedDrop(uniq);

  // 5차: 한국어 제목/요약 보강 — RSS·해외 소스 항목의 "제목 없음"/미번역 노출 방지
  _translateToKorean(refined);

  // 수집 파이프라인 통계 — 메일 헤더에 표기해 "어디서 몇 건이 걸러졌는지" 가시화
  var stats = {
    collected : allResults.length,
    deduped   : deduped.length,
    scoped    : scoped.length,
    similar   : scoped.length - uniq.length,
    final     : refined.length,
    unverified: refined.filter(function(r) { return r.unverified; }).length
  };

  _saveToSheet(refined, dateRangeStr);
  _sendEmail(refined, dateRangeStr, dupCount, stats);

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
    // 시간예산 소진 시 나머지 배치 생략 — 이미 받은 응답만으로 진행 (전체 유실 방지)
    if (start > 0 && _budgetLeft() < RETRY_TIME_RESERVE_MS) {
      Logger.log('[fetchAll] 시간예산 부족 — 배치 ' + Math.ceil(start / API_BATCH_SIZE) + '개 실행 후 중단 (' +
                 (requests.length - start) + '건 생략)');
      break;
    }
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
  // 검색어 × 페이지 조합으로 요청 생성.
  // ※ CROSS API의 page는 0부터 시작 (실측: totalHits>0인데 page=1이 빈 배열 → 0-인덱스 확인)
  //    CBP_PAGES=2면 page 0,1 요청 = 검색어당 최대 100건.
  var reqMeta = [];
  CBP_SEARCH_TERMS.forEach(function(term) {
    for (var p = 0; p < CBP_PAGES; p++) reqMeta.push({ term: term, page: p });
  });
  var reqs = reqMeta.map(function(m) {
    return {
      url: 'https://rulings.cbp.gov/api/search?term=' + encodeURIComponent(m.term) +
           '&collection=ALL&sortBy=DATE_DESC&pageSize=' + CBP_PAGE_SIZE + '&page=' + m.page,
      method: 'get', muteHttpExceptions: true,
      headers: { 'Accept': 'application/json' }
    };
  });

  // 배치 분할 + 429/5xx 재시도 재사용 (원래 단일 fetchAll은 재시도 없이 조용히 전체 실패했음)
  var resps = _fetchAllInBatches(reqs);

  // 전량 실패(0/전체 200) 시 — sortBy/collection 파라미터가 API와 안 맞을 가능성 →
  // 최소 파라미터(term/pageSize/page)로 1회 재시도하고, 첫 실패 응답을 진단 로그로 남긴다.
  var okCount = resps.filter(function(r) { return r && r.getResponseCode() === 200; }).length;
  if (okCount === 0 && resps.length) {
    var f = resps.filter(function(r) { return r; })[0];
    if (f) Logger.log('[CBP] 전량 실패 — 첫 응답 HTTP ' + f.getResponseCode() + ': ' +
                      f.getContentText().substring(0, 200));
    Logger.log('[CBP] 최소 파라미터로 재시도');
    reqs = reqMeta.map(function(m) {
      return {
        url: 'https://rulings.cbp.gov/api/search?term=' + encodeURIComponent(m.term) +
             '&pageSize=' + CBP_PAGE_SIZE + '&page=' + m.page,
        method: 'get', muteHttpExceptions: true,
        headers: { 'Accept': 'application/json' }
      };
    });
    resps = _fetchAllInBatches(reqs);
  }

  var bySeen = {};   // ruling number 기준 중복 제거 (검색어/페이지 간)
  var out    = [];
  var diagLogged = false;

  resps.forEach(function(resp, ti) {
    if (!resp || resp.getResponseCode() !== 200) {
      Logger.log('[CBP] "' + reqMeta[ti].term + '" p' + reqMeta[ti].page + ' HTTP ' + (resp ? resp.getResponseCode() : '없음'));
      return;
    }
    var data;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { return; }
    var rulings = data.rulings || data.results || data.Rulings || (data.data && data.data.rulings) || [];
    // 200인데 배열을 못 찾으면 응답 구조가 다른 것 — 최초 1회 구조를 로그로 남겨 필드 보정에 사용
    if (!rulings.length && !diagLogged) {
      diagLogged = true;
      Logger.log('[CBP][진단] 최상위 키: ' + Object.keys(data).join(', ') +
                 ' | 응답 앞부분: ' + resp.getContentText().substring(0, 300));
    }
    var kept = 0;

    rulings.forEach(function(r) {
      if (kept >= CBP_MAX_PER_TERM || out.length >= CBP_MAX_TOTAL) return;
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
/** CELLAR SPARQL 실행 → bindings 배열 반환 (실패 시 null, 0건이면 []) */
function _eurlexQuery(sparql, label) {
  var url = 'https://publications.europa.eu/webapi/rdf/sparql?query=' +
            encodeURIComponent(sparql) + '&format=application%2Fsparql-results%2Bjson' +
            '&timeout=30000';   // 서버측 타임아웃 30초 — 풀스캔성 쿼리가 2분+ 매달리는 것 방지

  var resp;
  try { resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true,
                                        headers: { 'Accept': 'application/sparql-results+json' } }); }
  catch (e) { Logger.log('[EU EUR-Lex] fetch 오류(' + label + '): ' + e.message); return null; }
  if (resp.getResponseCode() !== 200) {
    Logger.log('[EU EUR-Lex] HTTP ' + resp.getResponseCode() + ' (' + label + ')');
    return null;
  }
  try { return JSON.parse(resp.getContentText()).results.bindings || []; }
  catch (e) {
    Logger.log('[EU EUR-Lex] 파싱 오류(' + label + ') — 응답 앞부분: ' + resp.getContentText().substring(0, 200));
    return null;
  }
}

function _collectEuClassificationRegs(periodStart) {
  // 성능 원칙: CONTAINS(제목) 필터는 전체 DB 풀스캔을 유발하므로(실측 2분+ 소요),
  // 좁히는 조건(문서유형=시행규칙, 기간, 영어 표현)을 먼저 걸어 후보를 줄인 뒤 제목 필터를 적용한다.
  var since = _fmtDate(periodStart);
  var core =
    '  ?work cdm:resource_legal_id_celex ?celex . ' +
    '  ?work cdm:work_date_document ?date . ' +
    '  FILTER(?date >= "' + since + '"^^xsd:date) ' +
    '  ?exp cdm:expression_belongs_to_work ?work . ' +
    '  ?exp cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> . ' +
    '  ?exp cdm:expression_title ?title . ' +
    '  FILTER(CONTAINS(LCASE(STR(?title)), "classification of certain goods")) ';
  var prefix =
    'PREFIX cdm: <http://publications.europa.eu/ontology/cdm#> ' +
    'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> ' +
    'SELECT DISTINCT ?celex ?title ?date WHERE { ';
  var tail = '} ORDER BY DESC(?date) LIMIT ' + EURLEX_MAX;

  // 1차: 문서유형을 시행규칙(REG_IMPL)으로 한정한 빠른 쿼리
  var bindings = _eurlexQuery(
    prefix +
    '  ?work cdm:work_has_resource-type <http://publications.europa.eu/resource/authority/resource-type/REG_IMPL> . ' +
    core + tail, '1차/REG_IMPL');

  // 2차 폴백: 문서유형 한정 없이 (기간·영어 필터는 유지 — 풀스캔 아님)
  if (!bindings || !bindings.length) {
    Logger.log('[EU EUR-Lex] 1차 0건 — 문서유형 한정 없이 재시도');
    bindings = _eurlexQuery(prefix + core + tail, '2차/광역');
  }
  if (!bindings) return [];
  if (!bindings.length) {
    Logger.log('[EU EUR-Lex][진단] 기간 내 결과 0건 — 실제로 신규 분류규칙이 없거나 술어명(cdm) 변동. ' +
               'testEuEurlex() 실행으로 확인 가능');
    return [];
  }

  var sinceStr = _fmtDate(periodStart);
  var seen = {}, out = [];
  bindings.forEach(function(b) {
    var celex = b.celex && b.celex.value ? b.celex.value : '';
    var title = b.title && b.title.value ? b.title.value : '';
    var date  = b.date && b.date.value ? String(b.date.value).substring(0, 10) : '';
    if (!celex || seen[celex]) return;
    if (date && date < sinceStr) return;   // 기간 필터 (ISO 문자열 비교)
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

/**
 * 英 GOV.UK Search API 직수집 (무인증 JSON).
 * "tariff classification" 관련 심판결정(Tribunal decisions)·가이던스를 최신순으로 조회.
 * gov.uk 링크는 영구 URL — 접속 검증 생략.
 */
function _collectGovUkDecisions(periodStart) {
  var url = 'https://www.gov.uk/api/search.json?q=' + encodeURIComponent('"tariff classification"') +
            '&order=-public_timestamp&count=30' +
            '&fields=title&fields=link&fields=public_timestamp&fields=description';

  var resp;
  try { resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true }); }
  catch (e) { Logger.log('[GOV.UK] fetch 오류: ' + e.message); return []; }
  if (resp.getResponseCode() !== 200) {
    Logger.log('[GOV.UK] HTTP ' + resp.getResponseCode());
    return [];
  }
  var data;
  try { data = JSON.parse(resp.getContentText()); } catch (e) { return []; }

  var out = [];
  (data.results || []).forEach(function(r) {
    var ts = r.public_timestamp || '';
    var d  = ts ? new Date(ts) : null;
    if (d && !isNaN(d.getTime()) && d < periodStart) return;

    var title = String(r.title || '');
    var lowT  = title.toLowerCase();
    if (POLICY_EXCLUDE_TERMS.some(function(t) { return lowT.indexOf(t.trim()) !== -1; })) return;

    var link = String(r.link || '');
    if (link && link.charAt(0) === '/') link = 'https://www.gov.uk' + link;

    var item = {
      category       : '유럽',
      country        : '영국',
      source         : 'GOV.UK (HMRC/Tribunal)',
      ruling_number  : '',
      hs_code        : '',
      product_name   : '',
      product_name_en: '',
      company        : _detectCompany(title + ' ' + (r.description || '')),
      title          : '',
      title_en       : title,
      summary        : String(r.description || '').substring(0, 250),
      issue_date     : (d && !isNaN(d.getTime())) ? _fmtDate(d) : '',
      url            : link,
      url_source     : 'GOV.UK',
      url_status     : link ? URL_STATUS_OFFICIAL : '',
      provenance     : '공식'
    };
    item.importance = _autoImportance(item);
    out.push(item);
  });
  return out;
}

/**
 * 뉴스 RSS 직수집 (Google News RSS + 전문지 RSS).
 * Gemini와 달리 쿼리 결과를 결정적으로 전부 반환하므로, 지역 뉴스 커버리지의 바닥을 보장한다.
 * Google News 링크는 리다이렉트 URL이며 _verifyItemUrls가 최종 기사 URL로 해소한다.
 */
function _collectRssNews(periodStart) {
  var reqs = RSS_SOURCES.map(function(s) {
    return { url: s.url, method: 'get', muteHttpExceptions: true };
  });
  var resps = _fetchAllInBatches(reqs);

  var out = [];
  var byCountry = {};   // 국가당 총량 캡 — 피드가 여러 개인 국가(인도 등)의 편중 방지
  resps.forEach(function(resp, i) {
    var src = RSS_SOURCES[i];
    if (!resp || resp.getResponseCode() !== 200) {
      Logger.log('[RSS] ' + src.name + ' HTTP ' + (resp ? resp.getResponseCode() : '없음'));
      return;
    }
    var items;
    try {
      var root    = XmlService.parse(resp.getContentText()).getRootElement();
      var channel = root.getChild('channel');
      items = channel ? channel.getChildren('item') : [];
    } catch (e) {
      Logger.log('[RSS] ' + src.name + ' 파싱 오류: ' + e.message);
      return;
    }

    var feedCap = src.max || RSS_MAX_PER_FEED;
    var kept = 0;
    for (var j = 0; j < items.length && kept < feedCap; j++) {
      if ((byCountry[src.country] || 0) >= RSS_MAX_PER_COUNTRY) break;
      var el    = items[j];
      var title = String(el.getChildText('title') || '').trim();
      var link  = String(el.getChildText('link') || '').trim();
      var pub   = String(el.getChildText('pubDate') || '').trim();
      var desc  = String(el.getChildText('description') || '')
                    .replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
                    .replace(/\s+/g, ' ').trim();
      if (!title || !link) continue;

      // Google News 제목은 "제목 - 매체명" 형식 — 매체명을 분리해 출처로 쓰고, 제목은 정제
      // (같은 사건을 다룬 다른 매체 기사의 유사도 판정 정확도가 올라간다)
      var publisher = '';
      var tm = title.match(/^(.+)\s-\s([^\-]{2,60})$/);
      if (tm && tm[1].length >= 8) { title = tm[1].trim(); publisher = tm[2].trim(); }

      var d = pub ? new Date(pub) : null;
      if (d && !isNaN(d.getTime()) && d < periodStart) continue;       // 기간 밖
      if (src.filter && !src.filter.test(title)) continue;              // 범용 피드는 제목 필터
      var lowT = title.toLowerCase();
      if (POLICY_EXCLUDE_TERMS.some(function(t) { return lowT.indexOf(t.trim()) !== -1; })) continue;

      kept++;
      byCountry[src.country] = (byCountry[src.country] || 0) + 1;
      var item = {
        category       : src.category,
        country        : src.country,
        source         : src.name,
        ruling_number  : '',
        hs_code        : '',
        product_name   : '',
        product_name_en: '',
        company        : _detectCompany(title + ' ' + desc),
        title          : src.ko ? title : '',
        title_en       : src.ko ? '' : title,
        summary        : desc.substring(0, 200),
        issue_date     : (d && !isNaN(d.getTime())) ? _fmtDate(d) : '',
        url            : link,
        url_source     : publisher || src.name,
        url_status     : '',
        provenance     : '뉴스RSS',
        // base64 인코딩된 구글뉴스 링크에서 원 기사 URL을 best-effort 추출 — 같은 기사 중복 판정에 사용
        canonical_url  : _decodeGnewsUrl(link)
      };
      item.importance = _autoImportance(item);
      out.push(item);
    }
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
      if (m.pass) {
        it.match_reason = m.reason;
      } else if (RECALL_MODE) {
        // 수집량 우선: 코드 키워드에 안 걸려도 버리지 않음 — Gemini 프롬프트의 A/B/C 조건을
        // 이미 통과한 결과이므로(대부분 현지어라 영어 키워드 미스), 태깅만 하고 유지한다.
        it.match_reason = '모델판정(키워드 미매칭)';
      } else {
        dropScope++; return;
      }
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
    if (it.provenance === 'AI검색' && (!hasUrl || failed)) {
      if (RECALL_MODE) {
        // 수집량 우선: 버리지 않고 '미검증' 표시로 구분만 — 이메일에 별도 배지로 표기됨
        it.unverified = true;
        it.url_status = it.url_status || '미검증';
      } else if (DROP_UNVERIFIED_AI && it.importance !== '상') {
        dropUnverified++; return;
      } else {
        it.unverified = true;
        it.url_status = it.url_status || '미검증';
      }
    }
    out.push(it);
  });
  Logger.log('[refine] 미검증 제외 ' + dropUnverified + '건 → 최종 ' + out.length + '건');
  return out;
}

// ─── 유사 중복(같은 사건·다른 매체) 병합 ─────────────────────────────────────

/** Google News 기사 링크(base64 인코딩)에서 원 기사 URL을 best-effort 추출 (실패 시 '') */
function _decodeGnewsUrl(link) {
  try {
    var m = String(link).match(/\/articles\/([A-Za-z0-9_\-]+)/);
    if (!m) return '';
    var b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bytes = Utilities.base64Decode(b64);
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i] & 255;
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '\n';
    }
    var um = s.match(/https?:\/\/[^\s"'\\]{12,500}/);
    return um ? um[0] : '';
  } catch (e) { return ''; }
}

/** URL 정규화(프로토콜·www·utm·해시 제거) — 같은 기사의 표기 차이 병합용 */
function _normUrl(u) {
  var s = String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('#')[0];
  s = s.replace(/([?&])(utm_[^=&]+|fbclid|gclid)=[^&]*/g, '$1').replace(/[?&]+$/, '');
  return s.replace(/\/+$/, '');
}

/** 제목 → 비교용 토큰 집합. 공백 분리가 안 되는 CJK·짧은 제목은 문자 바이그램 사용 */
function _titleShingles(item) {
  var t = String(item.title_en || item.title || '').toLowerCase()
    .replace(/[^0-9a-zÀ-ɏ가-힣぀-ヿ一-鿿]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!t) return null;
  var words = t.split(' ');
  var set = {};
  if (words.length >= 5) {
    words.forEach(function(w) { if (w.length > 1) set[w] = true; });
  } else {
    var chars = t.replace(/ /g, '');
    if (chars.length < 6) return null;   // 너무 짧은 제목은 유사도 판정 제외(오병합 방지)
    for (var i = 0; i < chars.length - 1; i++) set[chars.substr(i, 2)] = true;
  }
  return set;
}

function _jaccard(a, b) {
  var inter = 0, uni = 0, k;
  for (k in a) { uni++; if (b[k]) inter++; }
  for (k in b) { if (!a[k]) uni++; }
  return uni ? inter / uni : 0;
}

// ─── 한국어 번역 보강 ────────────────────────────────────────────────────────

function _hasHangul(s) { return /[가-힣]/.test(String(s || '')); }

/**
 * 발송 직전, 한국어 제목이 없는 항목의 제목·요약을 LanguageApp(구글 번역 내장)으로 한국어화.
 * 원문 제목은 title_en에 그대로 보존되므로 정보 손실 없음. 쿼터/시간예산 내에서만 수행하고,
 * 오류 시 조용히 중단(번역은 부가 기능 — 실패해도 발송은 진행).
 */
function _translateToKorean(items) {
  if (!TRANSLATE_TO_KO) return;
  var calls = 0;
  for (var i = 0; i < items.length; i++) {
    if (calls >= TRANSLATE_MAX) { Logger.log('[translate] 상한 도달(' + TRANSLATE_MAX + ') — 이후 항목 생략'); break; }
    if (_budgetLeft() < 15000) { Logger.log('[translate] 시간예산 부족 — 중단'); break; }
    var it = items[i];
    try {
      if (!it.title && it.title_en && !_hasHangul(it.title_en)) {
        it.title = LanguageApp.translate(String(it.title_en).substring(0, 200), '', 'ko');
        calls++;
      }
      if (it.summary && !_hasHangul(it.summary)) {
        it.summary = LanguageApp.translate(String(it.summary).substring(0, 180), '', 'ko');
        calls++;
      }
    } catch (e) {
      Logger.log('[translate] 오류 — 이후 번역 생략: ' + e.message);
      break;
    }
  }
  if (calls) Logger.log('[translate] ' + calls + '개 필드 한국어 번역 완료');
}

/** 대표 항목 점수: 공식 > 뉴스RSS > AI검색 → 중요도 → 검증된 링크 보유 → 요약 길이 */
function _repScore(it) {
  var prov = it.provenance === '공식' ? 3 : it.provenance === '뉴스RSS' ? 2 : 1;
  var imp  = it.importance === '상' ? 3 : it.importance === '중' ? 2 : 1;
  return prov * 1000 + imp * 100 + (_isLinkTrusted(it) ? 10 : 0) +
         Math.min(9, Math.floor(String(it.summary || '').length / 40));
}

/**
 * 같은 사건을 다룬 항목들(여러 매체 보도, RSS·Gemini·공식 소스 간 중복)을 하나로 병합.
 *  ① 정규화 URL(디코드된 원 기사 URL 포함)이 같으면 → 같은 항목
 *  ② 같은 국가 안에서 제목 유사도(Jaccard ≥ 0.55)면 → 같은 사건.
 *     단, 서로 다른 룰링번호를 가진 항목은 병합하지 않음(정형화된 제목의 별개 룰링 보호).
 * 대표는 공식 > 뉴스RSS > AI검색 순으로 남기고, 대표에 없는 필드(hs_code 등)는 병합해 채운다.
 */
function _dedupSimilar(items) {
  var n = items.length;
  if (n < 2) return items.slice();

  var parent = [];
  for (var p = 0; p < n; p++) parent[p] = p;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { parent[find(a)] = find(b); }

  // ① 정규화 URL 동일 → 병합 (구글뉴스 리다이렉트 도메인은 키로 쓰지 않음)
  var byUrl = {};
  items.forEach(function(it, i) {
    [_normUrl(it.canonical_url || ''), _normUrl(it.url || '')].forEach(function(k) {
      if (!k || k.indexOf('news.google.com') === 0) return;
      if (byUrl[k] !== undefined) union(i, byUrl[k]); else byUrl[k] = i;
    });
  });

  // ② 같은 국가 내 제목 유사 → 병합
  var shs = items.map(_titleShingles);
  for (var i = 0; i < n; i++) {
    if (!shs[i]) continue;
    for (var j = i + 1; j < n; j++) {
      if (!shs[j] || items[i].country !== items[j].country) continue;
      var ni = String(items[i].ruling_number || ''), nj = String(items[j].ruling_number || '');
      if (ni && nj && ni !== nj) continue;   // 번호가 다르면 별개 룰링
      if (find(i) === find(j)) continue;
      if (_jaccard(shs[i], shs[j]) >= 0.55) union(i, j);
    }
  }

  // 클러스터별 대표 선정 + 부족 필드 병합
  var repOf = {};
  items.forEach(function(it, i) {
    var r = find(i);
    if (repOf[r] === undefined || _repScore(it) > _repScore(items[repOf[r]])) repOf[r] = i;
  });
  var merged = 0, out = [];
  items.forEach(function(it, i) {
    var rep = items[repOf[find(i)]];
    if (rep === it) { out.push(it); return; }
    merged++;
    ['hs_code', 'company', 'ruling_number', 'product_name', 'product_name_en'].forEach(function(f) {
      if (!rep[f] && it[f]) rep[f] = it[f];
    });
  });
  if (merged) Logger.log('[dedupSimilar] 같은 사건 중복 ' + merged + '건 병합 → ' + out.length + '건');
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
    // 구글뉴스 리다이렉트 링크는 항상 유효 — 검증 예산을 아끼고 OK 처리 (원 기사 URL은 canonical_url로 중복판정)
    if (/^https?:\/\/news\.google\.com\//i.test(it.url)) { it.url_status = 'OK'; return; }
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

    '[ SEARCH RULES — critical for finding results ]\n' +
    '1. Run AT LEAST 5 SEPARATE searches, following the numbered search strategy in the target section above.\n' +
    '2. Search in the LOCAL LANGUAGE of the target country FIRST (Korean, Japanese, Chinese, Portuguese, Spanish, Vietnamese, Russian, Turkish, Arabic...). Add 1-2 English searches only as a supplement.\n' +
    '3. Keep search queries BROAD: search for ALL recent classification decisions from the authority. Do NOT put product names or company names into the search queries — they are reporting filters, not search filters. Narrow queries return nothing.\n' +
    '4. Google cannot filter by date. Determine each item\'s date from the page content itself, and prefer items dated within the period.\n\n' +

    '[ MANDATORY GATE — collect ONLY genuine HS classification rulings ]\n' +
    'Every item MUST be a specific HS/tariff CLASSIFICATION decision — i.e. a customs authority advance/binding classification ruling, ' +
    'a classification determination, or a court/tribunal judgment deciding which HS heading/subheading a specific product falls under. ' +
    'Each item MUST be tied to an identifiable product and (ideally) an HS code.\n' +
    'STRICTLY EXCLUDE general tariff/trade policy that is NOT a product classification decision: ' +
    'tariff-rate or duty-rate changes, antidumping/countervailing/safeguard duties, Section 301/232/201 actions, reciprocal/IEEPA tariffs, ' +
    'quotas, customs fees, drawback, de minimis, FTA/preferential-origin or rules-of-origin, export controls, sanctions, ' +
    'general trade statistics, agendas, or meeting/comment notices. If an item is not a product classification ruling, DO NOT include it.\n\n' +

    '[ PRIORITY CRITERIA — importance markers, NOT exclusion filters ]\n' +
    'Report EVERY genuine classification ruling that passes the mandatory gate above. The lists below only set ' +
    'PRIORITY (importance) — NEVER omit a classification ruling merely because it matches none of them; ' +
    'such rulings are still wanted, with importance "하".\n\n' +

    '▶ A. High priority if the ruling relates to ANY of the following products:\n' +
    '   Smartphone, mobile phone, tablet, smartwatch, smart glasses, Bluetooth earphones, earbuds,\n' +
    '   air conditioner, heat pump, chiller, oven, refrigerator, vacuum cleaner,\n' +
    '   TV, television, monitor, soundbar, interactive whiteboard (electronic whiteboard),\n' +
    '   air dresser (clothing care machine), shoe dresser (shoe care machine), camera,\n' +
    '   mock-up (display model / non-functional sample),\n' +
    '   5G base station, antenna, wireless communication equipment, X-ray equipment, medical imaging device\n\n' +

    '▶ B. Highest priority if ANY of the following companies is mentioned as applicant or related party:\n' +
    '   Apple, Samsung, LG Electronics, Huawei, Xiaomi, Oppo, Vivo,\n' +
    '   Whirlpool, General Electric, Haier\n\n' +

    '▶ C. Also relevant if the ruling involves a product classified under HS Chapter 39, 40, 42, 72, 73, 83, 84, 85, 90, 91 or 94\n\n' +

    '[ OUTPUT INSTRUCTIONS ]\n' +
    '1. Report ONLY rulings you actually found in the web search results. NEVER fabricate rulings, ruling numbers, dates, HS codes or URLs.\n' +
    '2. "url" field — CRITICAL: copy the EXACT URL of the web page where you found this ruling, taken directly from your search results. ' +
       'If you are not 100% sure of the exact URL, set "url" to "" (empty string). NEVER construct, guess or recall a URL from memory.\n' +
    '3. "url_source": the name of the website/publication the url belongs to (e.g., "CBP CROSS", "Lexology", "관세청 보도자료"). Empty if url is empty.\n' +
    '4. "importance": rate each ruling — "상" if a monitored company (Samsung, LG Electronics, Apple, etc.) is directly involved as applicant/party, ' +
       'or the classification of a core monitored product was changed or disputed; "중" if it concerns a monitored product category; ' +
       '"하" if relevant only by HS chapter OR if it matches none of the priority criteria. Use exactly one of: 상 / 중 / 하.\n' +
    '5. Be EXHAUSTIVE: report EVERY distinct ruling you find in the search results — do NOT summarize down to a few highlights. ' +
       'Return up to 25 rulings, most recent first.\n' +
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
    generationConfig: { temperature: 0, maxOutputTokens: 8192 }  // 25건 JSON에 충분 — 출력 토큰 비용 절감
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

function _sendEmail(results, dateRangeStr, dupCount, stats) {
  var recipients = _getRecipients();
  if (!recipients.length) return;
  var html    = _buildEmailHtml(results, dateRangeStr, dupCount || 0, stats);
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
  // 출처유형: 공식(검증) / 뉴스RSS / AI검색 — 신뢰도 구분. 원문 URL 미확인 항목은 '미검증'을 별도 표기.
  if (item.provenance === '공식') badges += _badge('공식·검증', '#1b5e3b', '#e7f4ec', '#bfe0cc');
  else if (item.provenance === '뉴스RSS') badges += _badge('뉴스·RSS', '#0d5c63', '#e4f3f4', '#bcdfe2');
  else if (item.provenance === 'AI검색') badges += _badge('AI검색', '#6d3b00', '#fbf0e3', '#e7cfb0');
  if (item.unverified || String(item.url_status || '') === '미검증') {
    badges += _badge('원문 미확인', '#8a6d00', '#fdf8e3', '#e8d98a');
  }
  if (item.hs_code) badges += _badge('HS ' + _escapeHtml(item.hs_code), '#15418c', '#e8eef7', '#c9d6ea');
  if (item.company) badges += _badge(_escapeHtml(item.company), '#7b3000', '#fdf3e7', '#ecd9c0');
  if (item.ruling_number) {
    badges += '<span style="font-size:11px;color:#8a93a3;">[' + _escapeHtml(item.ruling_number) + ']</span>';
  }

  // 메인 제목: 한국어 제목 → 원문 제목 순으로 폴백 ("제목 없음" 노출 방지).
  // 부제목(원문)은 메인이 한국어일 때만 표시해 같은 문구가 두 번 나오지 않게 한다.
  var koText   = item.title || item.product_name || '';
  var enText   = item.title_en || item.product_name_en || '';
  var mainText = _escapeHtml(koText || enText || '(제목 정보 없음)');
  var titleEn  = (koText && enText) ? _escapeHtml(enText) : '';
  var directUrl = _directOriginalUrl(item);
  var titleHtml = directUrl
    ? '<a href="' + _escapeHtml(directUrl) + '" target="_blank" style="color:#15418c;text-decoration:underline;">' + mainText + '</a>'
    : '<span style="color:#1f2733;">' + mainText + '</span>';

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

function _buildEmailHtml(results, dateRangeStr, dupCount, stats) {
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
    (stats
      ? '<div style="font-size:11px;color:#5d7a68;line-height:1.7;margin-top:3px;">' +
          '수집 파이프라인&nbsp;:&nbsp;수집 ' + stats.collected + '건 → 중복 제외 후 ' + stats.deduped +
          '건 → 스코프 통과 ' + stats.scoped + '건' +
          (stats.similar > 0 ? ' → 같은 사건 ' + stats.similar + '건 병합' : '') +
          ' → 최종 <b>' + stats.final + '</b>건' +
          (stats.unverified > 0 ? ' (이 중 원문 미확인 ' + stats.unverified + '건 포함)' : '') +
        '</div>'
      : '') +
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
    'https://rulings.cbp.gov/api/search?term=smartphone&collection=ALL&sortBy=DATE_DESC&pageSize=3&page=0',
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

/** 뉴스 RSS 직수집 확인용 — 피드별 수집 건수와 샘플을 로그로 출력 */
function testRssNews() {
  EXEC_START_MS = new Date().getTime();
  var items = _collectRssNews(new Date(Date.now() - MONITORING_DAYS * 24 * 60 * 60 * 1000));
  Logger.log('[testRssNews] 총 ' + items.length + '건 (' + RSS_SOURCES.length + '개 피드)');
  var byFeed = {};
  items.forEach(function(it) { byFeed[it.source] = (byFeed[it.source] || 0) + 1; });
  Object.keys(byFeed).forEach(function(k) { Logger.log('  ' + k + ': ' + byFeed[k] + '건'); });
  items.slice(0, 8).forEach(function(it) {
    Logger.log('  - [' + it.country + '] ' + (it.title || it.title_en) + ' | ' + it.issue_date);
  });
}

/** GOV.UK Search API 직수집 확인용 */
function testGovUk() {
  var items = _collectGovUkDecisions(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  Logger.log('[testGovUk] 최근 90일 ' + items.length + '건');
  items.slice(0, 8).forEach(function(it) {
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
