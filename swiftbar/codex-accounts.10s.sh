#!/usr/bin/env bash
#
# <xbar.title>Codex Accounts</xbar.title>
# <xbar.version>v0.1</xbar.version>
# <xbar.author>neoleo</xbar.author>
# <xbar.desc>Switch Codex/ChatGPT accounts from the menu bar.</xbar.desc>
# <xbar.dependencies>node</xbar.dependencies>
#
# SwiftBar / xbar menu-bar plugin for codex-accounts.
#
# SETUP:
#   1. Install SwiftBar (https://swiftbar.app) or xbar (https://xbarapp.com).
#   2. Edit TOOL_DIR below to point at your extracted codex-accounts folder.
#   3. Copy this file into your SwiftBar/xbar plugin folder, then:
#        chmod +x codex-accounts.10s.sh
#   4. Refresh SwiftBar. A 🤖 menu appears; click an account to switch
#      (auto-restarts the Codex app).
#
# The ".10s." in the filename = refresh every 10s. Rename to .1m. for 1 min.

# --- EDIT THIS to where you put the folder ------------------------------------
TOOL_DIR="$HOME/Desktop/codex-accounts"
# -----------------------------------------------------------------------------

# Locate node even under SwiftBar's minimal PATH.
find_node() {
  for c in "$(command -v node 2>/dev/null)" \
           /opt/homebrew/bin/node /usr/local/bin/node \
           "$HOME/.nvm/versions/node"/*/bin/node; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

NODE="$(find_node)"
CLI="$TOOL_DIR/bin/codex-accounts.js"

if [ -z "$NODE" ]; then
  echo "🤖 ⚠️"; echo "---"; echo "node not found in PATH | color=red"; exit 0
fi
if [ ! -f "$CLI" ]; then
  echo "🤖 ⚠️"; echo "---"; echo "edit TOOL_DIR in this plugin | color=red"
  echo "expected: $CLI"; exit 0
fi

exec "$NODE" "$CLI" menubar
