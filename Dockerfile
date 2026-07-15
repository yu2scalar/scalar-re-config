# syntax=docker/dockerfile:1.6
#
# ScalarRE Config Tool — single image, two modes.
#
# One image serves both modes, switched by the --mode argument:
#   serve (default):  docker run -p 127.0.0.1:8088:8088 IMG
#   init           :  docker run --rm -v <cfg>:/conf/scalar-re-config.yml IMG --mode=init --config=/conf/scalar-re-config.yml
#
# The jar is host-built and copied in. Build the jar first:
#   ./gradlew bootJar
#   docker build -t scalar-re-config:dev .
#
# bootJar bundles the vite build output (frontend/dist) as static resources,
# so the image needs neither Node nor Gradle (JRE only).
FROM eclipse-temurin:17-jre-alpine
RUN apk add --no-cache curl
WORKDIR /app
# The plain jar is disabled in build.gradle so this glob matches exactly one
# boot jar (scalar-re-config-<version>.jar).
COPY build/libs/scalar-re-config-*.jar app.jar

# Bind 0.0.0.0 inside the container so the published port is reachable.
# A non-loopback bind also disables the automatic browser launch in serve mode.
ENV SERVER_ADDRESS=0.0.0.0
ENV PORT=8088
EXPOSE 8088

# Liveness probe for serve mode (no actuator on board, so GET / = React
# index.html is used as the check). init mode is a one-shot process that
# exits immediately, so the HEALTHCHECK effectively applies to serve only.
# serve defaults to HTTPS with a self-signed certificate, hence https + -k;
# when started with TLS_ENABLED=false the https probe fails, so fall back
# to plain http (the || branch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -skf https://localhost:8088/ >/dev/null \
      || curl -sf http://localhost:8088/ >/dev/null || exit 1

ENTRYPOINT ["java", "-jar", "app.jar"]
CMD ["--mode=serve"]
