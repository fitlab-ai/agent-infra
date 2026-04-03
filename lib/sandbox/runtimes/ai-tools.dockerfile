USER devuser
ENV NPM_CONFIG_PREFIX=/home/devuser/.npm-global
ENV PATH="/home/devuser/.npm-global/bin:${PATH}"

ARG AI_TOOL_PACKAGES
RUN if [ -z "${AI_TOOL_PACKAGES}" ]; then \
      echo "AI_TOOL_PACKAGES build arg is required"; \
      exit 1; \
    fi && \
    npm install -g ${AI_TOOL_PACKAGES}

RUN npm install -g pyright

RUN mkdir -p /home/devuser/.local/share /home/devuser/.local/state

RUN git config --global --add safe.directory /workspace

RUN echo 'export NPM_CONFIG_PREFIX=/home/devuser/.npm-global' >> /home/devuser/.bashrc && \
    echo 'export PATH="/home/devuser/.npm-global/bin:${PATH}"' >> /home/devuser/.bashrc && \
    echo 'export GIT_CONFIG_GLOBAL=/home/devuser/.gitconfig' >> /home/devuser/.bashrc && \
    echo 'export GPG_TTY=$(tty)' >> /home/devuser/.bashrc && \
    echo '[ -f ~/.bash_aliases ] && . ~/.bash_aliases' >> /home/devuser/.bashrc

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
