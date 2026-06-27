# NaLog Agent — runs as an Alibaba Cloud Function Compute custom container,
# or anywhere Docker runs. Node 22 LTS.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY deploy ./deploy

# Function Compute sends a SIGTERM on scale-in; node handles it by default.
EXPOSE 8080

# Lightweight container healthcheck (FC also probes the HTTP trigger).
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
