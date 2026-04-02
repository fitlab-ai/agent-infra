RUN apt-get update && apt-get install -y \
    openjdk-17-jdk maven \
    && rm -rf /var/lib/apt/lists/*
