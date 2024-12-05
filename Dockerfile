FROM gcr.io/distroless/java21
COPY config/prod/config.edn /app/config/prod/config.edn
COPY target/bluegenes.jar /
WORKDIR /
EXPOSE 5000
CMD ["bluegenes.jar"]