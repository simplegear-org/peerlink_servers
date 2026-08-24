FROM node:20-alpine AS base

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY relay.js signal.js push.js server-checker.js observability.js source-info.js ./

FROM base AS relay
ARG PEERLINK_SERVERS_VERSION=1.3.1+2026082403
ARG PEERLINK_SOURCE_REF=source-v1.3.1+2026082403
LABEL org.opencontainers.image.title="PeerLink Relay" \
      org.opencontainers.image.description="WebSocket relay channel for PeerLink - handles message forwarding between WebRTC peers" \
      org.opencontainers.image.version="${PEERLINK_SERVERS_VERSION}" \
      org.opencontainers.image.source="https://github.com/simplegear-org/peerlink_servers/tree/${PEERLINK_SOURCE_REF}" \
      org.opencontainers.image.revision="${PEERLINK_SOURCE_REF}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV SOURCE_VERSION=${PEERLINK_SERVERS_VERSION}
ENV SOURCE_CODE_URL=https://github.com/simplegear-org/peerlink_servers/tree/${PEERLINK_SOURCE_REF}
ENV PORT=4000
EXPOSE 4000
CMD ["node", "relay.js"]

FROM base AS signal
ARG PEERLINK_SERVERS_VERSION=1.3.1+2026082403
ARG PEERLINK_SOURCE_REF=source-v1.3.1+2026082403
LABEL org.opencontainers.image.title="PeerLink Signal" \
      org.opencontainers.image.description="Bootstrap signaling server for PeerLink - manages peer registration and WebRTC signaling" \
      org.opencontainers.image.version="${PEERLINK_SERVERS_VERSION}" \
      org.opencontainers.image.source="https://github.com/simplegear-org/peerlink_servers/tree/${PEERLINK_SOURCE_REF}" \
      org.opencontainers.image.revision="${PEERLINK_SOURCE_REF}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV SOURCE_VERSION=${PEERLINK_SERVERS_VERSION}
ENV SOURCE_CODE_URL=https://github.com/simplegear-org/peerlink_servers/tree/${PEERLINK_SOURCE_REF}
ENV PORT=3000
EXPOSE 3000
CMD ["node", "signal.js"]

FROM base AS push
ARG PEERLINK_SERVERS_VERSION=1.3.1+2026082403
ARG PEERLINK_SOURCE_REF=source-v1.3.1+2026082403
LABEL org.opencontainers.image.title="PeerLink Push" \
      org.opencontainers.image.description="Push provider service for PeerLink - routes internal push requests to APNs/FCM" \
      org.opencontainers.image.version="${PEERLINK_SERVERS_VERSION}" \
      org.opencontainers.image.source="https://github.com/simplegear-org/peerlink_servers/tree/${PEERLINK_SOURCE_REF}" \
      org.opencontainers.image.revision="${PEERLINK_SOURCE_REF}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV SOURCE_VERSION=${PEERLINK_SERVERS_VERSION}
ENV SOURCE_CODE_URL=https://github.com/simplegear-org/peerlink_servers/tree/${PEERLINK_SOURCE_REF}
ENV PORT=4500
EXPOSE 4500
CMD ["node", "push.js"]

FROM base AS server-checker
ARG PEERLINK_SERVERS_VERSION=1.3.1+2026082403
ARG PEERLINK_SOURCE_REF=source-v1.3.1+2026082403
LABEL org.opencontainers.image.title="PeerLink Server Checker" \
      org.opencontainers.image.description="Observed PeerLink server health checker" \
      org.opencontainers.image.version="${PEERLINK_SERVERS_VERSION}" \
      org.opencontainers.image.source="https://github.com/simplegear-org/peerlink_servers/tree/${PEERLINK_SOURCE_REF}" \
      org.opencontainers.image.revision="${PEERLINK_SOURCE_REF}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV SOURCE_VERSION=${PEERLINK_SERVERS_VERSION}
ENV SOURCE_CODE_URL=https://github.com/simplegear-org/peerlink_servers/tree/${PEERLINK_SOURCE_REF}
CMD ["node", "server-checker.js"]
