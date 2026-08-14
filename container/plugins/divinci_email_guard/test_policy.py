"""Tests for the unattended-turn tool policy.

Run standalone — policy.py imports nothing from Hermes:

    python3 -m pytest container/plugins/divinci_email_guard/test_policy.py

⚠️ Every test here asserts BOTH directions. A guard that blocks everything
passes any block-only test suite while having broken the Slack path, and the
two failures are indistinguishable from outside the container. That is not a
hypothetical: during the /mcp/observer rollout, `TOOL_ABSENT` from a
correctly-restricted agent and `TOOL_ABSENT` from an agent whose Fulcrum
connection had died were the same string. The control assertion is what
tells them apart.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from divinci_email_guard.policy import (  # noqa: E402
    INTERACTIVE_PLATFORMS,
    REJECTED_FOR_UNATTENDED,
    UNATTENDED_ALLOWED_TOOLS,
    decide,
    is_interactive,
    normalize_platform,
)

# Tools that exist on Fulcrum's full /mcp and must never reach an unattended
# turn. execute_command and write_file run on the FULCRUM host, outside every
# container guard this image relies on.
DANGEROUS = [
    "mcp__fulcrum__execute_command",
    "mcp__fulcrum__write_file",
    "mcp__fulcrum__edit_file",
    "mcp__fulcrum__read_file",
    "mcp__fulcrum__delete_task",
    "mcp__fulcrum__delete_project",
    "mcp__fulcrum__create_gmail_draft",
    "mcp__fulcrum__update_gmail_draft",
    "mcp__fulcrum__list_emails",
    "mcp__fulcrum__get_task",
    "mcp__divinci_terminal__run",
    "terminal",
    "write_file",
    "execute_code",
]


class TestSlackKeepsEverything:
    """The interactive path must lose NOTHING. This is half the point."""

    @pytest.mark.parametrize("tool", DANGEROUS)
    def test_slack_may_call_any_tool(self, tool):
        assert decide(tool, "slack") is None

    @pytest.mark.parametrize("tool", sorted(UNATTENDED_ALLOWED_TOOLS))
    def test_slack_may_call_the_safe_tools_too(self, tool):
        assert decide(tool, "slack") is None

    def test_slack_is_recognised_as_interactive(self):
        assert is_interactive("slack") is True


class TestEmailIsRestricted:
    @pytest.mark.parametrize("tool", DANGEROUS)
    def test_api_server_is_refused_dangerous_tools(self, tool):
        msg = decide(tool, "api_server")
        assert msg is not None
        assert tool in msg

    @pytest.mark.parametrize("tool", sorted(UNATTENDED_ALLOWED_TOOLS))
    def test_api_server_keeps_the_read_and_file_tools(self, tool):
        # The control. Without this, a policy that blocked everything would
        # pass every other test in this class.
        assert decide(tool, "api_server") is None

    def test_block_message_tells_the_model_not_to_retry(self):
        # An opaque refusal invites a retry loop, which on an unattended path
        # costs money as well as noise.
        msg = decide("mcp__fulcrum__execute_command", "api_server")
        assert "Do not retry" in msg


class TestFailsClosed:
    """An unrecognised platform gets the NARROW set, never the wide one."""

    @pytest.mark.parametrize(
        "platform", ["", None, "unknown", "cli", "cron", "discord", "telegram"]
    )
    def test_unknown_platform_is_treated_as_unattended(self, platform):
        assert is_interactive(platform) is False
        assert decide("mcp__fulcrum__execute_command", platform) is not None

    @pytest.mark.parametrize("platform", ["", None, "unknown"])
    def test_unknown_platform_still_permits_the_safe_set(self, platform):
        # Fail-closed must not mean fail-useless: a turn on an unrecognised
        # platform can still file a task.
        assert decide("mcp__fulcrum__list_tasks", platform) is None

    def test_a_new_upstream_tool_is_denied_by_default(self):
        # The allowlist's reason for being. A tool added to Fulcrum or Hermes
        # tomorrow must not inherit access to the unattended path.
        assert decide("mcp__fulcrum__some_tool_added_in_2027", "api_server") is not None


class TestPlatformNormalisation:
    @pytest.mark.parametrize("raw", ["Slack", "SLACK", "  slack  ", "\tslack\n"])
    def test_case_and_whitespace_do_not_defeat_the_interactive_check(self, raw):
        # set_session_vars passes an enum .value so this should already be
        # lowercase — but a policy that hinged on exact casing would fail
        # OPEN if that ever changed, and this direction of failure is the
        # one that matters.
        assert is_interactive(raw) is True

    def test_normalize_preserves_empty_as_empty(self):
        assert normalize_platform(None) == ""
        assert normalize_platform("  ") == ""


class TestTheAllowlistMatchesObserver:
    """Pinned against Fulcrum's /mcp/observer set, verified live 2026-08-14.

    If these drift apart the deployment has two different answers to "what
    may an unattended turn do", and which one applies depends on config
    nobody is looking at.
    """

    OBSERVER_TOOLS = {
        "add_task_link",
        "add_task_tag",
        "create_task",
        "list_tasks",
        "memory_file_read",
        "memory_list",
        "memory_search",
        "memory_store",
        "move_task",
        "send_notification",
        "set_task_due_date",
        "update_task",
    }

    def test_allowlist_is_the_observer_set(self):
        ours = {t.removeprefix("mcp__fulcrum__") for t in UNATTENDED_ALLOWED_TOOLS}
        assert ours == self.OBSERVER_TOOLS

    def test_no_execution_or_file_tool_slipped_into_the_allowlist(self):
        # A second, independent assertion on the same set. The equality test
        # above would also catch this, but it fails as an opaque set diff;
        # this one names the property that actually matters.
        banned = ("exec", "write", "edit", "read_file", "delete", "mail", "command")
        for tool in UNATTENDED_ALLOWED_TOOLS:
            leaf = tool.removeprefix("mcp__fulcrum__")
            assert not any(b in leaf for b in banned), tool


class TestInteractivePlatformsIsDeliberatelyTiny:
    def test_only_slack_is_interactive(self):
        # Guards the blast radius of a careless edit: adding a platform here
        # grants it execute_command on the Fulcrum host.
        assert INTERACTIVE_PLATFORMS == frozenset({"slack"})

    def test_api_server_is_not_interactive(self):
        # The single most important assertion in the file — api_server IS the
        # email path.
        assert is_interactive("api_server") is False


class TestTheReadOnlyBuiltInsStayBlocked:
    """search_files and session_search were proposed for the allowlist.

    They are the most likely future edit to this policy, because production
    logs show them being blocked and both are read-only built-ins that
    obviously improve an email summary. The reason they are refused is not
    obvious from their names, so it is asserted rather than left to the
    comment: both are unsandboxed reads executing as the credential-owning
    uid, and on this path the turn output leaves the container.
    """

    def test_search_files_is_blocked_on_the_email_path(self):
        # Arbitrary `path`, ripgrep-backed, returns file CONTENT, runs as
        # `hermes` — i.e. it can read ~/.hermes/.env.
        assert decide("search_files", "api_server") is not None

    def test_session_search_is_blocked_on_the_email_path(self):
        # Returns real messages from any past session, including Slack.
        assert decide("session_search", "api_server") is not None

    def test_neither_is_in_the_allowlist(self):
        assert not (REJECTED_FOR_UNATTENDED & UNATTENDED_ALLOWED_TOOLS)

    def test_both_still_work_on_slack(self):
        # The inverse direction. A policy that blocked these everywhere would
        # pass every assertion above while having quietly degraded the
        # interactive path — and from outside the container, a tool that is
        # refused and a tool that is broken look identical.
        for tool in REJECTED_FOR_UNATTENDED:
            assert decide(tool, "slack") is None
