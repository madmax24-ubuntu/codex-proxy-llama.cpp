import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

import install


class InstallerTests(unittest.TestCase):
    def settings(self, root: Path, profile: str = "qwen") -> install.Settings:
        levels, effort, thinking, budgets = install.profile_defaults(profile)
        usable = 120000
        return install.Settings(
            "http://127.0.0.1:8080", "qwen-test", "Qwen Test", root, "127.0.0.1", 8181,
            120064, usable, install.advertised_for_exact_effective(usable, 95), 95, 113000,
            profile, "Russian", effort, levels, thinking, budgets, ["text"],
        )

    def test_exact_effective_context(self):
        advertised = install.advertised_for_exact_effective(120000, 95)
        self.assertEqual(advertised, 126316)
        self.assertEqual(advertised * 95 // 100, 120000)

    def test_upstream_normalization(self):
        self.assertEqual(install.normalize_upstream("http://localhost:8080/v1/"), "http://localhost:8080")
        with self.assertRaises(ValueError):
            install.normalize_upstream("http://localhost:8080/custom/path")

    def test_catalog_has_native_apply_patch(self):
        with tempfile.TemporaryDirectory() as temp:
            catalog = json.loads(install.render_catalog(self.settings(Path(temp))))
        model = catalog["models"][0]
        self.assertEqual(model["apply_patch_tool_type"], "freeform")
        self.assertEqual(model["effective_context_window_percent"], 95)
        self.assertEqual(model["supported_reasoning_levels"][-1]["effort"], "xhigh")

    def test_install_and_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "codex-home"
            settings = self.settings(root)
            files = install.write_install(settings, False, False)
            self.assertEqual(len(files), 8)
            self.assertTrue((root / "proxy.js").exists())
            self.assertIn("model_provider", (root / "config.toml").read_text(encoding="utf-8"))
            install.write_install(settings, True, False)
            self.assertTrue(list(root.glob("config.toml.backup-*")))

    def test_offline_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            args = Namespace(
                upstream="http://127.0.0.1:8080", model="offline-model", display_name=None,
                codex_home=temp, proxy_host="127.0.0.1", proxy_port=18181, context_window=32768,
                usable_context=32000, effective_percent=95, auto_compact=24000, profile="generic",
                language="", non_interactive=True, skip_probe=True, force=False, dry_run=True,
                vision=False,
            )
            settings = install.build_settings(args)
        self.assertEqual(settings.model, "offline-model")
        self.assertEqual(settings.usable_context, 32000)
        self.assertEqual(settings.input_modalities, ["text"])


if __name__ == "__main__":
    unittest.main()
