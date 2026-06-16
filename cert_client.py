"""
인증 조회 클라이언트 + 코드 매칭 로직.

수입 모델의 full code(예: SM-X300akak)가
  1) KC 전기용품 안전인증            (data.go.kr, 인증키 필요)
  2) 전파인증(방송통신기자재 적합성평가)  (EMSIT Open API, 키 불필요)
를 받았는지, 인증 DB에 등록된 basic code / derivative code 와 비교해서 판정한다.

핵심:
- 인증 DB에는 보통 full code 가 아니라 basic code(SM-X300) 또는 파생모델(SM-X306)로 등록된다.
- 따라서 단순 일치(exact)뿐 아니라 "내 full code 가 등록된 모델명으로 시작하는가"(prefix)를
  같이 보고 신뢰도를 함께 반환한다.
- 컴플라이언스 도구이므로 '조회 실패(error)'와 '인증 없음(not_found)'을 명확히 구분한다.

소스별 드라이버:
- rra(전파): EMSIT getAuthInfo.do — 키 없이 matlBscMdlNm/matlDerivMdlNm 로 검색, XML 응답.
- kc       : 공공데이터포털(data.go.kr) — serviceKey 필요, JSON 응답.
"""

from __future__ import annotations

import os
import re
import threading
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, asdict
from typing import Optional

import requests

try:  # .env 가 있으면 자동 로드 (없어도 동작)
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass


# ---------------------------------------------------------------------------
# 설정
# ---------------------------------------------------------------------------

# 공공데이터포털(data.go.kr) 일반 인증키. KC 데이터 조회에 사용.
SERVICE_KEY = os.environ.get("DATA_GO_KR_SERVICE_KEY", "")

# 테스트/오프라인에서 실제 네트워크 호출 없이 내장 샘플로 강제 동작.
FORCE_DEMO = os.environ.get("FORCE_DEMO", "") == "1"

# prefix 매칭 오탐 방지: 매칭에 쓰인 모델명(정규화)이 이 길이 미만이면 prefix 매칭 거절.
MIN_PREFIX_LEN = int(os.environ.get("MIN_PREFIX_LEN", "5"))

# 대량 조회 시 동시 호출 수 (API rate-limit 고려해 보수적으로).
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "4"))

# 전파인증(EMSIT) 적합성평가 인증DB 정보 — 키 없이 모델명으로 조회 가능한 공개 엔드포인트.
EMSIT_RRA_URL = "http://emsit.go.kr/openapi/service/AuthenticationInfoService/getAuthInfo.do"

# 각 API의 요청주소/파라미터/응답필드.
ENDPOINTS = {
    # 전파인증: EMSIT getAuthInfo.do (키 불필요, XML)
    "rra": {
        "label": "전파인증(적합성평가)",
        "driver": "emsit",
        "url": os.environ.get("RRA_API_URL", EMSIT_RRA_URL),
        "basic_param": "matlBscMdlNm",     # 기본모델로 검색
        "deriv_param": "matlDerivMdlNm",   # 파생모델로 검색
        "basic_field": "matlBscMdlNm",     # 응답: 기본모델
        "deriv_field": "matlDerivMdlNm",   # 응답: 파생모델(콤마 구분 CLOB)
        "certnum_field": "mtlCefNo",       # 응답: 인증/등록번호
        "name_field": "mtlNm",             # 응답: 기자재명칭
        "maker_field": "matlMfrNm",        # 응답: 제조자
        "detail_url_tmpl": "https://www.rra.go.kr/ko/license/A_b_popup_keyno.do?key_no={certnum}",
    },
    # KC 안전인증: 국가기술표준원_제품 안전인증 및 리콜 정보 (data.go.kr/data/15116894)
    "kc": {
        "label": "KC 안전인증",
        "driver": "datagokr",
        "url": os.environ.get("KC_API_URL", ""),
        "search_param": os.environ.get("KC_SEARCH_PARAM", "modelNm"),
        "basic_field": "modelNm",          # 모델명
        "deriv_field": "",                 # KC 데이터엔 파생모델 컬럼이 별도로 없을 수 있음
        "certnum_field": "certNum",        # 인증번호
        "name_field": "productNm",         # 제품명
        "maker_field": "makerNm",          # 제조사
        "detail_url_tmpl": "https://www.safetykorea.kr/release/certDetail?certNum={certnum}",
    },
}


def is_demo(kind: str) -> bool:
    """소스별 데모 여부. 전파(rra)는 키 없이도 실조회되므로 URL만 있으면 실모드."""
    if FORCE_DEMO:
        return True
    if kind == "kc":
        return not (SERVICE_KEY and ENDPOINTS["kc"]["url"])
    if kind == "rra":
        return not ENDPOINTS["rra"]["url"]
    return True


