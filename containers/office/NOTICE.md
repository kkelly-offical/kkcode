# Document image dependencies

This optional image bundles upstream open-source tools; it is not Microsoft Office.

- Python package sources and exact wheel hashes are recorded in `requirements.lock`.
- Actual installed package versions are recorded in `/opt/kkcode-office/os-packages.lock` and `python-packages.lock`.
- Debian copyright/license notices remain under `/usr/share/doc`; Python distribution notices remain in their installed `.dist-info` directories.
- LibreOffice: https://www.libreoffice.org/about-us/licenses/
- Poppler: https://poppler.freedesktop.org/
- Tesseract: https://github.com/tesseract-ocr/tesseract
- Python libraries: https://github.com/python-openxml/python-docx , https://foss.heptapod.net/openpyxl/openpyxl , https://github.com/scanny/python-pptx , https://github.com/py-pdf/pypdf
- PDFium character-range geometry: https://github.com/pypdfium2-team/pypdfium2 (BSD-3-Clause / Apache-2.0 and bundled dependency licenses, retained in the installed wheel).

Builds are explicit. Runtime requires an inspected immutable local image digest and does not download dependencies, import project Python, execute macros, or enable network access.
