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
