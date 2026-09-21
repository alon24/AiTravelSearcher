FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir .
ENV FLIGHTAGENT_CACHE_DB=/data/offers.sqlite
EXPOSE 8765
CMD ["uvicorn", "flightagent.api:app", "--host", "0.0.0.0", "--port", "8765"]
