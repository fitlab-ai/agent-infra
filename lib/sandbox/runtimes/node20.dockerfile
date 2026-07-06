RUN bash -o pipefail -c 'curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors https://deb.nodesource.com/setup_20.x | bash -' && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*
