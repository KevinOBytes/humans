FROM node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573 AS dependencies

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.11.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN pnpm build && pnpm runtime:build

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212 AS runtime

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app

LABEL org.opencontainers.image.base.name="gcr.io/distroless/nodejs24-debian13:nonroot" \
      org.opencontainers.image.base.digest="sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212" \
      org.humans.builder.name="node:24.18.0-trixie-slim" \
      org.humans.builder.digest="sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573" \
      org.humans.base-resolution-date="2026-08-03"

COPY --from=build --chown=65532:65532 /app/.next/runtime-root/ /app/

USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["server.js"]
