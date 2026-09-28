from scripts.bundles.desktop import stage_packaging_icons


def test_refocus_uses_checked_in_packaging_icons_after_windows_regeneration(tmp_path):
    repo = tmp_path / "repo"
    desktop = repo / "apps/desktop"
    tracked = desktop / "assets"
    generated = repo / "apps/desktop/build/products/icons/apps/desktop/assets"
    (tracked / "appx").mkdir(parents=True)
    (generated / "appx").mkdir(parents=True)

    # Model Windows icon rendering that differs from the admitted checkout.
    (tracked / "icon.ico").write_bytes(b"checked-in icon")
    (tracked / "appx/Square44x44Logo.png").write_bytes(b"checked-in appx")
    (generated / "icon.ico").write_bytes(b"windows-rendered icon")
    (generated / "appx/Square44x44Logo.png").write_bytes(b"windows-rendered appx")

    stage_packaging_icons(repo / "apps/desktop/build/products/icons", desktop, "refocus")

    assert (tracked / "icon.ico").read_bytes() == b"checked-in icon"
    assert (tracked / "appx/Square44x44Logo.png").read_bytes() == b"checked-in appx"


def test_non_refocus_packaging_keeps_generated_icon_copy(tmp_path):
    desktop = tmp_path / "apps/desktop"
    generated = tmp_path / "products/icons/apps/desktop/assets"
    (generated / "appx").mkdir(parents=True)
    (generated / "icon.ico").write_bytes(b"generated icon")
    (generated / "appx/Square44x44Logo.png").write_bytes(b"generated appx")

    stage_packaging_icons(tmp_path / "products/icons", desktop, "bundled")

    assert (desktop / "assets/icon.ico").read_bytes() == b"generated icon"
    assert (desktop / "assets/appx/Square44x44Logo.png").read_bytes() == b"generated appx"
