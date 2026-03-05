FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml README.md /app/
COPY src /app/src
RUN pip install --no-cache-dir .

EXPOSE 18789
CMD ["uvicorn", "rovot.server.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "18789"]
