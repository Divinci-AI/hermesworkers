"""Per-path tool policy for the hosted Divinci Hermes agent.

Pure decision logic, deliberately free of any Hermes import so it can be
unit-tested standalone (see test_policy.py). ``__init__.py`` supplies the
runtime wiring; everything that decides anything lives here.


WHY THIS EXISTS
===============

`approvals.mode` does NOT gate MCP tool calls. Verified at source in
NousResearch/hermes-agent v2026.7.7.2 (the tag container/Dockerfile pins):

  * `approvals.mode` is consumed by exactly two callers —
    `check_all_command_guards` (tools/terminal_tool.py) and
    `check_execute_code_guard` (tools/code_execution_tool.py). It is a
    SHELL COMMAND gate.
  * MCP tool calls dispatch through model_tools.py, whose only gate is
    `resolve_pre_tool_block` -> plugin `pre_tool_call` hooks.
  * `request_tool_approval` — the one generic tool gate — has a single
    caller: that plugin path.
  * tools/mcp_tool.py carries approval logic only for ELICITATIONS (an MCP
    server questioning the user), never for the tool call itself.
  * Reads and writes take the identical path; the code draws no distinction.

Observed live: the inbound email of 2026-08-14T05:32Z made a Fulcrum MCP
call in a 15s unattended turn with no approval prompt. `write_file` /
`execute_command` would have passed identically, and those execute on the
FULCRUM host — outside every container guard (hermes-term uid, egress
allowlist) this image relies on.

So the plugin hook is not one option among several. It is the ONLY
mechanism Hermes offers for restricting an arbitrary tool per request.


WHY IT CAN TELL THE PATHS APART
===============================

`set_session_vars(platform=...)` is called on both inbound paths with
different values:

    gateway/platforms/api_server.py   platform="api_server"   <- email
    gateway/run.py                    platform=<source>.value <- "slack"

Divinci's `runHermesTurn` sends {messages, model} to the Worker, which
forwards to the container's HTTP API server — so an email-driven turn is
always `api_server`. An interactive Slack turn arrives through the
socket-mode gateway as `slack`.

That value lives in a ContextVar, which is TASK-LOCAL. A Slack turn and an
email turn running concurrently in one container cannot read each other's
platform. That property — not mere convenience — is what makes per-path
policy sound here.
"""

from __future__ import annotations

from typing import Optional

# Platforms that get the unrestricted toolset. A human is present on these:
# they are reading the reply and can see what the agent did.
#
# ⚠️ Adding a value here grants it EVERY tool, including Fulcrum's
# execute_command / write_file on the Fulcrum host. Do not add a value
# because a turn failed — find out which platform it was and whether a
# human is actually present on it.
INTERACTIVE_PLATFORMS = frozenset({"slack"})

