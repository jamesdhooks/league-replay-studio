#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# start.sh — Launch League Replay Studio (Unix / macOS)
#
# Usage:
#   ./start.sh           # Start backend + open frontend
#   ./start.sh --dev     # Start backend + Vite dev server
#   ./start.sh --help    # Show usage
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colours ───────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_header() {
  echo -e "${CYAN}"
  echo "╔═══════════════════════════════════════════╗"
  echo "║       League Replay Studio                ║"
  echo "╚═══════════════════════════════════════════╝"
  echo -e "${NC}"
}

# ── Help ──────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: ./start.sh [--dev]"
  echo ""
  echo "  (no args)   Start the backend server and open the app in a browser"
  echo "  --dev       Start the backend + Vite dev server with hot reload"
  echo ""
  exit 0
fi

print_header

# ── Check Python ──────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo -e "${RED}Error: python3 is not installed or not on PATH.${NC}"
  exit 1
fi

PYTHON="python3"
echo -e "${GREEN}✓${NC} Python: $($PYTHON --version 2>&1)"

# ── Check / create venv ──────────────────────────────────────────────
VENV_DIR="$SCRIPT_DIR/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
  echo -e "${YELLOW}Creating virtual environment...${NC}"
  $PYTHON -m venv "$VENV_DIR"
fi

# Activate
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
echo -e "${GREEN}✓${NC} Virtual environment activated"

# ── Install Python deps ──────────────────────────────────────────────
echo -e "${YELLOW}Installing Python dependencies...${NC}"
pip install -q -r requirements.txt 2>/dev/null
echo -e "${GREEN}✓${NC} Python dependencies installed"

# ── Build frontend if needed ─────────────────────────────────────────
if [[ "${1:-}" == "--dev" ]]; then
  echo -e "${YELLOW}Starting Vite dev server...${NC}"
  (cd frontend && npm install --silent && npx vite --host &)
  DEV_MODE=true
else
  if [[ ! -f "backend/static/index.html" ]]; then
    echo -e "${YELLOW}Building frontend...${NC}"
    (cd frontend && npm install --silent && npx vite build)
    echo -e "${GREEN}✓${NC} Frontend built"
  else
    echo -e "${GREEN}✓${NC} Frontend already built"
  fi
  DEV_MODE=false
fi

# ── Start backend ────────────────────────────────────────────────────
echo -e "${CYAN}Starting backend server on http://127.0.0.1:6175 ...${NC}"

if [[ "$DEV_MODE" == true ]]; then
  echo -e "${CYAN}Frontend dev server on http://localhost:3174${NC}"
fi

$PYTHON -m uvicorn backend.app:app --host 127.0.0.1 --port 6175 --reload
