# Development image: Node 26 LTS plus git (the app will keep note history with git).
# compose.yaml bind-mounts the source at /app, so nothing is copied in here.
FROM node:26-slim AS dev

# The npm cache folder is writable by any user, because containers run with the host user's uid.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /cache/npm \
 && chmod 1777 /cache/npm

ENV HOME=/tmp \
    npm_config_cache=/cache/npm \
    npm_config_update_notifier=false \
    npm_config_fund=false

WORKDIR /app

# Building the Android app (make apk): Java and the Android SDK on top of the dev image.
FROM dev AS android
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-21-jdk-headless unzip curl \
 && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/opt/android-sdk \
    GRADLE_USER_HOME=/cache/gradle
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" /cache/gradle \
 && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip -o /tmp/tools.zip \
 && unzip -q /tmp/tools.zip -d "$ANDROID_HOME/cmdline-tools" \
 && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
 && rm /tmp/tools.zip \
 && yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null \
 && "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-36" "build-tools;35.0.0" > /dev/null \
 # Writable by the user the container runs as: Gradle may fetch a missing piece, and keeps its cache here.
 && chmod -R a+rwX "$ANDROID_HOME" /cache/gradle \
 # sdkmanager ran as root with HOME=/tmp: leave /tmp/.android to the user the container runs as.
 && rm -rf /tmp/.android
ENV PATH="$PATH:/opt/android-sdk/platform-tools:/opt/android-sdk/build-tools/35.0.0"
# The container runs as your uid, which has no account here, and the Capacitor CLI and Gradle look the
# current user up: the entrypoint adds one.
RUN printf '#!/bin/sh\ngrep -q "^[^:]*:[^:]*:$(id -u):" /etc/passwd || echo "builder:x:$(id -u):$(id -g):builder:/tmp:/bin/sh" >> /etc/passwd\nexec "$@"\n' > /usr/local/bin/with-user \
 && chmod 755 /usr/local/bin/with-user \
 && chmod a+w /etc/passwd
ENTRYPOINT ["/usr/local/bin/with-user"]
