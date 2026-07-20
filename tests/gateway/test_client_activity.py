"""Focused tests for deny-by-default client activity translation."""

from dataclasses import dataclass

import pytest

from gateway.client_activity import (
    ClientActivityTranslator,
    compose_callbacks,
    parse_tool_outcome,
    resolve_client_activity,
)


def _config(*rules, enabled=True):
    return {
        "display": {
            "client_activity": {
                "enabled": enabled,
                "default": "silent",
                "rules": list(rules),
            }
        }
    }


def _rule(*, tools, family="records", operations=None, required_args=None, args=None):
    rule = {
        "family": family,
        "tools": tools,
        "copy": {
            "start": "Checking records…",
            "success": "Records updated.",
            "failure": "Records could not be updated.",
        },
    }
    if operations is not None:
        rule["operations"] = operations
    if required_args is not None:
        rule["required_args"] = required_args
    if args is not None:
        rule["args"] = args
    return rule


def test_disabled_and_missing_rules_are_backward_compatible():
    assert not resolve_client_activity({}, "telegram").enabled
    assert not resolve_client_activity(_config(enabled=False), "telegram").enabled
    assert not resolve_client_activity(_config(), "telegram").enabled

    from hermes_cli.config import DEFAULT_CONFIG

    assert DEFAULT_CONFIG["display"]["client_activity"] == {
        "enabled": False,
        "default": "silent",
        "rules": [],
    }


def test_unknown_tool_is_silent_by_default():
    translator = resolve_client_activity(_config(_rule(tools=["known_*"])), "telegram")

    assert translator.start("1", "unclassified_tool", {"secret": "sk-private"}) is None
    assert translator.complete("1", "unclassified_tool", {}, {"success": True}) is None


def test_ordered_exact_glob_and_operation_arg_filters():
    translator = resolve_client_activity(
        _config(
            _rule(tools="records_get", family="exact", operations=["read"]),
            _rule(
                tools=["records_*"],
                family="glob",
                args={"scope": ["customer", "account"]},
            ),
        ),
        "telegram",
    )

    assert translator.start("1", "records_get", {"operation": "read"}) == "Checking records…"
    # First rule does not match the operation, so ordered matching continues.
    assert translator.start("2", "records_get", {"operation": "write", "scope": "customer"}) == "Checking records…"
    assert translator.start("3", "records_delete", {"scope": "internal"}) is None
    assert translator.start("4", "records_delete", {"scope": ["customer"]}) is None


def test_required_args_can_distinguish_read_from_write_without_reading_values():
    translator = resolve_client_activity(
        _config(_rule(tools="todo", required_args=["todos"])),
        "telegram",
    )

    assert translator.start("read", "todo", {}) is None
    assert translator.start("write", "todo", {"todos": []}) == "Checking records…"

    invalid = _rule(tools="todo", required_args=["todos", 123])
    assert not resolve_client_activity(_config(invalid), "telegram").enabled


def test_start_copy_is_config_only_and_dynamic_templates_are_rejected():
    secret = "sk-super-secret-value"
    path = "/home/customer/private.txt"
    translator = resolve_client_activity(_config(_rule(tools="records_*")), "telegram")

    assert translator.start("1", "records_private_tool", {"token": secret, "path": path}) == "Checking records…"

    templated = _rule(tools="records_*")
    templated["copy"]["start"] = "Updating {args[path]}"
    rejected = resolve_client_activity(_config(templated), "telegram")
    assert rejected.start("1", "records_private_tool", {"path": path}) is None


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        ({"success": True}, "success"),
        ({"ok": True}, "success"),
        ('{"success": true, "path": "/private"}', "success"),
        ({"success": False}, "failure"),
        ({"ok": False}, "failure"),
        ({"error": "provider returned a secret"}, "failure"),
        ({"isError": True}, "failure"),
        ("ok", None),
        ({"status": "completed"}, None),
        ({"success": "true"}, None),
        (None, None),
    ],
)
def test_parse_tool_outcome_is_conservative(result, expected):
    assert parse_tool_outcome(result) == expected


@dataclass
class _ToolResultLike:
    success: bool | None = None
    error: object = None


