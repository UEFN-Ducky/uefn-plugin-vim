"""Vim plugin — MCP tools that drive Verse editor vim via editor_batch events."""

from __future__ import annotations

import json
from typing import Any


def _norm_verse_path(relative_path: str) -> str:
    rel = (relative_path or "").strip().replace("\\", "/")
    if not rel.lower().endswith(".verse"):
        raise ValueError("Only .verse files are supported")
    return rel


def _push_batch(actions: list[dict[str, Any]]) -> None:
    from frontend.ui_web.verse_editor.panel_events import push_agent_event

    push_agent_event({"type": "editor_batch", "editor_batch": {"actions": actions}})


def _plugin_enabled() -> bool:
    """Master enable lives in plugin UI prefs (shell.boot / settings.sections)."""
    try:
        from backend.uefn_plugins.host import is_plugin_enabled

        return bool(is_plugin_enabled("vim"))
    except Exception:
        return False


def _prefs_enabled() -> bool:
    try:
        from frontend.ui_web.panel_api import PanelApi

        # Prefs are client-side; MCP path treats plugin-enabled as gate.
        # Boot.js also checks prefs.enabled.
        return _plugin_enabled()
    except Exception:
        return _plugin_enabled()


def register(api) -> None:
    @api.tool(intent=r"\bvim\b")
    def workspace_editor_vim_set(relative_path: str, enabled: bool, pretty: bool = False) -> str:
        """Enable or disable Vim mode for an open Verse file (requires Vim plugin enabled)."""
        if not _prefs_enabled():
            raise ValueError("Vim plugin is disabled — enable it in Settings → Store / Vim")
        rel = _norm_verse_path(relative_path)
        from backend.bridge import resolve_workspace_path

        resolve_workspace_path(rel)
        _push_batch(
            [
                {"type": "open_file", "path": rel, "activate": False},
                {"type": "set_vim_enabled", "path": rel, "enabled": bool(enabled)},
            ]
        )
        payload = {"path": rel, "vim_enabled": bool(enabled)}
        return json.dumps(payload, indent=2 if pretty else None)

    @api.tool(intent=r"\bvim\b")
    def workspace_editor_vim_command(relative_path: str, command: str, pretty: bool = False) -> str:
        """Run a Vim command or key sequence in an open Verse file (e.g. gg, dd, :w)."""
        if not _prefs_enabled():
            raise ValueError("Vim plugin is disabled — enable it in Settings → Store / Vim")
        rel = _norm_verse_path(relative_path)
        from backend.bridge import resolve_workspace_path

        resolve_workspace_path(rel)
        cmd = (command or "").strip()
        if not cmd:
            raise ValueError("command is required")
        _push_batch([{"type": "run_vim_command", "path": rel, "text": cmd}])
        payload = {"path": rel, "command": cmd}
        return json.dumps(payload, indent=2 if pretty else None)

    @api.tool(intent=r"\bvim\b|editor\s+state|cursor")
    def workspace_editor_get_state(relative_path: str, pretty: bool = False) -> str:
        """Get Verse editor state (cursor, selection, vim mode) for a path."""
        rel = _norm_verse_path(relative_path)
        from frontend.ui_web.verse_editor.editor_state_registry import get_state

        snapshot = get_state(rel)
        master = _prefs_enabled()
        if snapshot is None:
            payload = {"path": rel, "found": False, "vim_master_enabled": master}
        else:
            payload = dict(snapshot)
            payload["vim_master_enabled"] = master
            payload.setdefault("path", rel)
            payload["found"] = True
        return json.dumps(payload, indent=2 if pretty else None)

    api.log("vim MCP tools registered")
