RUN --mount=type=secret,id=HTTP_PROXY \
    --mount=type=secret,id=HTTPS_PROXY \
    --mount=type=secret,id=NO_PROXY \
    export HTTP_PROXY="$(cat /run/secrets/HTTP_PROXY 2>/dev/null || true)" && \
    export HTTPS_PROXY="$(cat /run/secrets/HTTPS_PROXY 2>/dev/null || true)" && \
    export NO_PROXY="$(cat /run/secrets/NO_PROXY 2>/dev/null || true)" && \
    export http_proxy="${HTTP_PROXY}" https_proxy="${HTTPS_PROXY}" no_proxy="${NO_PROXY}" && \
    apt-get update && apt-get install -y \
    openjdk-21-jdk maven \
    && rm -rf /var/lib/apt/lists/*
