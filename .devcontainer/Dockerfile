FROM docker:28-cli AS docker_cli

FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG NODE_MAJOR=22

ENV DEBIAN_FRONTEND=noninteractive
ENV UV_LINK_MODE=copy
ENV CODEX_HOME=/home/vscode/.codex
ENV NPM_CONFIG_CACHE=/home/vscode/.npm
ENV UV_INSTALL_DIR=/usr/local/bin
ENV PATH=/home/vscode/.local/bin:${PATH}

COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker-real
COPY --from=docker_cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gh \
        graphviz \
        jq \
        make \
        npm \
        openssh-client \
        python3 \
        python3-pip \
        python3-venv \
        sudo \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
RUN npm install -g @mermaid-js/mermaid-cli @openai/codex

RUN printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' '' 'if [ "$(id -u)" -eq 0 ]; then' '  exec /usr/local/bin/docker-real "$@"' 'fi' '' 'exec sudo -n /usr/local/bin/docker-real "$@"' > /usr/local/bin/docker \
    && chmod 0755 /usr/local/bin/docker \
    && printf '%s\n' 'vscode ALL=(root) NOPASSWD: /usr/local/bin/docker-real' > /etc/sudoers.d/vscode-docker \
    && chmod 0440 /etc/sudoers.d/vscode-docker

RUN mkdir -p /home/vscode/.codex /home/vscode/.npm /workspace \
    && chown -R vscode:vscode /home/vscode /workspace

USER vscode
WORKDIR /workspace
