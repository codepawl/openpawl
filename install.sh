#!/bin/sh
# OpenPawl Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/nxank4/openpawl/main/install.sh | sh
#
# Flags:
#   --dry-run      Show what would be done without doing it
#   --version X    Install a specific version (e.g. --version 0.2.0)
#   --no-color     Plain output for CI environments
#   --help         Show this help message
#
# POSIX sh compatible — works on macOS, Linux, and WSL.

set -e

# --- Configuration ---
GITHUB_REPO="nxank4/openpawl"
GITHUB_URL="https://github.com/${GITHUB_REPO}"
INSTALL_DIR="${HOME}/.openpawl"
BIN_DIR="${INSTALL_DIR}/bin"
SOURCE_DIR="${INSTALL_DIR}/source"

# --- Defaults ---
DRY_RUN=false
NO_COLOR=false
REQUESTED_VERSION=""

# --- Parse arguments ---
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            ;;
        --no-color)
            NO_COLOR=true
            ;;
        --version)
            shift
            if [ $# -eq 0 ]; then
                echo "Error: --version requires a value" >&2
                exit 1
            fi
            REQUESTED_VERSION="$1"
            ;;
        --version=*)
            REQUESTED_VERSION="${1#--version=}"
            ;;
        --help|-h)
            echo "OpenPawl Installer"
            echo ""
            echo "Usage: curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.sh | sh"
            echo "   or: sh install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --dry-run      Show what would be done without making changes"
            echo "  --version X    Install a specific version (e.g. 0.2.0)"
            echo "  --no-color     Disable colored output (for CI)"
            echo "  --help, -h     Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
    esac
    shift
done

# --- Color helpers ---
if [ "$NO_COLOR" = true ] || [ ! -t 1 ]; then
    GREEN=""
    RED=""
    YELLOW=""
    CYAN=""
    DIM=""
    BOLD=""
    RESET=""
else
    GREEN="\033[32m"
    RED="\033[31m"
    YELLOW="\033[33m"
    CYAN="\033[36m"
    DIM="\033[2m"
    BOLD="\033[1m"
    RESET="\033[0m"
fi

info() {
    printf "${CYAN}>${RESET} %s\n" "$1"
}

success() {
    printf "${GREEN}✓${RESET} %s\n" "$1"
}

warn() {
    printf "${YELLOW}!${RESET} %s\n" "$1"
}

error() {
    printf "${RED}✗${RESET} %s\n" "$1" >&2
}

dry() {
    printf "${DIM}[dry-run]${RESET} %s\n" "$1"
}

# --- Utility ---
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

version_gte() {
    # Returns 0 if $1 >= $2 (comparing major versions only)
    _ver_major=$(echo "$1" | sed 's/^v//' | cut -d. -f1)
    _ver_required=$(echo "$2" | sed 's/^v//' | cut -d. -f1)
    [ "$_ver_major" -ge "$_ver_required" ] 2>/dev/null
}

# --- OS / Architecture Detection ---
detect_os() {
    _uname_s=$(uname -s)
    case "$_uname_s" in
        Linux*)
            OS="linux"
            # Check for WSL
            if grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
                OS_DETAIL="wsl"
            elif [ -f /etc/os-release ]; then
                . /etc/os-release
                OS_DETAIL=$(echo "$ID" | tr '[:upper:]' '[:lower:]')
            else
                OS_DETAIL="linux"
            fi
            ;;
        Darwin*)
            OS="darwin"
            OS_DETAIL="macos"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            error "Native Windows is not supported. Please use WSL."
            error "Install WSL: https://learn.microsoft.com/windows/wsl/install"
            exit 1
            ;;
        *)
            error "Unsupported operating system: $_uname_s"
            exit 1
            ;;
    esac
}

detect_arch() {
    _uname_m=$(uname -m)
    case "$_uname_m" in
        x86_64|amd64)
            ARCH="x64"
            ;;
        aarch64|arm64)
            ARCH="arm64"
            ;;
        *)
            error "Unsupported architecture: $_uname_m"
            exit 1
            ;;
    esac
}

