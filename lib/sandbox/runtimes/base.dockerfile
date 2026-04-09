FROM ubuntu:22.04

LABEL description="AI coding sandbox"

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Shanghai

ARG HOST_UID=1000
ARG HOST_GID=1000
RUN (groupadd -g ${HOST_GID} devuser || true) && \
    useradd -u ${HOST_UID} -g ${HOST_GID} -m -s /bin/bash devuser

RUN apt-get update && apt-get install -y \
    curl wget git vim tmux file \
    build-essential ca-certificates gnupg lsb-release \
    locales \
    && locale-gen en_US.UTF-8 \
    && (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg) \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV TERM=xterm-256color
ENV COLORTERM=truecolor

RUN ln -s /workspace /home/devuser/workspace
