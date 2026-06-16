# 수입모델 인증 확인 (KC 안전인증 · 전파인증)

수입 전자제품의 **모델 full code**(예: `SM-X300akak`)가
1. **KC 전기용품 안전인증**
2. **전파인증(방송통신기자재 적합성평가)**

을 받았는지, 공공데이터포털 Open API 로 조회해 한 번에 표로 확인하는 로컬 웹앱.

## 왜 단순 검색이 안 되나

인증 DB에는 보통 full code 가 아니라 **basic code**(`SM-X300`)나 그 **파생모델**(`SM-X306`)로
등록돼 있습니다. 그래서 이 앱은 단순 일치가 아니라:

| 매칭 유형 | 의미 | 예 |
|---|---|---|
| `exact` | 완전 일치 | `SM-X300` = `SM-X300` |
| `prefix` | **내 full code 가 인증 모델로 시작** (가장 흔함) | `SM-X300akak` ⊃ `SM-X300` |
| `reverse_prefix` | full code 가 인증 모델의 접두 (약한 매칭, 확인필요) | 참고용 |

하이픈/공백 차이는 무시하고 비교합니다(`SM-X300` = `SMX300`).
오탐 방지를 위해 `prefix` 매칭은 매칭 길이가 `MIN_PREFIX_LEN`(기본 5) 이상일 때만 인정합니다.

### 결과 상태 (status)

컴플라이언스 도구이므로 **"조회 실패"와 "인증 없음"을 명확히 구분**합니다.

| status | 의미 |
|---|---|
| `certified` | 인증 확인됨 (exact/prefix) — 공식 원본 확인 링크 제공 |
| `review` | 유사 매칭(reverse_prefix), 사람이 확인 필요 |
| `not_found` | 조회 성공했으나 인증 없음 |
| `error` | ⚠️ API 오류로 **확인 불가** (인증 없음으로 단정 금지) |
| `skipped` | API URL 미설정 |

## 빠른 시작 (데모 모드)

API 키 없이도 내장 샘플 DB로 바로 동작합니다.

```bash
pip install -r requirements.txt
python app.py
# http://127.0.0.1:5000
```

입력창에 아래를 붙여넣거나 `samples/models.csv` 를 업로드해 보세요:

```
SM-X300akak   → KC ○ / 전파 ○ (basic SM-X300 매칭)
SM-X306abc    → KC ✗ / 전파 ○ (파생 SM-X306 매칭)
SM-S921xyz    → KC ✗ / 전파 ○
EP-TA800qq    → KC ○ / 전파 ✗
SM-A999zzz    → 둘 다 ✗
```

## 실제 API 연결

1. [공공데이터포털](https://www.data.go.kr) 가입 후 아래 두 데이터 **활용신청**:
   - 전파인증: **국립전파연구원\_적합성평가 DB정보** (`data.go.kr/data/3034183`)
   - KC: **국가기술표준원\_제품 안전인증 및 리콜 정보** (`data.go.kr/data/15116894`)
2. `.env.example` 을 `.env` 로 복사하고 값 채우기:
   ```bash
   cp .env.example .env
   ```
   - `DATA_GO_KR_SERVICE_KEY` : 발급받은 일반 인증키 (두 API 공용)
   - `RRA_API_URL`, `KC_API_URL` : 각 활용신청 상세의 **요청주소(End Point)** 그대로
3. 활용신청 상세의 **요청변수/출력결과** 와 실제 필드명이 다르면
   `cert_client.py` 상단 `ENDPOINTS` 딕셔너리의 `search_param`, `*_field` 만 수정하면 됩니다.
   (키가 설정되면 데모 모드는 자동 해제됩니다.)

> 두 API의 정확한 파라미터/응답 필드명은 활용신청 후에만 확정 확인이 가능해
> 합리적 기본값으로 넣어 두었습니다. 위 3번에서 한 번만 맞추면 됩니다.

## 사용

- 모델 코드를 줄바꿈으로 여러 개 입력하거나 CSV 업로드 → **조회**
- 결과 표에서 KC/전파 인증 보유 여부, 매칭된 모델명, 인증번호 확인
- **결과 CSV 내려받기** 로 저장

## 구성

| 파일 | 역할 |
|---|---|
| `app.py` | Flask 웹 서버 / 입력 파싱 |
| `cert_client.py` | API 호출 + **코드 매칭 로직** (핵심) |
| `demo_data.py` | 키 없을 때 쓰는 샘플 DB |
| `templates/index.html` | 화면 |
| `test_matching.py` | 매칭/검색 로직 테스트 (`python test_matching.py`) |
| `test_cert.py` | 상태 판정 · Flask 계층 테스트 (`python test_cert.py`) |
| `Dockerfile` / `.github/workflows/ci.yml` | 컨테이너 빌드 · CI |

## Docker

```bash
docker build -t hscode .
docker run -p 5000:5000 --env-file .env hscode   # http://127.0.0.1:5000
```

## 참고

- 전파인증 적합성평가 현황: <https://www.rra.go.kr/ko/license/A_c_search.do>
- KC 인증정보 검색(SafetyKorea): <https://www.safetykorea.kr/release/itemSearch>
- 적합성평가 DB Open API: <https://www.data.go.kr/data/3034183/openapi.do>
- 제품 안전인증 및 리콜 정보 API: <https://www.data.go.kr/data/15116894/openapi.do>