# 화면 배너용: 하나라도 데모면 True
DEMO_MODE = is_demo("kc") or is_demo("rra")


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


def match_full_code(
    full_code: str, db_models: list[str], min_prefix_len: int = MIN_PREFIX_LEN
) -> tuple[Optional[str], Optional[str]]:
    """
    full_code 를 인증 DB 의 모델명 목록(db_models)과 비교.
    반환: (매칭된 모델명, 매칭 유형) 또는 (None, None)

    매칭 유형:
      exact          : 완전 일치 (길이 무관, 최우선)
      prefix         : DB모델이 full_code 의 접두 (SM-X300akak ⊃ SM-X300)  ← 가장 흔한 케이스
      reverse_prefix : full_code 가 DB모델의 접두 (참고용, 약한 매칭)
    prefix/reverse_prefix 는 매칭 길이가 min_prefix_len 이상일 때만 인정(오탐 방지).
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
        if fn.startswith(mn) and len(mn) >= min_prefix_len and best[1] != "prefix":
            best = (m, "prefix")
        elif mn.startswith(fn) and len(fn) >= min_prefix_len and best[1] is None:
            best = (m, "reverse_prefix")
    return best


# ---------------------------------------------------------------------------
# API 호출
# ---------------------------------------------------------------------------

def _build_search_terms(full_code: str, min_len: int = MIN_PREFIX_LEN) -> list[str]:
    """
    API 검색용 키워드 후보(구체적 → 일반 순). full code 로는 DB 적중이 안 될 수 있어
    접미를 떼어낸 접두 후보들을 함께 만든다. 호출 수 제한을 위해 최대 4개.
      SM-X300akak -> ['SM-X300akak', 'SM-X300']
      SM-X300N    -> ['SM-X300N', 'SM-X300']
    """
    terms: list[str] = []

    def add(t: str) -> None:
        t = t.strip().rstrip("-_ ")
        if t and t not in terms:
            terms.append(t)

    add(full_code)
    add(re.sub(r"[a-z]+$", "", full_code))       # 뒤쪽 소문자 접미 제거 (akak)
    add(re.sub(r"[A-Za-z]+$", "", full_code))     # 뒤쪽 영문 접미 제거 (N, KOR)
    core = re.sub(r"[^A-Za-z0-9]", "", full_code)
    while len(core) > min_len and len(terms) < 4:
        core = core[:-1]
        add(core)
    return terms[:4]


# (kind, term) -> items 캐시. 같은 basic code 반복 조회 시 호출 절약.
_CACHE: dict[tuple[str, str], list[dict]] = {}
_CACHE_LOCK = threading.Lock()


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


def _http_search(cfg: dict, search_value: str, num_rows: int = 100, max_pages: int = 5) -> list[dict]:
    """공공데이터포털 표준 응답에서 item 리스트 추출. 페이지네이션 처리(JSON 가정)."""
    items: list[dict] = []
    for page in range(1, max_pages + 1):
        params = {
            "serviceKey": SERVICE_KEY,
            "pageNo": page,
            "numOfRows": num_rows,
            "type": "json",
            cfg["search_param"]: search_value,
        }
        resp = requests.get(cfg["url"], params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        body = (data.get("response", data)).get("body", data)
        page_items = body.get("items", body.get("item", []))
        if isinstance(page_items, dict):
            page_items = page_items.get("item", page_items)
        if isinstance(page_items, dict):
            page_items = [page_items]
        page_items = page_items or []

        items.extend(page_items)
        if len(page_items) < num_rows:   # 마지막 페이지
            break
    return items


def _parse_emsit_xml(text: str) -> list[dict]:
    """
    EMSIT getAuthInfo XML 응답을 dict 레코드 리스트로 파싱.
    단건/다건 모두 처리하고, resultCode 0001(조회내역없음)은 빈 결과로 본다.
      <GetAuthInfoResponse>
        <matlBscMdlNm>...</matlBscMdlNm><matlDerivMdlNm>...</matlDerivMdlNm>
        <mtlCefNo>...</mtlCefNo> ... <resultCode>0000</resultCode>
      </GetAuthInfoResponse>
    """
    try:
        root = ET.fromstring(text.strip())
    except ET.ParseError:
        return []

    nodes = []
    if root.find("matlBscMdlNm") is not None or root.find("mtlCefNo") is not None:
        nodes.append(root)
    nodes += root.findall(".//GetAuthInfoResponse")
    nodes += root.findall(".//item")

    records, seen = [], set()
    for node in nodes:
        if id(node) in seen:
            continue
        seen.add(id(node))
        rec = {child.tag: (child.text or "").strip() for child in node}
        if rec.get("resultCode") == "0001":
            continue
        if rec.get("matlBscMdlNm") or rec.get("mtlCefNo"):
            records.append(rec)
    return records


def _emsit_search(cfg: dict, term: str) -> list[dict]:
    """EMSIT getAuthInfo 를 기본모델/파생모델 파라미터로 각각 조회해 합친다(인증번호로 중복 제거)."""
    records: list[dict] = []
    seen = set()
    for param in (cfg["basic_param"], cfg["deriv_param"]):
        resp = requests.get(cfg["url"], params={param: term}, timeout=15)
        resp.raise_for_status()
        for rec in _parse_emsit_xml(resp.text):
            key = rec.get("mtlCefNo") or repr(sorted(rec.items()))
            if key in seen:
                continue
            seen.add(key)
            records.append(rec)
    return records


def _search(kind: str, cfg: dict, term: str) -> list[dict]:
    """검색 결과를 캐시와 함께 반환 (데모/EMSIT/data.go.kr 공용)."""
    key = (kind, term.upper())
    with _CACHE_LOCK:
        if key in _CACHE:
            return _CACHE[key]
    if is_demo(kind):
        import demo_data
        items = demo_data.search(kind, term)
    elif cfg.get("driver") == "emsit":
        items = _emsit_search(cfg, term)
    else:
        items = _http_search(cfg, term)
    with _CACHE_LOCK:
        _CACHE[key] = items
    return items


# ---------------------------------------------------------------------------
# 판정
# ---------------------------------------------------------------------------

@dataclass
class MatchResult:
    full_code: str
    status: str = "not_found"               # certified | review | not_found | error | skipped
    matched_model: Optional[str] = None     # DB상에서 매칭된 모델명
    match_type: Optional[str] = None        # exact | prefix | reverse_prefix
    cert_num: Optional[str] = None
    product_name: Optional[str] = None
    maker: Optional[str] = None
    detail_url: Optional[str] = None        # 공식 원본 확인 링크
    message: Optional[str] = None           # error/skip 사유

    @property
    def certified(self) -> bool:
        return self.status in ("certified", "review")


def check_one(full_code: str, cfg: dict, kind: str) -> MatchResult:
    """단일 인증(cfg)에 대해 full_code 조회. kind: 'kc' | 'rra'"""
    result = MatchResult(full_code=full_code)

    if not is_demo(kind) and not cfg.get("url"):
        result.status = "skipped"
        result.message = "API URL 미설정"
        return result

    errored = False
    last_err: Optional[str] = None

    for term in _build_search_terms(full_code):
        try:
            items = _search(kind, cfg, term)
        except Exception as e:               # 네트워크/파싱 오류
            errored = True
            last_err = str(e)
            continue

        for it in items:
            db_models = [it.get(cfg["basic_field"], "")]
            if cfg.get("deriv_field"):
                db_models += split_models(it.get(cfg["deriv_field"], ""))
            matched, mtype = match_full_code(full_code, db_models)
            if matched:
                result.matched_model = matched
                result.match_type = mtype
                result.status = "review" if mtype == "reverse_prefix" else "certified"
                result.cert_num = it.get(cfg["certnum_field"])
                result.product_name = it.get(cfg["name_field"])
                result.maker = it.get(cfg["maker_field"])
                if result.cert_num and cfg.get("detail_url_tmpl"):
                    result.detail_url = cfg["detail_url_tmpl"].format(certnum=result.cert_num)
                if mtype == "exact":
                    return result
        if result.certified:
            break

    # 매칭 실패: 조회 중 오류가 있었으면 'not_found'로 단정하지 않고 'error'로 표시.
    if not result.certified and errored:
        result.status = "error"
        result.message = f"조회 실패: {last_err}"
    return result


def check_model(full_code: str) -> dict:
    """모델 하나에 대해 KC + 전파 인증을 모두 조회한 종합 결과."""
    full_code = full_code.strip()
    kc = check_one(full_code, ENDPOINTS["kc"], "kc")
    rra = check_one(full_code, ENDPOINTS["rra"], "rra")
    return {"full_code": full_code, "kc": asdict(kc), "rra": asdict(rra)}


def check_models(codes: list[str]) -> list[dict]:
    """여러 모델 일괄 조회 (병렬, 입력 순서 유지)."""
    uniq = [c.strip() for c in codes if c and c.strip()]
    if not uniq:
        return []
    workers = max(1, min(MAX_WORKERS, len(uniq)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(check_model, uniq))
