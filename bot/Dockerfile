FROM node:20-slim

# Chromium + the libs Puppeteer / whatsapp-web.js need.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 \
      libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
      libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
      libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
      libxi6 libxrandr2 libxrender1 libxshmfence1 libxss1 libxtst6 \
      lsb-release wget xdg-utils \
      tini \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .

# Persist the WhatsApp session here. Mount a volume on this path
# (Fly.io / Railway / Render) so the QR scan only happens once.
VOLUME ["/app/.wwebjs_auth"]
ENV SESSION_DIR=/app/.wwebjs_auth

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","index.js"]
