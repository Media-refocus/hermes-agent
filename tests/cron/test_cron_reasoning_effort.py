from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

import pytest


fire_mod = types.ModuleType("fire")
setattr(fire_mod, "Fire", lambda *a, **k: None)
sys.modules.setdefault("fire", fire_mod)
sys.modules.setdefault("firecrawl", types.ModuleType("firecrawl"))
sys.modules.setdefault("fal_client", types.ModuleType("fal_client"))


@pytest.fixture
def hermes_env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    (home / "cron").mkdir()
    (home / "config.yaml").write_text(
        "model:\n  default: glm-5.1\n  provider: zai\nagent:\n  reasoning_effort: low\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))

    import hermes_constants
    import cron.jobs
    import cron.scheduler
    import tools.cronjob_tools

    importlib.reload(hermes_constants)
    importlib.reload(cron.jobs)
    importlib.reload(cron.scheduler)
    importlib.reload(tools.cronjob_tools)
    return home


class _CapturingAgent:
    last_init = {}

    def __init__(self, *args, **kwargs):
        type(self).last_init = dict(kwargs)

    def chat(self, message):
        return "ok"

    def run_conversation(self, message):
        return {"final_response": "ok"}


def test_create_job_stores_per_job_reasoning_effort(hermes_env):
    from cron.jobs import create_job, get_job

    job = create_job(
        prompt="review governance",
        schedule="every 1h",
        deliver="local",
        reasoning_effort="medium",
    )

    assert job["reasoning_effort"] == "medium"
    assert get_job(job["id"])["reasoning_effort"] == "medium"


def test_create_job_rejects_invalid_reasoning_effort(hermes_env):
    from cron.jobs import create_job

    with pytest.raises(ValueError, match="Invalid reasoning_effort"):
        create_job(
            prompt="review governance",
            schedule="every 1h",
            deliver="local",
            reasoning_effort="definitely-invalid",
        )


def test_cronjob_tool_create_and_update_roundtrip_reasoning_effort(hermes_env):
    from tools.cronjob_tools import cronjob

    created = json.loads(
        cronjob(
            action="create",
            schedule="every 1h",
            prompt="review governance",
            deliver="local",
            reasoning_effort="medium",
        )
    )
    assert created["success"] is True
    assert created["job"]["reasoning_effort"] == "medium"

    updated = json.loads(
        cronjob(action="update", job_id=created["job_id"], reasoning_effort="high")
    )
    assert updated["success"] is True
    assert updated["job"]["reasoning_effort"] == "high"


def test_run_job_prefers_per_job_reasoning_effort_over_profile_default(hermes_env, monkeypatch):
    import cron.scheduler as scheduler
    import run_agent

    monkeypatch.setattr(run_agent, "AIAgent", _CapturingAgent)
    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        lambda requested=None, explicit_base_url=None, explicit_api_key=None: {
            "provider": requested or "zai",
            "api_mode": "chat_completions",
            "base_url": "https://example.invalid/v1",
            "api_key": "test-token",
        },
    )
    monkeypatch.setattr("tools.mcp_tool.discover_mcp_tools", lambda: [])

    success, _output, final_response, error = scheduler.run_job(
        {
            "id": "job-reasoning",
            "name": "Reasoning Override",
            "prompt": "ping",
            "model": "gpt-5.5",
            "provider": "openai-codex",
            "reasoning_effort": "medium",
            "deliver": "local",
        }
    )

    assert success is True
    assert error is None
    assert final_response == "ok"
    assert _CapturingAgent.last_init["reasoning_config"] == {"enabled": True, "effort": "medium"}
