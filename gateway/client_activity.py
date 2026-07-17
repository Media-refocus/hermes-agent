"""Config-driven, deny-by-default client activity translation.

The gateway may use this module to turn explicitly classified tool lifecycle
signals into fixed, client-facing copy.  Tool names, arguments and results are
selectors only: they are never interpolated into emitted text.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from fnmatch import fnmatchcase
from threading import Lock
from typing import Any, Callable, Literal, Mapping, Sequence

Outcome = Literal["success", "failure"]
_PHASES = ("start", "success", "failure")
_OPERATION_KEYS = ("operation", "action")


@dataclass(frozen=True)
class _Rule:
    family: str
    tools: tuple[str, ...]
    operations: frozenset[str] | None
    required_args: frozenset[str]
    arg_filters: tuple[tuple[str, frozenset[Any]], ...]
    copy: Mapping[str, str]

    def matches(self, tool_name: Any, args: Any) -> bool:
        if not isinstance(tool_name, str) or not any(
            fnmatchcase(tool_name, pattern) for pattern in self.tools
        ):
            return False
        safe_args = args if isinstance(args, Mapping) else {}
        if not self.required_args.issubset(safe_args):
            return False
        if self.operations is not None:
            operation = next(
                (safe_args.get(key) for key in _OPERATION_KEYS if key in safe_args),
                None,
            )
            if not _contains(self.operations, operation):
                return False
        return all(_contains(allowed, safe_args.get(key)) for key, allowed in self.arg_filters)


class ClientActivityTranslator:
    """Per-turn translator with family/phase deduplication."""

    def __init__(self, rules: Sequence[_Rule] = (), *, enabled: bool = False):
        self._rules = tuple(rules)
        self.enabled = bool(enabled and self._rules)
        self._seen: set[tuple[str, str]] = set()
        self._calls: dict[str, _Rule] = {}
        self._lock = Lock()

    @classmethod
    def from_config(cls, config: Any) -> "ClientActivityTranslator":
        """Validate one ``client_activity`` section, failing closed."""
        if not isinstance(config, Mapping) or not _is_enabled(config.get("enabled")):
            return cls()
        if str(config.get("default", "silent")).strip().lower() != "silent":
            return cls()
        raw_rules = config.get("rules")
        if not isinstance(raw_rules, list):
            return cls()
        rules = tuple(rule for item in raw_rules if (rule := _parse_rule(item)) is not None)
        return cls(rules, enabled=True)

    def start(self, call_id: Any, tool_name: Any, args: Any) -> str | None:
        if not self.enabled or not isinstance(call_id, str) or not call_id:
            return None
        rule = self._match(tool_name, args)
        if rule is None:
            return None
        with self._lock:
            # A duplicated lifecycle id must not be rebound to another call.
            if call_id in self._calls:
                return None
            self._calls[call_id] = rule
            return self._emit_locked(rule, "start")

    def complete(
        self,
        call_id: Any,
        tool_name: Any,
        args: Any,
        result: Any,
    ) -> str | None:
        if not self.enabled or not isinstance(call_id, str) or not call_id:
            return None
        outcome = parse_tool_outcome(result)
        with self._lock:
            rule = self._calls.pop(call_id, None)
            # A completion is authoritative only when this per-turn translator
            # observed its matching start. Never reclassify orphan, stale or
            # cross-turn completions from tool_name/args alone.
            if outcome is None or rule is None:
                return None
            return self._emit_locked(rule, outcome)

    def _match(self, tool_name: Any, args: Any) -> _Rule | None:
        return next((rule for rule in self._rules if rule.matches(tool_name, args)), None)

    def _emit_locked(self, rule: _Rule, phase: str) -> str | None:
        copy = rule.copy.get(phase)
        key = (rule.family, phase)
        if not copy or key in self._seen:
            return None
        self._seen.add(key)
        return copy


def resolve_client_activity(
    user_config: Any,
    platform_key: str | None = None,
) -> ClientActivityTranslator:
    """Resolve global or per-platform ``display.client_activity`` config.

    A per-platform section replaces the global section rather than merging it,
    keeping rule ordering and the opt-in boundary unambiguous.
    """
    if not isinstance(user_config, Mapping):
        return ClientActivityTranslator()
    display = user_config.get("display")
    if not isinstance(display, Mapping):
        return ClientActivityTranslator()
    section = display.get("client_activity")
    platforms = display.get("platforms")
    if platform_key and isinstance(platforms, Mapping):
        platform = platforms.get(platform_key)
        if isinstance(platform, Mapping) and "client_activity" in platform:
            section = platform.get("client_activity")
    return ClientActivityTranslator.from_config(section)


def parse_tool_outcome(result: Any) -> Outcome | None:
    """Return a verified boolean outcome, never infer one from prose/status."""
    value = result
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped.startswith("{"):
            return None
        try:
            value = json.loads(stripped)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None

    if isinstance(value, Mapping):
        return _mapping_outcome(value)

    # Conservative ToolResult-like support: inspect only known lifecycle fields.
    fields: dict[str, Any] = {}
    for key in ("success", "ok", "error", "is_error", "isError"):
        try:
            field = getattr(value, key)
        except (AttributeError, TypeError):
            continue
        fields[key] = field
    return _mapping_outcome(fields) if fields else None


def compose_callbacks(*callbacks: Callable[..., Any] | None) -> Callable[..., None] | None:
    """Compose lifecycle callbacks without one callback suppressing another."""
    active = tuple(callback for callback in callbacks if callable(callback))
    if not active:
        return None
    if len(active) == 1:
        return active[0]

    def composed(*args: Any, **kwargs: Any) -> None:
        for callback in active:
            try:
                callback(*args, **kwargs)
            except Exception:
                logging.getLogger(__name__).debug(
                    "client activity lifecycle callback failed", exc_info=True
                )

    return composed


def _mapping_outcome(value: Mapping[str, Any]) -> Outcome | None:
    for key in ("error",):
        if key in value and value[key] not in (None, False, "", [], {}):
            return "failure"
    for key in ("is_error", "isError"):
        if value.get(key) is True:
            return "failure"

    booleans = [value[key] for key in ("success", "ok") if type(value.get(key)) is bool]
    if any(item is False for item in booleans):
        return "failure"
    if any(item is True for item in booleans):
        return "success"
    return None


def _parse_rule(value: Any) -> _Rule | None:
    if not isinstance(value, Mapping):
        return None
    family = value.get("family")
    if not isinstance(family, str) or not family.strip() or len(family) > 128:
        return None

    raw_tools = value.get("tools", value.get("tool"))
    if isinstance(raw_tools, str):
        raw_tools = [raw_tools]
    if not isinstance(raw_tools, list) or not raw_tools:
        return None
    tools = tuple(
        pattern.strip()
        for pattern in raw_tools
        if isinstance(pattern, str) and pattern.strip() and len(pattern) <= 256
    )
    if len(tools) != len(raw_tools):
        return None

    operations = _scalar_set(value.get("operations"), strings_only=True)
    if "operations" in value and operations is None:
        return None

    required_args = _scalar_set(value.get("required_args"), strings_only=True)
    if "required_args" in value and required_args is None:
        return None

    raw_filters = value.get("args", {})
    if not isinstance(raw_filters, Mapping):
        return None
    arg_filters: list[tuple[str, frozenset[Any]]] = []
    for key, allowed in raw_filters.items():
        if not isinstance(key, str) or not key or len(key) > 128:
            return None
        values = _scalar_set(allowed)
        if values is None:
            return None
        arg_filters.append((key, values))

    raw_copy = value.get("copy")
    if not isinstance(raw_copy, Mapping):
        return None
    copy: dict[str, str] = {}
    for phase in _PHASES:
        text = raw_copy.get(phase)
        if text is None:
            continue
        # Braces are rejected rather than formatted/neutralised: activity copy
        # must be a constant from validated config, never a dynamic template.
        if (
            not isinstance(text, str)
            or not text.strip()
            or len(text) > 500
            or "{" in text
            or "}" in text
        ):
            return None
        copy[phase] = text.strip()
    if not copy:
        return None

    return _Rule(
        family=family.strip(),
        tools=tools,
        operations=operations,
        required_args=required_args or frozenset(),
        arg_filters=tuple(arg_filters),
        copy=copy,
    )


def _scalar_set(value: Any, *, strings_only: bool = False) -> frozenset[Any] | None:
    if isinstance(value, (str, bool, int, float)):
        value = [value]
    if not isinstance(value, list) or not value:
        return None
    allowed: list[Any] = []
    for item in value:
        if strings_only:
            if not isinstance(item, str) or not item:
                return None
        elif item is not None and not isinstance(item, (str, bool, int, float)):
            return None
        allowed.append(item)
    return frozenset(allowed)


def _is_enabled(value: Any) -> bool:
    if value is True:
        return True
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "on"}
    return False


def _contains(allowed: frozenset[Any], value: Any) -> bool:
    """Fail closed for unhashable or hostile selector values."""
    try:
        return value in allowed
    except (TypeError, ValueError):
        return False
