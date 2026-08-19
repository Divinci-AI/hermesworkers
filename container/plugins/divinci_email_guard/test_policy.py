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

    # Exactly the Calendly tools approved on 2026-08-19. Kept as an equality
    # assertion, like the Fulcrum set: the point of this test is that widening
    # the allowlist has to be a deliberate edit HERE as well as there, so a
    # tool cannot be added on one side alone.
    # Underscores: Hermes sanitises every non-[A-Za-z0-9_] character out of
    # an MCP tool name before registering it, so Calendly's hyphenated API
    # names arrive here with underscores. See the note in policy.py.
    CALENDLY_TOOLS = {
        "event_types_list_event_types",
        "event_types_list_event_type_available_times",
        "scheduling_links_create_single_use_scheduling_link",
    }

    def test_allowlist_is_the_observer_set_plus_approved_calendly(self):
        fulcrum, calendly, other = set(), set(), set()
        for t in UNATTENDED_ALLOWED_TOOLS:
            if t.startswith("mcp__fulcrum__"):
                fulcrum.add(t.removeprefix("mcp__fulcrum__"))
            elif t.startswith("mcp__calendly__"):
                calendly.add(t.removeprefix("mcp__calendly__"))
            else:
                other.add(t)
        assert fulcrum == self.OBSERVER_TOOLS
        assert calendly == self.CALENDLY_TOOLS
        # No third server has crept in unnoticed.
        assert other == set(), other

    def test_no_calendly_tool_that_reads_meetings_or_writes_a_booking(self):
        # The property, asserted independently of the exact names above:
        # `meetings-*` returns who we are meeting and their addresses — the
        # sales pipeline — and on this path a read IS the exfiltration.
        for tool in UNATTENDED_ALLOWED_TOOLS:
            leaf = tool.removeprefix("mcp__calendly__")
            # Match BOTH spellings. Written hyphen-only this assertion
            # silently stopped guarding anything the moment the entries were
            # corrected to their sanitised form — a guard that fails open on
            # a rename is worse than no guard, because it still reads green.
            assert not leaf.startswith(("meetings-", "meetings_")), tool
            assert not leaf.startswith(("availability-", "availability_")), tool

    def test_no_allowlist_entry_would_be_rewritten_by_the_sanitizer(self):
        """Every entry must already be in the form Hermes will present.

        Hermes registers MCP tools as `mcp__<server>__<tool>` with each
        component passed through `re.sub(r"[^A-Za-z0-9_]", "_", ...)`
        (tools/mcp_tool.py). An entry copied verbatim from a vendor's docs —
        Calendly's are hyphenated — therefore never matches anything.

        This fails CLOSED, which is why it needs a test: the allowlist is
        deny-by-default, so the tool is simply refused, the turn degrades to
        "a human will follow up", and nothing anywhere reports a
        misconfiguration. It reads as "the integration doesn't work".
        """
        import re

        for tool in UNATTENDED_ALLOWED_TOOLS | REJECTED_FOR_UNATTENDED:
            sanitized = "mcp__" + "__".join(
                re.sub(r"[^A-Za-z0-9_]", "_", part)
                for part in tool.removeprefix("mcp__").split("__")
            ) if tool.startswith("mcp__") else re.sub(r"[^A-Za-z0-9_]", "_", tool)
            assert tool == sanitized, (
                f"{tool!r} would be registered by Hermes as {sanitized!r}, "
                f"so this entry can never match."
            )

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


class TestCalendlyOnTheUnattendedPath:
    """Added 2026-08-19.

    An email-driven sales turn kept ending in "Michael needs to provide
    available times" — the one question a scheduling tool answers. The three
    tools allowed are the ones whose output is ALREADY PUBLIC on the booking
    page; everything that would disclose the meeting list, or write to the
    calendar, stays blocked.
    """

    ALLOWED = [
        "mcp__calendly__event_types_list_event_types",
        "mcp__calendly__event_types_list_event_type_available_times",
        "mcp__calendly__scheduling_links_create_single_use_scheduling_link",
    ]
    BLOCKED = [
        "mcp__calendly__meetings_list_events",
        "mcp__calendly__meetings_list_event_invitees",
        "mcp__calendly__meetings_get_event",
        "mcp__calendly__meetings_get_event_invitee",
        "mcp__calendly__availability_list_user_busy_times",
        "mcp__calendly__meetings_cancel_event",
        "mcp__calendly__meetings_create_invitee",
        "mcp__calendly__event_types_update_event_type",
        "mcp__calendly__organizations_create_organization_invitation",
    ]

    @pytest.mark.parametrize("tool", ALLOWED)
    def test_public_scheduling_data_is_allowed(self, tool):
        assert decide(tool, "api_server") is None

    @pytest.mark.parametrize("tool", BLOCKED)
    def test_pipeline_reads_and_calendar_writes_are_blocked(self, tool):
        assert decide(tool, "api_server") is not None

    @pytest.mark.parametrize("tool", BLOCKED)
    def test_slack_still_gets_them(self, tool):
        # Slack has a human present; that is where booking and cancelling live.
        assert decide(tool, "slack") is None

    def test_a_new_calendly_tool_is_denied_by_default(self):
        # The allowlist must stay an allowlist as Calendly adds endpoints.
        assert decide("mcp__calendly__meetings_invent_new_thing", "api_server") is not None

    def test_the_documented_rejections_are_not_also_allowed(self):
        assert not (REJECTED_FOR_UNATTENDED & UNATTENDED_ALLOWED_TOOLS)
