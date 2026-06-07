USER devuser
ENV DISABLE_UPDATES=1
ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV NPM_CONFIG_PREFIX=/home/devuser/.npm-global
ENV PATH="/home/devuser/.npm-global/bin:${PATH}"

ARG AI_TOOL_PACKAGES
RUN if [ -z "${AI_TOOL_PACKAGES}" ]; then \
      echo "AI_TOOL_PACKAGES build arg is required"; \
      exit 1; \
    fi && \
    set -e && \
    for pkg in ${AI_TOOL_PACKAGES}; do \
      npm install -g "$pkg"; \
    done

RUN npm install -g pyright

RUN mkdir -p /home/devuser/.local/share /home/devuser/.local/state

RUN git config --global --add safe.directory /workspace

# Host shell-config is bind-mounted as a directory at this path; the four files
# inside (.gitconfig, .gitignore_global, .stCommitMsg, .bash_aliases) are exposed
# via symlinks in $HOME. Directory binds avoid the //deleted invalidation that
# single-file binds suffer when their source is rewritten on macOS/virtiofs.
RUN mkdir -p /home/devuser/.host-shell-config && \
    ln -sf .host-shell-config/.gitconfig        /home/devuser/.gitconfig && \
    ln -sf .host-shell-config/.gitignore_global /home/devuser/.gitignore_global && \
    ln -sf .host-shell-config/.stCommitMsg      /home/devuser/.stCommitMsg && \
    ln -sf .host-shell-config/.bash_aliases     /home/devuser/.bash_aliases

RUN echo 'export NPM_CONFIG_PREFIX=/home/devuser/.npm-global' >> /home/devuser/.bashrc && \
    echo 'export PATH="/home/devuser/.npm-global/bin:${PATH}"' >> /home/devuser/.bashrc && \
    echo 'export GIT_CONFIG_GLOBAL=/home/devuser/.gitconfig' >> /home/devuser/.bashrc && \
    echo 'export GPG_TTY=$(tty)' >> /home/devuser/.bashrc && \
    echo '[ -f ~/.bash_aliases ] && . ~/.bash_aliases' >> /home/devuser/.bashrc

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
