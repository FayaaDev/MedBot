FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY asreview.py server.py ./
USER 65534:65534
EXPOSE 8080
CMD ["python", "-u", "server.py"]