detect_shell() {
    DETECTED_SHELL=""
    SHELL_PROFILE=""

    _shell_name=$(basename "${SHELL:-/bin/sh}")
    case "$_shell_name" in
        zsh)
            DETECTED_SHELL="zsh"
            SHELL_PROFILE="${HOME}/.zshrc"
            ;;
        bash)
            DETECTED_SHELL="bash"
            if [ -f "${HOME}/.bashrc" ]; then
                SHELL_PROFILE="${HOME}/.bashrc"
            elif [ -f "${HOME}/.bash_profile" ]; then
                SHELL_PROFILE="${HOME}/.bash_profile"
            else
                SHELL_PROFILE="${HOME}/.bashrc"
            fi
            ;;
        fish)
            DETECTED_SHELL="fish"
            SHELL_PROFILE=""  # fish uses fish_add_path
            ;;
        *)
            DETECTED_SHELL="$_shell_name"
            if [ -f "${HOME}/.profile" ]; then
                SHELL_PROFILE="${HOME}/.profile"
            else
                SHELL_PROFILE="${HOME}/.bashrc"
            fi
            ;;
    esac
}

# --- Prerequisite Checks ---
check_node() {
    if ! command_exists node; then
        error "Node.js is not installed."
        error "OpenPawl requires Node.js >= 20."
        echo ""
        echo "  Install Node.js: https://nodejs.org"
        echo "  Or via nvm:      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
        echo "                    nvm install 20"
        exit 1
    fi

    NODE_VERSION=$(node --version 2>/dev/null)
    if ! version_gte "$NODE_VERSION" "20"; then
        error "Node.js ${NODE_VERSION} is too old. OpenPawl requires >= 20."
        echo ""
        echo "  Upgrade: https://nodejs.org"
        echo "  Or via nvm: nvm install 20"
        exit 1
    fi

    success "Node.js ${NODE_VERSION} detected"
}

check_bun() {
    if command_exists bun; then
        BUN_VERSION=$(bun --version 2>/dev/null)
        success "bun ${BUN_VERSION} detected"
        return
    fi

    warn "bun not found — installing via install script..."
    if [ "$DRY_RUN" = true ]; then
        dry "curl -fsSL https://bun.sh/install | bash"
    else
        curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || {
            error "Failed to install bun. Install manually: https://bun.sh"
            exit 1
        }
        # Source bun into current session
        export BUN_INSTALL="${HOME}/.bun"
        export PATH="${BUN_INSTALL}/bin:${PATH}"
        BUN_VERSION=$(bun --version 2>/dev/null)
        success "bun ${BUN_VERSION} installed"
    fi
}

check_git() {
    if ! command_exists git; then
        error "git is not installed (required for source install)."
        echo "  Install: https://git-scm.com/downloads"
        exit 1
    fi
}

