# ============================================================
# Sophon Web Frontend - Docker Image
#
# Multi-stage build:
#   Stage 1 (builder): Install deps + build Vite/React app
#   Stage 2 (runtime): Nginx serving static files
# ============================================================

# ── Stage 1: Build ──────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .

# Build with optional WebSocket URL override
ARG VITE_WS_URL=""
ENV VITE_WS_URL=${VITE_WS_URL}

RUN npm run build

# ── Stage 2: Runtime (Nginx) ───────────────────────────────
FROM nginx:alpine AS runtime

# Copy built static files
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx config for SPA routing
RUN cat > /etc/nginx/conf.d/default.conf << 'EOF'
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;
    gzip_min_length 256;

    # Cache static assets aggressively
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA fallback: all routes serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
