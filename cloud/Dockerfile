# zomb Cloud: docker build -f cloud/Dockerfile -t zomb-cloud . && docker run -p 3000:3000 -v zomb:/data -e ZOMB_URL=https://your.host zomb-cloud
FROM node:26-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* && npm install -g pnpm yarn
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src src
COPY cloud cloud
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "cloud/server.js"]