# What an UNATTENDED turn may call.
#
# This is an ALLOWLIST, not a denylist, and that is the whole point: a tool
# added to Hermes or to Fulcrum tomorrow is denied here by default rather
# than silently inheriting access. A denylist would have to be updated in
# lockstep with every upstream release to stay correct, and would fail open
# when it wasn't.
#
# Contents mirror Fulcrum's /mcp/observer whitelist — task filing and
# memory, no execution, no file access, no mail, no deletes. Names carry the
# `mcp__<server>__` prefix that Hermes gives MCP tools (observed in the
# container log as `mcp__fulcrum__get_task`).
UNATTENDED_ALLOWED_TOOLS = frozenset({
    "mcp__fulcrum__list_tasks",
    "mcp__fulcrum__create_task",
    "mcp__fulcrum__update_task",
    "mcp__fulcrum__move_task",
    "mcp__fulcrum__add_task_tag",
    "mcp__fulcrum__add_task_link",
    "mcp__fulcrum__set_task_due_date",
    "mcp__fulcrum__memory_list",
    "mcp__fulcrum__memory_search",
    "mcp__fulcrum__memory_store",
    "mcp__fulcrum__memory_file_read",
    "mcp__fulcrum__send_notification",

    # ── Calendly ───────────────────────────────────────────────────────────
    #
    # Added 2026-08-19 because an email-driven sales turn kept ending in
    # "Michael needs to provide available times", which is the one question a
    # scheduling tool answers and a human should not have to.
    #
    # ⚠️ THESE ARE USED BY SLACK ONLY. Nothing on the EMAIL path depends on
    # them, and reading this block as "the control that makes email booking
    # work" gets both halves wrong. Email booking is done server-side: the
    # public-api webhook calls Calendly itself and injects the times into the
    # prompt, so the container never holds a scheduling credential and never
    # calls a scheduling tool. That split was deliberate — the container reads
    # attacker-controlled mail, and Calendly ROTATES refresh tokens, which the
    # container's ephemeral $HERMES_HOME/mcp-tokens/ cannot survive (it would
    # have passed testing and died in a week).
    #
    # So: these entries are correct and should stay, because the Hermes Local /
    # Slack surface does call the tools directly. They are simply not what
    # makes the email replies carry times. Removing them breaks Slack; keeping
    # them proves nothing about email.
    #
    # ⚠️ CHOSEN AGAINST THIS FILE'S OWN TEST, NOT AGAINST "read-only".
    # The rejection note below is explicit that read-only is the wrong
    # property here — on this path a read IS the exfiltration, because the
    # turn output leaves the container and the auto-reply lands it in an
    # inbox. The test that matters is "cannot reach the credentials, and
    # cannot reach content from another path". These three pass it because
    # what they return is ALREADY PUBLIC: the event types and open slots on
    # the public booking page, and a link to that same page.
    # ⚠️ UNDERSCORES, NOT HYPHENS. Calendly's own names are hyphenated
    # (`event_types-list_event_types`), and the prose below uses that form
    # because it is what the API docs say. Hermes does NOT: it registers MCP
    # tools as `mcp__<server>__<tool>` after running each component through
    # `re.sub(r"[^A-Za-z0-9_]", "_", ...)` (mcp_tool.py), so every hyphen
    # arrives here as an underscore. Writing the docs' form is not a typo that
    # fails loudly — the allowlist is deny-by-default, so it fails CLOSED and
    # silently, and reads as "Calendly doesn't work". Pinned by
    # test_no_allowlist_entry_would_be_rewritten_by_the_sanitizer.
    "mcp__calendly__event_types_list_event_types",
    "mcp__calendly__event_types_list_event_type_available_times",
    # A write, deliberately, and the safest way to close a scheduling thread:
    # it returns a URL and lets the invitee choose. Nothing is written to the
    # calendar, no existing booking is touched, and a leaked link books time
    # with us rather than exposing anything. Prefer this over booking on
    # someone's behalf.
    "mcp__calendly__scheduling_links_create_single_use_scheduling_link",
})

