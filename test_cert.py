"""상태 판정 / Flask 계층 테스트:  python test_cert.py"""

import cert_client
from cert_client import check_model, ENDPOINTS, check_one

# 네트워크 없이 내장 샘플로 검증 (KC/전파 모두 데모 강제)
cert_client.FORCE_DEMO = True


def test_emsit_xml_parse():
    # 공식 문서의 getAuthInfo 샘플 응답 형태를 파싱할 수 있어야 함
    xml = """<GetAuthInfoResponse>
        <bsmNm>(주)OO기술</bsmNm><mtlNm>SSD</mtlNm>
        <matlBscMdlNm>MITS3016GN1-S</matlBscMdlNm>
        <matlDerivMdlNm>MITS3002GN1-S,MITS3004GN1-S</matlDerivMdlNm>
        <mtlCefNo>KCC-REM-MJT-MJT</mtlCefNo>
        <matlMfrNm>(주)OO기술</matlMfrNm>
        <resultCode>0000</resultCode></GetAuthInfoResponse>"""
    recs = cert_client._parse_emsit_xml(xml)
    assert len(recs) == 1
    assert recs[0]["matlBscMdlNm"] == "MITS3016GN1-S"
    assert recs[0]["mtlCefNo"] == "KCC-REM-MJT-MJT"


def test_emsit_xml_no_result():
    xml = "<GetAuthInfoResponse><resultCode>0001</resultCode></GetAuthInfoResponse>"
    assert cert_client._parse_emsit_xml(xml) == []


def test_demo_certified_basic():
    r = check_model("SM-X300akak")
    assert r["kc"]["status"] == "certified"
    assert r["rra"]["status"] == "certified"
    assert r["rra"]["matched_model"] == "SM-X300"


def test_demo_derivative_rra_only():
    r = check_model("SM-X306abc")
    assert r["rra"]["status"] == "certified"   # 파생 SM-X306
    assert r["kc"]["status"] == "not_found"    # KC엔 SM-X300만


def test_demo_not_found():
    r = check_model("SM-A999zzz")
    assert r["kc"]["status"] == "not_found"
    assert r["rra"]["status"] == "not_found"


def test_detail_url_built_on_match():
    r = check_model("SM-X300akak")
    assert r["rra"]["detail_url"] and "key_no=" in r["rra"]["detail_url"]


def test_error_distinct_from_not_found(monkeypatch=None):
    # _search 가 던지면 not_found 가 아니라 error 로 표시돼야 함 (컴플라이언스 안전성)
    orig = cert_client._search
    cert_client._search = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    try:
        res = check_one("SM-X300akak", ENDPOINTS["rra"], "rra")
        assert res.status == "error"
        assert res.certified is False
        assert "boom" in (res.message or "")
    finally:
        cert_client._search = orig


def test_flask_endpoints():
    import app
    c = app.app.test_client()
    assert c.get("/").status_code == 200
    r = c.post("/api/check", json={"text": "SM-X300akak\nSM-A999zzz"})
    assert r.status_code == 200
    data = r.get_json()
    assert data["count"] == 2
    assert data["results"][0]["full_code"] == "SM-X300akak"


if __name__ == "__main__":
    import sys
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    fail = 0
    for fn in fns:
        cert_client.clear_cache()
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            fail += 1
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:  # noqa
            fail += 1
            print(f"ERROR {fn.__name__}: {e}")
    sys.exit(1 if fail else 0)
