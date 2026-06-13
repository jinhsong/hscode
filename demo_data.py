"""
데모용 가짜 인증 DB.

DATA_GO_KR_SERVICE_KEY 가 없을 때 cert_client 가 이 데이터를 사용해
실제 API 없이도 매칭 로직/화면을 바로 확인할 수 있게 한다.
실제 운영에서는 .env 에 키를 넣으면 자동으로 실 API 로 전환된다.
"""

# 전파인증(적합성평가) 샘플: 기본모델 + 파생모델
RRA_DB = [
    {
        "basicMdlNm": "SM-X300",
        "drvtMdlNm": "SM-X306, SM-X305, SM-X300N",
        "cnfmKsgsno": "R-R-SEC-SM-X300",
        "eqpmnNm": "특정소출력무선기기(무선데이터통신시스템용)",
        "mnfctrNm": "Samsung Electronics",
    },
    {
        "basicMdlNm": "SM-S921",
        "drvtMdlNm": "SM-S921N, SM-S921U",
        "cnfmKsgsno": "R-R-SEC-SM-S921",
        "eqpmnNm": "이동통신용 무선설비의 기기",
        "mnfctrNm": "Samsung Electronics",
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


def search(kind: str, term: str) -> list[dict]:
    """term 을 포함(대소문자 무시)하는 레코드 반환 — 실제 API 검색을 흉내."""
    db = RRA_DB if kind == "rra" else KC_DB
    field = "basicMdlNm" if kind == "rra" else "modelNm"
    t = term.upper().replace("-", "")
    hits = []
    for row in db:
        hay = (row.get(field, "") + " " + row.get("drvtMdlNm", "")).upper().replace("-", "")
        if t in hay or hay.split() and any(t.startswith(x) or x.startswith(t)
                                           for x in [row.get(field, "").upper().replace("-", "")]):
            hits.append(row)
    return hits
