# Explicit operator build only; runtime accepts the resulting immutable image ID.
# This initial image is Linux/amd64. Other architectures must get their own locks.
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
RUN test "$(dpkg --print-architecture)" = amd64 \
    && apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3=3.11.2-1+b1 libfontconfig1=2.14.1-4 libfreetype6=2.12.1+dfsg-5+deb12u4 \
      libxext6=2:1.3.4-1+b1 libxrender1=1:0.9.10-1.1
WORKDIR /opt/kkcode-lsp
COPY package.json package-lock.json empty-user.npmrc empty-global.npmrc ./
RUN npm ci --ignore-scripts --omit=dev --audit=false --fund=false \
      --registry=https://registry.npmjs.org --userconfig=/opt/kkcode-lsp/empty-user.npmrc --globalconfig=/opt/kkcode-lsp/empty-global.npmrc
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates=20250419~deb12u1 openjdk-17-jre-headless=17.0.20.1+1-1~deb12u1 unzip=6.0-28+deb12u1
COPY downloads.lock.json fetch-locked.mjs ./
RUN node fetch-locked.mjs \
    && mkdir /opt/go /opt/kotlin \
    && tar -xzf /tmp/kkcode-lsp-locked/go.tar.gz -C /opt/go --strip-components=1 \
    && unzip -q /tmp/kkcode-lsp-locked/kotlin.zip -d /opt/kotlin
COPY build-gopls.mjs ./
RUN node build-gopls.mjs \
    && dpkg-query -W > /opt/kkcode-lsp/os-packages.lock
COPY launch.mjs ./
WORKDIR /workspace
LABEL org.opencontainers.image.title="KK Code isolated language services" \
      io.kkcode.lsp.protocol="1" \
      io.kkcode.lsp.languages="typescript,javascript,python,go,kotlin"
