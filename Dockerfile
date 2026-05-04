FROM node:20-alpine AS base

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY relay.js signal.js ./

FROM base AS relay
LABEL org.opencontainers.image.title="PeerLink Relay" \
      org.opencontainers.image.description="WebSocket relay channel for PeerLink - handles message forwarding between WebRTC peers" \
      org.opencontainers.image.source="https://github.com/simplegear-org/peerlink_servers" \
      org.opencontainers.image.licenses="MIT"
ENV PORT=4000
EXPOSE 4000
CMD ["node", "relay.js"]

FROM base AS signal
LABEL org.opencontainers.image.title="PeerLink Signal" \
      org.opencontainers.image.description="Bootstrap signaling server for PeerLink - manages peer registration and WebRTC signaling" \
      org.opencontainers.image.source="https://github.com/simplegear-org/peerlink_servers" \
      org.opencontainers.image.licenses="MIT"
ENV PORT=3000
EXPOSE 3000
CMD ["node", "signal.js"]
