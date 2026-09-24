# Test-only targets. Fixed official Node multi-platform index; the build script
# selects linux/amd64 (manifest 8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27).
# No package downloads, application code, credentials or production services.
FROM node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS strict-test
RUN test "$(node --version)" = v22.23.1 \
    && test "$(npm --version)" = 10.9.8 \
    && test "$(dpkg --print-architecture)" = amd64 \
    && for program in env timeout sh bash cat ls grep find wc sleep head mkdir chmod cp rm; do command -v "$program" >/dev/null || exit 1; done \
    && /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/bin/timeout 5s node -e "require('node:assert/strict').equal(2+2,4)"
WORKDIR /workspace
LABEL org.opencontainers.image.title="KK Code strict execution test fixture" \
      io.kkcode.test-only="true" \
      io.kkcode.test-image="strict-v1" \
      io.kkcode.base-digest="sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3"
ENTRYPOINT ["/usr/bin/env"]
CMD ["node"]

# A separate small target for protocol/isolation tests. This deliberately is
# NOT containers/lsp's production language-server bundle.
FROM strict-test AS lsp-fixture
COPY fake-lsp-server.mjs /opt/kkcode-test/fake-lsp-server.mjs
RUN chmod 0444 /opt/kkcode-test/fake-lsp-server.mjs \
    && node --check /opt/kkcode-test/fake-lsp-server.mjs
LABEL org.opencontainers.image.title="KK Code synthetic LSP test fixture" \
      io.kkcode.test-image="lsp-fixture-v1"
