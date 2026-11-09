# Self-hosted image (Oracle VM, ARM64). One image, two roles:
#   web    -> node server/index.ts (site + /api)
#   worker -> node src/nifty-alpha-ladder/worker/main.ts
FROM node:24-bookworm-slim
WORKDIR /app
ENV TZ=Asia/Kolkata
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
ENV NODE_ENV=production PORT=3100
EXPOSE 3100
CMD ["node", "--experimental-strip-types", "--no-warnings", "server/index.ts"]
