from types import SimpleNamespace

import pytest

import hermes_cli.auth as auth
import hermes_cli.model_switch as model_switch
import hermes_cli.models as models
import hermes_cli.providers as providers


class _ExhaustedPool:
    def has_credentials(self) -> bool:
        return True

    def has_available(self) -> bool:
        return False


@pytest.fixture(autouse=True)
def _isolated_provider_catalog(monkeypatch):
    monkeypatch.setattr("agent.models_dev.fetch_models_dev", lambda: {})
    monkeypatch.setattr(providers, "HERMES_OVERLAYS", {})
    monkeypatch.setattr(models, "CANONICAL_PROVIDERS", [])
    monkeypatch.setattr(auth, "_load_auth_store", lambda: {})
    monkeypatch.setattr(
        "hermes_cli.models.cached_provider_model_ids",
        lambda _slug, **_kwargs: ["discovered"],
    )


def _api_key_config(env_name: str):
    return SimpleNamespace(api_key_env_vars=(env_name,), auth_type="api_key")


def _row(slug: str, **kwargs):
    rows = model_switch.list_authenticated_providers(
        custom_providers=[],
        max_models=50,
        **kwargs,
    )
    return next((row for row in rows if row["slug"] == slug), None)


def test_overlay_declarations_extend_discovery(monkeypatch):
    monkeypatch.setattr(
        providers,
        "HERMES_OVERLAYS",
        {
            "overlay-test": providers.HermesOverlay(
                auth_type="api_key", extra_env_vars=("OVERLAY_TEST_KEY",)
            )
        },
    )
    monkeypatch.setenv("OVERLAY_TEST_KEY", "test")

    row = _row(
        "overlay-test",
        user_providers={
            "overlay-test": {
                "discover_models": True,
                "models": ["declared-only"],
            }
        },
    )

    assert row is not None
    assert row["models"] == ["declared-only", "discovered"]


def test_overlay_enabled_false_hides_final_row(monkeypatch):
    monkeypatch.setattr(
        providers,
        "HERMES_OVERLAYS",
        {
            "overlay-test": providers.HermesOverlay(
                auth_type="api_key", extra_env_vars=("OVERLAY_TEST_KEY",)
            )
        },
    )
    monkeypatch.setenv("OVERLAY_TEST_KEY", "test")

    row = _row(
        "overlay-test",
        user_providers={"overlay-test": {"enabled": False, "models": ["hidden"]}},
    )

    assert row is None


def test_overlay_discovery_false_empty_list_is_authoritative(monkeypatch):
    monkeypatch.setattr(
        providers,
        "HERMES_OVERLAYS",
        {
            "overlay-test": providers.HermesOverlay(
                auth_type="api_key", extra_env_vars=("OVERLAY_TEST_KEY",)
            )
        },
    )
    monkeypatch.setenv("OVERLAY_TEST_KEY", "test")

    row = _row(
        "overlay-test",
        user_providers={
            "overlay-test": {"discover_models": False, "models": []}
        },
    )

    assert row is not None
    assert row["models"] == []
    assert row["source"] == "user-config"


def test_mapped_declarations_extend_discovery(monkeypatch):
    monkeypatch.setattr(
        "agent.models_dev.PROVIDER_TO_MODELS_DEV", {"mapped-test": "mdev-test"}
    )
    monkeypatch.setattr(
        "agent.models_dev.fetch_models_dev",
        lambda: {"mdev-test": {"env": ["MAPPED_TEST_KEY"]}},
    )
    monkeypatch.setattr(auth, "is_runtime_provider_routable", lambda _slug: True)
    monkeypatch.setenv("MAPPED_TEST_KEY", "test")

    row = _row(
        "mapped-test",
        user_providers={"mapped-test": {"models": ["declared-only"]}},
    )

    assert row is not None
    assert row["models"] == ["declared-only", "discovered"]


def test_canonical_declarations_extend_discovery(monkeypatch):
    monkeypatch.setattr(
        models,
        "CANONICAL_PROVIDERS",
        [SimpleNamespace(slug="canonical-test", label="Canonical Test")],
    )
    monkeypatch.setitem(
        auth.PROVIDER_REGISTRY,
        "canonical-test",
        _api_key_config("CANONICAL_TEST_KEY"),
    )
    monkeypatch.setenv("CANONICAL_TEST_KEY", "test")

    row = _row(
        "canonical-test",
        user_providers={"canonical-test": {"models": ["declared-only"]}},
    )

    assert row is not None
    assert row["models"] == ["declared-only", "discovered"]


@pytest.mark.parametrize("for_picker, expected_visible", [(False, False), (True, True)])
def test_mapped_exhausted_pool_visibility_is_picker_only(
    monkeypatch, for_picker, expected_visible
):
    monkeypatch.setattr(
        "agent.models_dev.PROVIDER_TO_MODELS_DEV", {"mapped-test": "mdev-test"}
    )
    monkeypatch.setattr(
        "agent.models_dev.fetch_models_dev",
        lambda: {"mdev-test": {"env": ["MAPPED_TEST_KEY"]}},
    )
    monkeypatch.setattr(auth, "is_runtime_provider_routable", lambda _slug: True)
    monkeypatch.setattr(
        auth,
        "_load_auth_store",
        lambda: {"credential_pool": {"mapped-test": {"entries": [{"id": "x"}]}}},
    )
    monkeypatch.setattr("agent.credential_pool.load_pool", lambda _slug: _ExhaustedPool())

    row = _row("mapped-test", user_providers={}, for_picker=for_picker)

    assert (row is not None) is expected_visible


@pytest.mark.parametrize("for_picker, expected_visible", [(False, False), (True, True)])
def test_canonical_exhausted_pool_visibility_is_picker_only(
    monkeypatch, for_picker, expected_visible
):
    monkeypatch.setattr(
        models,
        "CANONICAL_PROVIDERS",
        [SimpleNamespace(slug="canonical-test", label="Canonical Test")],
    )
    monkeypatch.setitem(
        auth.PROVIDER_REGISTRY,
        "canonical-test",
        _api_key_config("CANONICAL_TEST_KEY"),
    )
    monkeypatch.setattr("agent.credential_pool.load_pool", lambda _slug: _ExhaustedPool())

    row = _row("canonical-test", user_providers={}, for_picker=for_picker)

    assert (row is not None) is expected_visible