# --- Resolve Version ---
resolve_version() {
    if [ -n "$REQUESTED_VERSION" ]; then
        # Strip leading v if present
        VERSION=$(echo "$REQUESTED_VERSION" | sed 's/^v//')
        success "Installing version ${VERSION} (requested)"
        return
    fi

    # Fetch latest version from GitHub API
    info "Fetching latest version..."
    if command_exists curl; then
        _api_response=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null) || true
    elif command_exists wget; then
        _api_response=$(wget -qO- "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null) || true
    else
        _api_response=""
    fi

    if [ -n "$_api_response" ]; then
        # Extract tag_name from JSON (crude but POSIX-compatible)
        VERSION=$(echo "$_api_response" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/')
    fi

    if [ -z "$VERSION" ]; then
        # Fallback: get version from package.json on main branch
        if command_exists curl; then
            _pkg_json=$(curl -fsSL "https://raw.githubusercontent.com/${GITHUB_REPO}/main/package.json" 2>/dev/null) || true
        elif command_exists wget; then
            _pkg_json=$(wget -qO- "https://raw.githubusercontent.com/${GITHUB_REPO}/main/package.json" 2>/dev/null) || true
        else
            _pkg_json=""
        fi

        if [ -n "$_pkg_json" ]; then
            VERSION=$(echo "$_pkg_json" | grep '"version"' | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
        fi
    fi

    if [ -z "$VERSION" ]; then
        warn "Could not determine latest version, using 'main' branch"
        VERSION="main"
    else
        success "Latest version: ${VERSION}"
    fi
}

# --- Install Method 1: npm global ---
try_npm_install() {
    if ! command_exists npm; then
        return 1
    fi

    info "Trying npm global install..."

    if [ "$DRY_RUN" = true ]; then
        dry "npm install -g @openpawl/cli@${VERSION}"
        return 0
    fi

    # Check if the package exists on npm
    _npm_view=$(npm view "@openpawl/cli" version 2>/dev/null) || true
    if [ -z "$_npm_view" ]; then
        info "Package @openpawl/cli not found on npm, trying next method..."
        return 1
    fi

    if [ "$VERSION" = "main" ]; then
        npm install -g "@openpawl/cli" 2>/dev/null || return 1
    else
        npm install -g "@openpawl/cli@${VERSION}" 2>/dev/null || return 1
    fi

    INSTALL_METHOD="npm"
    success "Installed via npm"
    return 0
}

# --- Install Method 2: Binary download from GitHub releases ---
try_binary_install() {
    if [ "$VERSION" = "main" ]; then
        # No release for 'main', skip to source
        return 1
    fi

    _release_tag="v${VERSION}"
    _asset_name="openpawl-${OS}-${ARCH}.tar.gz"
    _download_url="https://github.com/${GITHUB_REPO}/releases/download/${_release_tag}/${_asset_name}"
    _checksum_url="https://github.com/${GITHUB_REPO}/releases/download/${_release_tag}/SHA256SUMS"

    info "Trying binary download for ${OS}/${ARCH}..."

    # Check if release asset exists
    _http_code=""
    if command_exists curl; then
        _http_code=$(curl -sLo /dev/null -w "%{http_code}" "$_download_url" 2>/dev/null) || true
    fi

    if [ "$_http_code" != "200" ] && [ "$_http_code" != "302" ]; then
        info "No binary release found, trying next method..."
        return 1
    fi

    if [ "$DRY_RUN" = true ]; then
        dry "Download ${_download_url}"
        dry "Verify checksum from ${_checksum_url}"
        dry "Extract to ${BIN_DIR}/openpawl"
        return 0
    fi

    # Create directories
    mkdir -p "$BIN_DIR"

    _tmp_dir=$(mktemp -d)
    _cleanup_binary() { rm -rf "$_tmp_dir"; }
    trap _cleanup_binary EXIT

    # Download binary
    info "Downloading OpenPawl ${_release_tag}..."
    if command_exists curl; then
        curl -fsSL "$_download_url" -o "${_tmp_dir}/${_asset_name}" || {
            error "Download failed"
            return 1
        }
    elif command_exists wget; then
        wget -q "$_download_url" -O "${_tmp_dir}/${_asset_name}" || {
            error "Download failed"
            return 1
        }
    fi

    # Verify checksum
    if command_exists curl; then
        curl -fsSL "$_checksum_url" -o "${_tmp_dir}/SHA256SUMS" 2>/dev/null || true
    elif command_exists wget; then
        wget -q "$_checksum_url" -O "${_tmp_dir}/SHA256SUMS" 2>/dev/null || true
    fi

    if [ -f "${_tmp_dir}/SHA256SUMS" ]; then
        _expected_sum=$(grep "$_asset_name" "${_tmp_dir}/SHA256SUMS" | awk '{print $1}')
        if [ -n "$_expected_sum" ]; then
            if command_exists sha256sum; then
                _actual_sum=$(sha256sum "${_tmp_dir}/${_asset_name}" | awk '{print $1}')
            elif command_exists shasum; then
                _actual_sum=$(shasum -a 256 "${_tmp_dir}/${_asset_name}" | awk '{print $1}')
            else
                warn "No sha256sum or shasum available — skipping checksum verification"
                _actual_sum="$_expected_sum"
            fi

            if [ "$_actual_sum" != "$_expected_sum" ]; then
                error "Checksum verification failed!"
                error "Expected: ${_expected_sum}"
                error "Got:      ${_actual_sum}"
                return 1
            fi
            success "Checksum verified"
        fi
    else
        warn "No checksums available — skipping verification"
    fi

    # Extract
    tar -xzf "${_tmp_dir}/${_asset_name}" -C "${_tmp_dir}" || {
        error "Failed to extract archive"
        return 1
    }

    # Install binary
    if [ -f "${_tmp_dir}/openpawl" ]; then
        mv "${_tmp_dir}/openpawl" "${BIN_DIR}/openpawl"
    elif [ -f "${_tmp_dir}/bin/openpawl" ]; then
        mv "${_tmp_dir}/bin/openpawl" "${BIN_DIR}/openpawl"
    else
        error "Binary not found in archive"
        return 1
    fi

    chmod +x "${BIN_DIR}/openpawl"
    trap - EXIT
    rm -rf "$_tmp_dir"

    INSTALL_METHOD="binary"
    success "Installed to ${BIN_DIR}/openpawl"
    return 0
}

# --- Install Method 3: Clone and build from source ---
try_source_install() {
    check_git

    info "Installing from source..."

    if [ "$DRY_RUN" = true ]; then
        dry "git clone ${GITHUB_URL} ${SOURCE_DIR}"
        dry "cd ${SOURCE_DIR} && bun install && bun run build"
        dry "ln -sf ${SOURCE_DIR}/dist/cli.js ${BIN_DIR}/openpawl"
        return 0
    fi

    mkdir -p "$BIN_DIR"

    if [ -d "$SOURCE_DIR" ]; then
        info "Updating existing source..."
        cd "$SOURCE_DIR"
        git fetch --all --quiet 2>/dev/null || true
        if [ "$VERSION" = "main" ]; then
            git checkout main --quiet 2>/dev/null || true
            git pull --quiet 2>/dev/null || true
        else
            git checkout "v${VERSION}" --quiet 2>/dev/null || git checkout "${VERSION}" --quiet 2>/dev/null || {
                error "Version ${VERSION} not found in repository"
                return 1
            }
        fi
    else
        info "Cloning repository..."
        if [ "$VERSION" = "main" ]; then
            git clone --depth 1 "$GITHUB_URL" "$SOURCE_DIR" 2>/dev/null || {
                error "Failed to clone repository"
                return 1
            }
        else
            # Try version tag first, fall back to main
            git clone --depth 1 --branch "v${VERSION}" "$GITHUB_URL" "$SOURCE_DIR" 2>/dev/null || \
            git clone --depth 1 --branch "${VERSION}" "$GITHUB_URL" "$SOURCE_DIR" 2>/dev/null || {
                warn "Version tag v${VERSION} not found, using main branch"
                git clone --depth 1 "$GITHUB_URL" "$SOURCE_DIR" 2>/dev/null || {
                    error "Failed to clone repository"
                    return 1
                }
            }
        fi
    fi

    cd "$SOURCE_DIR"

    info "Installing dependencies..."
    bun install --frozen-lockfile 2>/dev/null || bun install || {
        error "Failed to install dependencies"
        _cleanup_source
        return 1
    }

    info "Building..."
    bun run build || {
        error "Build failed"
        _cleanup_source
        return 1
    }

    # Create wrapper script that invokes node with the built CLI
    cat > "${BIN_DIR}/openpawl" << WRAPPER
#!/bin/sh
exec node "${SOURCE_DIR}/dist/cli.js" "\$@"
WRAPPER
    chmod +x "${BIN_DIR}/openpawl"

    INSTALL_METHOD="source"
    success "Built and installed to ${BIN_DIR}/openpawl"
    return 0
}

_cleanup_source() {
    if [ -d "$SOURCE_DIR" ] && [ "$INSTALL_METHOD" != "source" ]; then
        rm -rf "$SOURCE_DIR"
    fi
}

# --- PATH Setup ---
setup_path() {
    # npm global install handles PATH itself
    if [ "$INSTALL_METHOD" = "npm" ]; then
        return
    fi

    # Check if BIN_DIR is already in PATH
    case ":${PATH}:" in
        *":${BIN_DIR}:"*)
            success "PATH already includes ${BIN_DIR}"
            return
            ;;
    esac

    _path_line="export PATH=\"\$HOME/.openpawl/bin:\$PATH\""

    if [ "$DETECTED_SHELL" = "fish" ]; then
        if [ "$DRY_RUN" = true ]; then
            dry "fish: fish_add_path ${BIN_DIR}"
        else
            # Write to fish config
            _fish_config="${HOME}/.config/fish/conf.d/openpawl.fish"
            mkdir -p "$(dirname "$_fish_config")"
            echo "fish_add_path ${BIN_DIR}" > "$_fish_config"
            success "Added to PATH (${_fish_config})"
        fi
        return
    fi

    if [ -z "$SHELL_PROFILE" ]; then
        warn "Could not detect shell profile. Add this to your shell config:"
        echo "  ${_path_line}"
        return
    fi

    # Check if already in the profile
    if [ -f "$SHELL_PROFILE" ] && grep -qF '.openpawl/bin' "$SHELL_PROFILE" 2>/dev/null; then
        success "PATH already configured in ${SHELL_PROFILE}"
        return
    fi

    if [ "$DRY_RUN" = true ]; then
        dry "Append to ${SHELL_PROFILE}: ${_path_line}"
    else
        echo "" >> "$SHELL_PROFILE"
        echo "# OpenPawl" >> "$SHELL_PROFILE"
        echo "$_path_line" >> "$SHELL_PROFILE"
        success "Added to PATH (~/${SHELL_PROFILE##*/})"
    fi
}

# --- Post-install Verification ---
verify_install() {
    if [ "$DRY_RUN" = true ]; then
        dry "openpawl --version"
        return
    fi

    # For npm installs, openpawl should be in PATH already
    if [ "$INSTALL_METHOD" = "npm" ]; then
        if command_exists openpawl; then
            _installed_version=$(openpawl --version 2>/dev/null) || true
            if [ -n "$_installed_version" ]; then
                success "Verified: openpawl v${_installed_version}"
            fi
        fi
        return
    fi

    # For binary/source installs, use full path
    if [ -x "${BIN_DIR}/openpawl" ]; then
        _installed_version=$("${BIN_DIR}/openpawl" --version 2>/dev/null) || true
        if [ -n "$_installed_version" ]; then
            success "Verified: openpawl v${_installed_version}"
        else
            success "Installed (version check requires new shell)"
        fi
    fi
}

# --- Main ---
main() {
    printf "\n${BOLD}${CYAN}Installing OpenPawl...${RESET}\n\n"

    if [ "$DRY_RUN" = true ]; then
        warn "Dry run — no changes will be made"
        echo ""
    fi

    # System checks
    detect_os
    detect_arch
    detect_shell
    check_node
    check_bun

    echo ""

    # Resolve version
    resolve_version

    echo ""

    # Try install methods in priority order
    INSTALL_METHOD=""
    if try_npm_install; then
        :
    elif try_binary_install; then
        :
    elif try_source_install; then
        :
    else
        echo ""
        error "All installation methods failed."
        error "Please install manually: ${GITHUB_URL}#quickstart"
        exit 1
    fi

    echo ""

    # PATH setup
    setup_path

    echo ""

    # Verify
    verify_install

    # Success message
    echo ""
    printf "${BOLD}${GREEN}OpenPawl installed successfully!${RESET}\n"
    echo ""
    echo "  Get started:  openpawl setup"
    echo "  Documentation: ${GITHUB_URL}"
    echo ""

    if [ "$INSTALL_METHOD" != "npm" ]; then
        _shell_name=$(basename "${SHELL:-sh}")
        printf "  ${DIM}Restart your shell or run: source ~/${SHELL_PROFILE##*/}${RESET}\n"
        echo ""
    fi
}

main
