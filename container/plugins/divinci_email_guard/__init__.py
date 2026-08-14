"""divinci_email_guard — restrict tools on unattended (email-driven) turns.

Runtime wiring only. The decision logic lives in policy.py, which imports
nothing from Hermes so it can be tested without the agent installed.

Registered as a `pre_tool_call` hook. Returning
``{"action": "block", "message": ...}`` vetoes the call and hands the
message back as the tool result; `resolve_pre_tool_block` in
hermes_cli/plugins.py is already fail-closed, so a hook that raises blocks
rather than proceeds.

⚠️ USER PLUGINS ARE OPT-IN. A plugin in ~/.hermes/plugins/ does not load
unless its key is in `plugins.enabled` — and when it isn't, the only trace
is a DEBUG line ("Skipping '%s' (not in plugins.enabled)"). A guard that
silently fails to load looks exactly like a guard that is working, so
start-hermes.sh sets the config key alongside installing the files, and
tests/email-guard-wiring.test.ts asserts BOTH halves are present.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from .policy import UNATTENDED_ALLOWED_TOOLS, decide, normalize_platform

logger = logging.getLogger(__name__)


def _current_platform() -> str:
    """Read the bound session platform.

    Mirrors the fallback in tools/approval.py `_get_session_platform`: prefer
    the ContextVar (task-local, so concurrent turns can't read each other's
    value), fall back to the process env for contexts that never engaged the
    session-context system.
    """
    try:
        from gateway.session_context import get_session_env

        return normalize_platform(get_session_env("HERMES_SESSION_PLATFORM", ""))
    except Exception:
        import os

        return normalize_platform(os.getenv("HERMES_SESSION_PLATFORM", ""))


def _on_pre_tool_call(
    tool_name: str = "",
    args: Optional[Dict[str, Any]] = None,
    **_: Any,
) -> Optional[Dict[str, str]]:
    """Veto a tool call that an unattended turn may not make."""
    platform = _current_platform()
    message = decide(tool_name, platform)

    if message is None:
        return None

    # Log every refusal. Two reasons this is not optional: a blocked call is
    # otherwise invisible from outside the container, and this line is how
    # you tell "the guard is restricting correctly" from "the guard broke
    # the Slack path" — the failure modes look identical from the outside.
    #
    # Tool NAME and platform only. Never `args` — an inbound email's content
    # reaches this hook through tool arguments, and that content is exactly
    # the untrusted, potentially personal material the email prompt wraps in
    # a data boundary. Logging it would undo that.
    logger.warning(
        "[divinci-email-guard] blocked tool=%s platform=%s",
        tool_name,
        platform or "unknown",
    )

    return {"action": "block", "message": message}


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    # Emitted once at load. Its ABSENCE from the boot log is the signal that
    # `plugins.enabled` is missing the key and the guard is not running.
    logger.info(
        "[divinci-email-guard] active — unattended turns restricted to %d tools",
        len(UNATTENDED_ALLOWED_TOOLS),
    )
