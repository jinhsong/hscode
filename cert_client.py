"""
인증 조회 클라이언트 + 코드 매칭 로직.

수입 모델의 full code(예: SM-X300akak)가
  1) KC 전기용품 안전인증
  2) 전파인증(방송통신기자재 적합성평가)
를 받았는지, 인증 DB에 등록된 basic code / derivative code 와 비교해서 판정한다.

핵심:
- 인증 DB에는 보통 full code 가 아니라 basic code(SM-X300) 또는 파생모델(SM-X306)로 등록된다.
- 따라서 단순 일치(exact)뿐 아니라 "내 full code 가 등록된 모델명으로 시작하는가"(prefix)를
  같이 보고 신뢰도를 함께 반환한다.

※ 두 Open API 의 정확한 엔드포인트 URL / 파라미터 이름은 공공데이터포털 '활용신청' 후
  상세 페이지의 '요청주소(End Point)'와 '요청변수(Request Parameter)'에서 확정해야 한다.
  아래 ENDPOINTS 딕셔너리만 수정하면 된다. (값을 비워두면 해당 인증은 'SKIPPED' 처리)
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field, asdict
from typing import Optional

import requests

try:  # .env 가 있으면 자동 로드 (없어도 동작)
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass


# ---------------------------------------------------------------------------
# 설정: 공공데이터포털에서 발급받은 값으로 채운다.
# ---------------------------------------------------------------------------

# 공공데이터포털(data.go.kr) 일반 인증키. RRA / KATS 데이터 모두 동일 키로 호출된다.
SERVICE_KEY = os.environ.get("DATA_GO_KR_SERVICE_KEY", "")

# 각 API의 요청주소/파라미터. 활용신청 상세 페이지의 값으로 맞춘다.
#   - search_param : 모델명으로 검색할 때 쓰는 요청변수 이름
#   - basic_field / deriv_field / certnum_field / name_field : 응답 항목(item) 안의 키 이름
ENDPOINTS = {
    # 전파인증: 국립전파연구원_적합성평가 DB정보  (data.go.kr/data/3034183)
    "rra": {
        "label": "전파인증(적합성평가)",
        "url": os.environ.get("RRA_API_URL", ""),  # 예: http://apis.data.go.kr/.../getList
        "search_param": os.environ.get("RRA_SEARCH_PARAM", "searchVal"),
        "basic_field": "basicMdlNm",     # 기본모델명
        "deriv_field": "drvtMdlNm",      # 파생모델명(여러 개면 콤마/슬래시 등으로 연결됨)
        "certnum_field": "cnfmKsgsno",   # 인증/등록번호
        "name_field": "eqpmnNm",         # 기자재명칭
        "maker_field": "mnfctrNm",       # 제조자
    },
    # KC 안전인증: 국가기술표준원_제품 안전인증 및 리콜 정보 (data.go.kr/data/15116894)
    "kc": {
        "label": "KC 안전인증",
        "url": os.environ.get("KC_API_URL", ""),
        "search_param": os.environ.get("KC_SEARCH_PARAM", "modelNm"),
        "basic_field": "modelNm",        # 모델명
        "deriv_field": "",               # KC 데이터엔 파생모델 컬럼이 별도로 없을 수 있음
        "certnum_field": "certNum",      # 인증번호
        "name_field": "productNm",       # 제품명
        "maker_field": "makerNm",        # 제조사
    },
}


# ---------------------------------------------------------------------------
# 코드 정규화 & 매칭
# ---------------------------------------------------------------------------

def normalize(code: str) -> str:
    """비교용 정규화: 대문자화 + 영숫자만 남김 (하이픈/공백 차이 흡수)."""
    return re.sub(r"[^A-Z0-9]", "", (code or "").upper())


def split_models(value: str) -> list[str]:
    """파생모델 필드처럼 여러 모델이 한 칸에 들어온 경우 분해."""
    if not value:
        return []
    return [p.strip() for p in re.split(r"[,/;|\s]+", value) if p.strip()]


@dataclass
class MatchResult:
    full_code: str
    matched_model: Optional[str] = None     # DB상에서 매칭된 모델명
    match_type: Optional[str] = None        # exact | prefix | reverse_prefix | None
    cert_num: Optional[str] = None
    product_name: Optional[str] = None
    maker: Optional[str] = None

    @property
    def certified(self) -> bool:
        return self.match_type is not None


def match_full_code(full_code: str, db_models: list[str]) -> tuple[Optional[str], Optional[str]]:
    """
    full_code 를 인증 DB 의 모델명 목록(db_models)과 비교.
    반환: (매칭된 모델명, 매칭 유형) 또는 (None, None)

    매칭 유형:
      exact          : 완전 일치
      prefix         : DB모델이 full_code 의 접두 (SM-X300akak ⊃ SM-X300)  ← 가장 흔한 케이스
      reverse_prefix : full_code 가 DB모델의 접두 (참고용, 약한 매칭)
    """
    fn = normalize(full_code)
    if not fn:
        return None, None

    best: tuple[Optional[str], Optional[str]] = (None, None)
    for m in db_models:
        mn = normalize(m)
        if not mn:
            continue
        if fn == mn:
            return m, "exact"               # 즉시 확정
        if fn.startswith(mn) and best[1] != "prefix":
            best = (m, "prefix")
        elif mn.startswith(fn) and best[1] is None:
            best = (m, "reverse_prefix")
    return best


# ---------------------------------------------------------------------------
# API 호출
# ---------------------------------------------------------------------------

def _build_search_terms(full_code: str) -> list[str]:
    """
    API 검색용 키워드 후보. full code 로는 DB 적중이 안 될 수 있어
    뒤쪽 영소문자/접미 토큰을 떼어낸 접두 후보들을 함께 만든다.
      SM-X300akak -> ['SM-X300akak', 'SM-X300']
    """
    terms = [full_code]
    trimmed = re.sub(r"[a-z]+$", "", full_code).rstrip("-_ ")
    if trimmed and trimmed != full_code:
        terms.append(trimmed)
    return terms


def _http_get_items(cfg: dict, search_value: str, num_rows: int = 100) -> list[dict]:
    """공공데이터포털 표준 응답에서 item 리스트만 추출 (JSON 가정)."""
    params = {
        "serviceKey": SERVICE_KEY,
        "pageNo": 1,
        "numOfRows": num_rows,
        "type": "json",
        cfg["search_param"]: search_value,
    }
    resp = requests.get(cfg["url"], params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json()

    # 표준 구조: response.body.items.item  (단건이면 dict, 다건이면 list)
    body = (data.get("response", data)).get("body", data)
    items = body.get("items", body.get("item", []))
    if isinstance(items, dict):
        items = items.get("item", items)
    if isinstance(items, dict):
        items = [items]
    return items or []


DEMO_MODE = not SERVICE_KEY  # 키 없으면 demo_data 로 동작


def check_one(full_code: str, cfg: dict, kind: str) -> MatchResult:
    """단일 인증(cfg)에 대해 full_code 조회. kind: 'kc' | 'rra'"""
    result = MatchResult(full_code=full_code)
    if not DEMO_MODE and not cfg.get("url"):
        result.product_name = "(SKIPPED: API URL 미설정)"
        return result

    for term in _build_search_terms(full_code):
        try:
            if DEMO_MODE:
                import demo_data
                items = demo_data.search(kind, term)
            else:
                items = _http_get_items(cfg, term)
        except Exception as e:  # 네트워크/파싱 오류는 해당 term 건너뜀
            result.product_name = f"(오류: {e})"
            continue
        if not items:
            continue

        for it in items:
            db_models = [it.get(cfg["basic_field"], "")]
            if cfg.get("deriv_field"):
                db_models += split_models(it.get(cfg["deriv_field"], ""))
            matched, mtype = match_full_code(full_code, db_models)
            if matched:
                result.matched_model = matched
                result.match_type = mtype
                result.cert_num = it.get(cfg["certnum_field"])
                result.product_name = it.get(cfg["name_field"])
                result.maker = it.get(cfg["maker_field"])
                if mtype == "exact":
                    return result   # 더 볼 것 없음
        if result.certified:
            break
    return result


def check_model(full_code: str) -> dict:
    """모델 하나에 대해 KC + 전파 인증을 모두 조회한 종합 결과."""
    full_code = full_code.strip()
    kc = check_one(full_code, ENDPOINTS["kc"], "kc")
    rra = check_one(full_code, ENDPOINTS["rra"], "rra")
    return {
        "full_code": full_code,
        "kc": asdict(kc),
        "rra": asdict(rra),
    }


def check_models(codes: list[str]) -> list[dict]:
    out = []
    for c in codes:
        c = c.strip()
        if not c:
            continue
        out.append(check_model(c))
        time.sleep(0.05)  # API 과호출 방지
    return out
