FROM node:20-bookworm-slim

WORKDIR /app

# python3/make/g++ let better-sqlite3 fall back to compiling from source if
# a prebuilt binary isn't available for this image's arch (e.g. arm64 EC2).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 4000
CMD ["node", "src/index.js"]
