ARG US_NODE_BASE_SHA256
FROM node@sha256:${US_NODE_BASE_SHA256}

# Digest selection is an artifact input. No default tag, install, pull or secret
# generation belongs in the runtime. Protected image attestation remains required.
WORKDIR /app
COPY --chown=0:0 app/ /app/
RUN find /app -type d -exec chmod 0555 {} + \
    && find /app -type f -exec chmod 0444 {} +
USER 10001:10001
ENTRYPOINT ["node", "/app/apps/api/dist/main.us-hosted.js"]
