"""Compatibility shim for the original overlay-only MCP server."""

import sys

from server import mcp_lrs_server as _impl

if __name__ == "__main__":
    _impl.mcp.run()
else:
    sys.modules[__name__] = _impl
