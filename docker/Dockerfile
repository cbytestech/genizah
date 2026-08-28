FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    tar \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for self-update: rebuild from inside container)
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

WORKDIR /app

# Backend dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Frontend build
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# Backend source
COPY backend/ ./backend/

# Serve frontend build from backend
RUN cp -r frontend/dist backend/src/public

# Data directories (mounted as volumes in production)
RUN mkdir -p /app/data/db /app/data/files /app/data/thumbnails /app/data/config

EXPOSE 3090

WORKDIR /app/backend
CMD ["node", "src/index.js"]