# ── Considered for this list and DELIBERATELY REJECTED ─────────────────────
#
# Production logs showed `blocked tool=session_search` and
# `blocked tool=search_files` on api_server, and the obvious reading is that
# the allowlist is too tight: these are built-in, read-only, and the agent
# reaches for them while reasoning. Adding them would plainly improve email
# summaries.
#
# Both were checked at source before being added, and neither is safe here.
#
#   search_files  — takes an arbitrary `path` (default "."), is backed by
#                   ripgrep, and returns matching file CONTENT. There is no
#                   path sandbox: `_check_file_reqs` only checks that the
#                   tooling is available. It runs as a Hermes BUILT-IN, i.e.
#                   as `hermes` — the uid that owns ~/.hermes/. So
#                   search_files(pattern="API_KEY|sk-", path="~/.hermes")
#                   returns provider credentials. That is the exact
#                   2026-07-27 exfiltration, reached by a different verb.
#
#   session_search — FTS5 over the local SQLite message store, returning
#                   actual messages from ANY past session. Sessions hold
#                   whatever was pasted into them, including — during the
#                   2026-07-27 incident — real production keys, plus every
#                   internal Slack conversation this agent has had.
#
# Both are READS, and that is precisely why they looked benign. On this path
# a read IS the exfiltration: the turn output leaves the container, and since
# the email auto-reply shipped it lands in an inbox.
#
# "Read-only" is not the safety property that matters here. "Cannot reach the
# credentials, and cannot reach content from another path" is. Neither
# qualifies, so the degraded summaries stand.
#
# If email summaries need to improve, the way to do it is a tool whose scope
# is bounded by construction — the way the bounded terminal's tools are
# bounded by uid 10002 — not a built-in that happens to be read-shaped.
#
# ── Calendly tools considered and DELIBERATELY REJECTED (2026-08-19) ───────
#
# The obvious pick was `availability-list_user_busy_times` — it directly
# answers "when is Michael free?". It is read-only, and read-only is exactly
# the argument this section exists to reject.
#
#   meetings-list_events        — returns the upcoming meeting list: who,
#   meetings-list_event_invitees  when, and their email addresses. That is the
#   meetings-get_event            SALES PIPELINE, reachable by anyone who can
#   meetings-get_event_invitee    email the agent, returned in a reply. It is
#                                 the search_files failure exactly: content
#                                 from another path, reached by a read.
#
#   availability-list_user_busy_times — not public. Busy intervals disclose
#                                 working patterns and, depending on the
#                                 account, event detail. And it is not needed:
#                                 list_event_type_available_times gives the
#                                 bookable complement from public data.
#
#   meetings-cancel_event       — mutations on EXISTING bookings. An agent
#   meetings-create_invitee       reading attacker-adjacent mail must not be
#   event_types-update_*          able to move, cancel or create meetings, or
#                                 edit what is bookable. Slack has a human
#                                 present and already has the full toolset;
#                                 that is where these belong.
REJECTED_FOR_UNATTENDED = frozenset({
    "search_files",
    "session_search",
    "mcp__calendly__meetings_list_events",
    "mcp__calendly__meetings_list_event_invitees",
    "mcp__calendly__meetings_get_event",
    "mcp__calendly__meetings_get_event_invitee",
    "mcp__calendly__availability_list_user_busy_times",
    "mcp__calendly__meetings_cancel_event",
    "mcp__calendly__meetings_create_invitee",
})

# Message handed back as the tool result. The model reads this, so it says
# what happened and what to do instead — an opaque refusal invites retry
# loops, and a retry loop on an unattended path is a cost problem as well as
# a noise problem.
_BLOCK_TEMPLATE = (
    "BLOCKED: '{tool}' is not available on this path. This turn was started "
    "by an unattended trigger (platform={platform}), which is restricted to "
    "reading and filing tasks. Do not retry this tool. Summarise what you "
    "found and note that the action needs a human in Slack."
)


def normalize_platform(raw: Optional[str]) -> str:
    """Fold a raw session-platform value to its comparison form.

    Empty/None survives as "" so callers can distinguish "no platform bound"
    from a real one — the caller treats it as unattended.
    """
    return (raw or "").strip().lower()


def is_interactive(platform: Optional[str]) -> bool:
    """True when a human is present on this path.

    Fails CLOSED: anything not explicitly listed is treated as unattended.
    In this container every turn is bound by either the messaging gateway or
    the API server, so an unrecognised value means something unanticipated —
    and unanticipated should get the narrow toolset, not the wide one. Same
    reasoning as the email sender allowlist, where empty means "deny
    everyone" rather than "allow anyone".
    """
    return normalize_platform(platform) in INTERACTIVE_PLATFORMS


def decide(tool_name: str, platform: Optional[str]) -> Optional[str]:
    """Return a block message, or None to allow the call.

    Shape matches what `pre_tool_call` wants for a `block` directive: the
    returned string becomes the tool result the model sees.
    """
    if is_interactive(platform):
        return None

    if tool_name in UNATTENDED_ALLOWED_TOOLS:
        return None

    return _BLOCK_TEMPLATE.format(
        tool=tool_name,
        platform=normalize_platform(platform) or "unknown",
    )
