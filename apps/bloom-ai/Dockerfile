# Bloom AI — build from the repository root so the agent library is included:
#   docker build -f apps/bloom-ai/Dockerfile .
FROM node:22-slim

WORKDIR /repo
# Agent definitions (every division) + the app. Local data, builds and dependencies are excluded by .dockerignore.
COPY . .

WORKDIR /repo/apps/bloom-ai
RUN npm ci --include=dev --no-audit --no-fund && npm run build

ENV NODE_ENV=production \
    PORT=4400 \
    BLOOM_DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4400)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "server/index.ts"]
