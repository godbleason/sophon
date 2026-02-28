# ============================================================
# Sophon AI Assistant - Docker Image
#
# Multi-stage build:
#   Stage 1 (builder): Install deps + compile TypeScript
#   Stage 2 (runtime): Minimal image with Node.js + Python + common tools
# ============================================================

# ── Stage 1: Build ──────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first (layer cache friendly)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
COPY config/ config/
COPY skills/ skills/

RUN npm run build

# ── Stage 2: Runtime ────────────────────────────────────────
FROM node:20-slim AS runtime

# Install Python, common CLI tools, and useful utilities for LLM tool calls
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Python
    python3 \
    python3-pip \
    python3-venv \
    # Network tools
    curl \
    wget \
    # Text processing
    jq \
    sed \
    gawk \
    grep \
    # File & archive tools
    unzip \
    zip \
    tar \
    gzip \
    # Process tools
    procps \
    # Git
    git \
    # Misc
    ca-certificates \
    locales \
    && rm -rf /var/lib/apt/lists/*

# Set up locale for proper Unicode support
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8

# Create a symlink so `python` command also works (some systems only have `python3`)
RUN ln -sf /usr/bin/python3 /usr/bin/python

# Install commonly used Python packages
RUN pip3 install --no-cache-dir --break-system-packages \
    requests \
    beautifulsoup4 \
    pandas \
    pyyaml \
    python-dateutil \
    httpx \
    markdown

WORKDIR /app

# Copy production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built artifacts from builder
COPY --from=builder /app/dist/ dist/

# Copy config and skills
COPY config/ config/
COPY skills/ skills/

# Create data directory for persistence
RUN mkdir -p data

# Default environment variables
ENV NODE_ENV=production \
    PORT=3000

# Expose web channel port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT}/ || exit 1

# Start the application
CMD ["node", "dist/index.js"]
