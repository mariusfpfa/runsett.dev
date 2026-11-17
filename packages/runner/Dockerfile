# Build contracts and runner locally first. Deployment builds replace bundle/
# with immutable ESM modules and COPY --chmod=0555 their lockfile-installed dependencies.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /opt/runsett
COPY --chmod=0555 packages/runner/dist ./runner/
COPY --chmod=0555 packages/contracts/dist ./node_modules/@runsett/contracts/dist/
COPY --chmod=0555 packages/contracts/package.json ./node_modules/@runsett/contracts/package.json
COPY --chmod=0555 packages/runner/package.json ./package.json
COPY --chmod=0555 node_modules/is-number ./node_modules/is-number/
ARG MODULE_BUNDLE=tests/fixtures/runner
COPY --chmod=0555 ${MODULE_BUNDLE}/ ./modules/
USER 1000:1000
ENTRYPOINT ["node", "/opt/runsett/runner/entrypoint.js"]
