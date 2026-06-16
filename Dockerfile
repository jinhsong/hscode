FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000
ENV HOST=0.0.0.0 PORT=5000 DEBUG=0
# 운영에서는 gunicorn 권장 (requirements 에 추가 후): gunicorn -b 0.0.0.0:5000 app:app
CMD ["python", "app.py"]
