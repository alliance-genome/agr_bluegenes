# Tools stage: pinned @intermine tools from npm plus the bundled alliance-tools.
FROM python:3.12-slim AS tools
COPY scripts/build-tools-dir.sh scripts/install-alliance-tools.sh /src/scripts/
COPY docker/intermine-tools.txt /src/docker/
COPY alliance-tools /src/alliance-tools
RUN /src/scripts/build-tools-dir.sh /tools

FROM gcr.io/distroless/java21
COPY config/prod/config.edn /app/config/prod/config.edn
COPY target/bluegenes.jar /
COPY --from=tools /tools /tools
ENV BLUEGENES_TOOL_PATH=/tools
WORKDIR /
EXPOSE 5000
CMD ["bluegenes.jar"]
