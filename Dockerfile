# Tools stage: pinned @intermine tools from npm plus the bundled alliance-tools.
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS tools
COPY scripts/build-tools-dir.sh scripts/install-alliance-tools.sh /src/scripts/
COPY docker/intermine-tools.txt /src/docker/
COPY alliance-tools /src/alliance-tools
RUN /src/scripts/build-tools-dir.sh /tools

FROM gcr.io/distroless/java21-debian12:nonroot@sha256:7e37784d94dccbf5ccb195c73b295f5ad00cd266512dfbac12eb9c3c28f8077d
COPY config/prod/config.edn /app/config/prod/config.edn
COPY target/bluegenes.jar /
COPY --from=tools --chown=nonroot:nonroot /tools /tools
ENV BLUEGENES_TOOL_PATH=/tools
WORKDIR /
EXPOSE 5000
CMD ["bluegenes.jar"]
