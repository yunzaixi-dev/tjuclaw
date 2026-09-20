FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-noto-cjk \
      libreoffice-calc-nogui \
      libreoffice-impress-nogui \
      libreoffice-writer-nogui \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir /input /output

USER 65532:65532
ENV HOME=/tmp
ENTRYPOINT ["libreoffice", "--headless", "--safe-mode", "--nologo", "--norestore", "--nodefault", "--nolockcheck", "--nofirststartwizard", "-env:UserInstallation=file:///tmp/libreoffice-profile"]
