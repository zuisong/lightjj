#!/bin/sh
# lightjj installer — detects OS/arch, downloads the latest release binary.
# Usage: curl -fsSL https://raw.githubusercontent.com/chronologos/lightjj/main/install.sh | sh

set -e

REPO="chronologos/lightjj"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    case "$OS" in
        darwin) OS="macos" ;;
        linux)  OS="linux" ;;
        *)      echo "Unsupported OS: $OS" >&2; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x86_64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
    esac

    # macOS: only arm64 binary available (Intel runs via Rosetta)
    if [ "$OS" = "macos" ]; then
        ARCH="arm64"
    fi

    BINARY="lightjj-${OS}-${ARCH}"
}

download() {
    URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"
    echo "Downloading ${BINARY}..."
    mkdir -p "$INSTALL_DIR"
    curl -fsSL "$URL" -o "${INSTALL_DIR}/lightjj"
    chmod +x "${INSTALL_DIR}/lightjj"
}

sign_macos() {
    if [ "$OS" = "macos" ]; then
        echo "Signing for macOS Gatekeeper..."
        xattr -cr "${INSTALL_DIR}/lightjj"
        codesign -s - -f "${INSTALL_DIR}/lightjj"
    fi
}

verify_path() {
    case ":$PATH:" in
        *":${INSTALL_DIR}:"*) ;;
        *) echo "Note: add ${INSTALL_DIR} to your \$PATH" ;;
    esac
}

detect_platform
download
sign_macos
verify_path

VERSION=$("${INSTALL_DIR}/lightjj" --version 2>/dev/null || echo "unknown")
echo "Installed lightjj ${VERSION} to ${INSTALL_DIR}/lightjj"
