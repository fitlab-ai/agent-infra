RUN apt-get update && apt-get install -y \
    openjdk-21-jdk maven \
    && rm -rf /var/lib/apt/lists/*
