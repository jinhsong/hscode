"""
인증 확인 로컬 웹앱.

실행:
    pip install -r requirements.txt
    python app.py
    브라우저에서 http://127.0.0.1:5000

모델 full code 를 줄바꿈으로 여러 개 붙여넣거나 CSV 를 업로드하면
KC 안전인증 / 전파인증 보유 여부를 표로 보여준다.
"""

from __future__ import annotations

import csv
import io

from flask import Flask, jsonify, render_template, request

import cert_client

app = Flask(__name__)


def _parse_codes_from_text(text: str) -> list[str]:
    codes = []
    for line in (text or "").splitlines():
        # CSV 한 줄(콤마 포함)도 허용 — 각 셀을 코드로 취급
        for cell in line.split(","):
            cell = cell.strip().strip('"')
            if cell:
                codes.append(cell)
    return codes


@app.route("/")
def index():
    return render_template(
        "index.html",
        demo_kc=cert_client.is_demo("kc"),
        demo_rra=cert_client.is_demo("rra"),
    )


@app.route("/api/check", methods=["POST"])
def api_check():
    codes: list[str] = []

    # 1) CSV 파일 업로드
    if "file" in request.files and request.files["file"].filename:
        raw = request.files["file"].read().decode("utf-8-sig", errors="ignore")
        reader = csv.reader(io.StringIO(raw))
        for row in reader:
            codes += [c.strip() for c in row if c.strip()]
    # 2) 텍스트 입력
    else:
        payload = request.get_json(silent=True) or {}
        codes = _parse_codes_from_text(payload.get("text", ""))

    # 중복 제거(순서 유지)
    seen, uniq = set(), []
    for c in codes:
        if c not in seen:
            seen.add(c)
            uniq.append(c)

    results = cert_client.check_models(uniq)
    return jsonify({"count": len(results), "results": results})


if __name__ == "__main__":
    import os
    host = os.environ.get("HOST", "127.0.0.1")  # 컨테이너에선 0.0.0.0 으로
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("DEBUG", "1") == "1"
    app.run(host=host, port=port, debug=debug)
