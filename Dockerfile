# Website Navigator: the API server plus the crawler, in one image.
#
#   docker build -t website-navigator .
#   docker run -d --name nav -p 8787:8787 --env-file .env -v navdata:/data website-navigator
#
# Node 26 because that is what package.json requires and all the tests run on.
FROM node:26-bookworm-slim

WORKDIR /app

# Chromium lives outside any user's home so the non-root user below can run it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY *.ts *.js ./

# The index and answer cache live on a volume. Without one they are wiped on
# every restart or redeploy, which is the one way SQLite goes wrong in prod.
ENV NAV_DB=/data/nav.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Not root: this process drives a real browser around other people's websites.
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:8787/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server.ts"]
