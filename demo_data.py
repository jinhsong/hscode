"""
데모용 가짜 인증 DB.

FORCE_DEMO=1 이거나 해당 소스가 미설정일 때 cert_client 가 이 데이터를 사용해
실제 API 없이도 매칭 로직/화면을 바로 확인할 수 있게 한다.

필드명은 실제 API 응답과 동일하게 맞춰 둔다:
  - rra(전파/EMSIT): matlBscMdlNm(기본), matlDerivMdlNm(파생), mtlCefNo, mtlNm, matlMfrNm
  - kc            : modelNm, certNum, productNm, makerNm
"""

# 전파인증(EMSIT 적합성평가) 샘플
RRA_DB = [
    {
        "matlBscMdlNm": "SM-X300",
        "matlDerivMdlNm": "SM-X306, SM-X305, SM-X300N",
        "mtlCefNo": "R-R-SEC-SM-X300",
        "mtlNm": "특정소출력무선기기(무선데이터통신시스템용)",
        "matlMfrNm": "Samsung Electronics",
    },
    {
        "matlBscMdlNm": "SM-S921",
        "matlDerivMdlNm": "SM-S921N, SM-S921U",
        "mtlCefNo": "R-R-SEC-SM-S921",
        "mtlNm": "이동통신용 무선설비의 기기",
        "matlMfrNm": "Samsung Electronics",
    },
]

# KC 안전인증 샘플 (파생모델 컬럼 없음 → 모델명 1개)
KC_DB = [
    {
        "modelNm": "SM-X300",
        "certNum": "XU102345-23001",
        "productNm": "태블릿 컴퓨터용 충전기",
        "makerNm": "Samsung Electronics",
    },
    {
        "modelNm": "EP-TA800",
        "certNum": "XU109999-22010",
        "productNm": "USB 충전기",
        "makerNm": "Samsung Electronics",
    },
]

# kind -> (기본모델 필드, 파생모델 필드)
_FIELDS = {"rra": ("matlBscMdlNm", "matlDerivMdlNm"), "kc": ("modelNm", None)}


def _norm(s: str) -> str:
    return s.upper().replace("-", "").replace(" ", "")


def search(kind: str, term: str) -> list[dict]:
    """term 과 (부분/접두) 일치하는 레코드 반환 — 실제 API 검색을 흉내."""
    db = RRA_DB if kind == "rra" else KC_DB
    bfield, dfield = _FIELDS[kind]
    t = _norm(term)
    hits = []
    for row in db:
        models = [row.get(bfield, "")]
        if dfield and row.get(dfield):
            models += [m.strip() for m in row[dfield].replace("/", ",").split(",")]
        norms = [_norm(m) for m in models if m]
        if any(t in m or m.startswith(t) or t.startswith(m) for m in norms):
            hits.append(row)
    return hits
