"""매칭/검색 로직 단위 테스트:  python -m pytest 또는 python test_matching.py"""

from cert_client import (
    match_full_code, normalize, split_models, _build_search_terms,
)


def test_exact():
    assert match_full_code("SM-X300", ["SM-X300"]) == ("SM-X300", "exact")


def test_basic_prefix():
    # 수입 full code 가 인증 basic code 로 시작 → 가장 흔한 케이스
    assert match_full_code("SM-X300akak", ["SM-X300"]) == ("SM-X300", "prefix")


def test_derivative_match():
    models = ["SM-X300"] + split_models("SM-X306, SM-X305, SM-X300N")
    assert match_full_code("SM-X306abc", models)[0] == "SM-X306"


def test_hyphen_insensitive():
    assert match_full_code("SMX300akak", ["SM-X300"]) == ("SM-X300", "prefix")


def test_no_match():
    assert match_full_code("SM-A999zzz", ["SM-X300", "SM-S921"]) == (None, None)


def test_prefix_guard_rejects_short_db_code():
    # DB의 짧은 코드('SM','SMX3')에 거짓 prefix 매칭이 나면 안 됨
    assert match_full_code("SM-X300akak", ["SM", "SMX3"]) == (None, None)


def test_exact_short_still_matches():
    # 짧아도 완전 일치는 인정
    assert match_full_code("AB1", ["AB1"]) == ("AB1", "exact")


def test_normalize():
    assert normalize("sm-x300 ak") == "SMX300AK"


def test_search_terms_lowercase_suffix():
    assert _build_search_terms("SM-X300akak")[:2] == ["SM-X300akak", "SM-X300"]


def test_search_terms_uppercase_suffix():
    assert "SM-X300" in _build_search_terms("SM-X300N")


def test_search_terms_capped():
    assert len(_build_search_terms("SM-X300akak")) <= 4


if __name__ == "__main__":
    import sys
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    fail = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            fail += 1
            print(f"FAIL {fn.__name__}: {e}")
    sys.exit(1 if fail else 0)