def test_tool_result_like_outcome_is_supported_conservatively():
    assert parse_tool_outcome(_ToolResultLike(success=True)) == "success"
    assert parse_tool_outcome(_ToolResultLike(success=False)) == "failure"
    assert parse_tool_outcome(_ToolResultLike(error="failed")) == "failure"


def test_correlated_completion_emits_verified_outcome_and_never_leaks_payload():
    translator = resolve_client_activity(_config(_rule(tools="records_*")), "telegram")
    secret = "«redacted:sk-…»"
    pii = "person@example.com"

    assert translator.start("1", "records_update", {"token": secret}) == "Checking records…"
    assert translator.complete("1", "records_update", {"token": secret}, {"success": True, "email": pii}) == "Records updated."
    assert translator.start("2", "records_update", {"token": secret}) is None
    assert translator.complete("2", "records_update", {"token": secret}, {"ok": False, "path": "/private"}) == "Records could not be updated."
    assert translator.start("3", "records_update", {"token": secret}) is None
    assert translator.complete("3", "records_update", {"token": secret}, {"message": pii}) is None

    emitted = "Records updated. Records could not be updated."
    assert secret not in emitted
    assert pii not in emitted
    assert "/private" not in emitted
    assert "records_update" not in emitted


def test_orphan_empty_and_cross_turn_completions_are_silent():
    config = _config(_rule(tools="records_*"))
    translator = resolve_client_activity(config, "telegram")

    assert translator.complete("unknown", "records_update", {}, {"success": True}) is None
    assert translator.complete("", "records_update", {}, {"success": True}) is None
    assert translator.complete(None, "records_update", {}, {"success": True}) is None
    assert translator.start("", "records_update", {}) is None

    assert translator.start("owned", "records_update", {}) == "Checking records…"
    other_turn = resolve_client_activity(config, "telegram")
    assert other_turn.complete("owned", "records_update", {}, {"success": True}) is None
    assert translator.complete("owned", "records_update", {}, {"success": True}) == "Records updated."
    # A late duplicate completion has already been retired and stays silent.
    assert translator.complete("owned", "records_update", {}, {"success": True}) is None


def test_dedupes_repeated_family_phase_per_turn():
    translator = resolve_client_activity(_config(_rule(tools="records_*", family="records")), "telegram")

    assert translator.start("1", "records_get", {}) == "Checking records…"
    assert translator.start("2", "records_update", {}) is None
    assert translator.complete("1", "records_get", {}, {"success": True}) == "Records updated."
    assert translator.complete("2", "records_update", {}, {"success": True}) is None
    assert translator.start("3", "records_delete", {}) is None
    assert translator.complete("3", "records_delete", {}, {"success": False}) == "Records could not be updated."
    assert translator.start("4", "records_delete", {}) is None
    assert translator.complete("4", "records_delete", {}, {"error": "again"}) is None


def test_platform_override_and_invalid_configuration_fail_closed():
    config = _config(_rule(tools="global_*"))
    config["display"]["platforms"] = {
        "telegram": {"client_activity": _config(_rule(tools="telegram_*"))["display"]["client_activity"]}
    }

    translator = resolve_client_activity(config, "telegram")
    assert translator.start("1", "global_read", {}) is None
    assert translator.start("2", "telegram_read", {}) == "Checking records…"

    assert not resolve_client_activity({"display": {"client_activity": "on"}}, "telegram").enabled
    assert not ClientActivityTranslator.from_config({"enabled": True, "default": "visible", "rules": [_rule(tools="*")]}).enabled


def test_composed_callbacks_keep_existing_and_client_activity_hooks():
    calls = []

    def existing(*args):
        calls.append(("existing", args))

    def activity(*args):
        calls.append(("activity", args))

    callback = compose_callbacks(existing, activity)
    assert callback is not None
    callback("call-1", "records_get", {"operation": "read"})

    assert [kind for kind, _ in calls] == ["existing", "activity"]
    assert compose_callbacks(existing, None) is existing
    assert compose_callbacks(None, None) is None


def test_composed_callback_failure_does_not_suppress_other_hooks():
    calls = []

    def broken(*args):
        calls.append("broken")
        raise RuntimeError("callback failed")

    def activity(*args):
        calls.append("activity")

    callback = compose_callbacks(broken, activity)
    assert callback is not None
    callback("call-1", "records_get", {})

    assert calls == ["broken", "activity"]
