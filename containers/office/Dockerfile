# Runtime always selects an inspected immutable image ID, never this local tag.
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3=3.11.2-1+b1 python3-venv=3.11.2-1+b1 \
    libreoffice-writer=4:7.4.7-1+deb12u14 libreoffice-calc=4:7.4.7-1+deb12u14 libreoffice-impress=4:7.4.7-1+deb12u14 \
    poppler-utils=22.12.0-2+deb12u3 tesseract-ocr=5.3.0-2 tesseract-ocr-eng tesseract-ocr-chi-sim \
    fonts-noto-cjk=1:20220127+repack1-1 fonts-dejavu-core \
    && python3 -m venv /opt/office-venv
COPY containers/office/requirements.lock /opt/kkcode-office/requirements.lock
RUN /opt/office-venv/bin/pip install --no-cache-dir --only-binary=:all: --require-hashes -r /opt/kkcode-office/requirements.lock \
    && dpkg-query -W > /opt/kkcode-office/os-packages.lock \
    && /opt/office-venv/bin/pip freeze > /opt/kkcode-office/python-packages.lock
COPY src/office/worker.py /opt/kkcode-office/worker.py
COPY src/office/transfer.py /opt/kkcode-office/transfer.py
LABEL org.opencontainers.image.title="KK Code isolated document tools" \
      io.kkcode.office.protocol="1"
