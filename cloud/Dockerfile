# zomb Cloud: docker build -f cloud/Dockerfile -t zomb-cloud . && docker run -p 3000:3000 -v zomb:/data -e ZOMB_URL=https://your.host zomb-cloud
FROM node:26-slim
# the Docker CLI, for ZOMB_SANDBOX=docker: the server starts each scan in a throwaway container of this same image
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* && npm install -g pnpm yarn
# where a sandboxed scan unpacks its checkout, as the image's unprivileged node user (uid 1000)
RUN mkdir /work && chown node:node /work
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src src
COPY cloud cloud
# a sandboxed scan runs /app/src/cli.ts as uid 1000, whatever modes the files had in the build context
RUN chmod -R a+rX src cloud
ENV DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "cloud/server.ts"]
