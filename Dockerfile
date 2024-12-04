FROM gcr.io/distroless/java21
COPY target/bluegenes.jar /
WORKDIR /
EXPOSE 5000
CMD ["bluegenes.jar"]
