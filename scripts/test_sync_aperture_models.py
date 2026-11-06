#!/usr/bin/env python3
"""Regression tests for the Aperture model catalog sync."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "sync_aperture", Path(__file__).with_name("sync-aperture-models.py")
)
assert spec is not None and spec.loader is not None
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def model(model_id, endpoint):
    return {
        "id": model_id,
        "display_name": model_id,
        "supported_endpoints": [endpoint],
        "context_window_tokens": 1000000,
        "max_output_tokens": 128000,
        "pricing": {"input": 0.000002, "output": 0.00001},
    }


class TerraConfigTests(unittest.TestCase):
    def test_terra_declares_the_verified_responses_thinking_levels(self):
        config = json.loads((Path(__file__).resolve().parent.parent / "config/models.json").read_text())
        model = next(m for m in config["providers"]["openai"]["models"]
                     if m["id"] == "gpt-6.1-terra")
        self.assertTrue(model.get("reasoning"))
        self.assertEqual(model.get("thinkingLevelMap"), {
            "minimal": None, "xhigh": "xhigh", "max": "max"})
        refreshed = sync.build_entry({"id": model["id"]}, model)
        self.assertEqual(refreshed["thinkingLevelMap"], model["thinkingLevelMap"])
        self.assertTrue(refreshed["reasoning"])


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "models.json"
        self.doc = {"providers": {
            "anthropic": {"baseUrl": "http://example/v1", "api": "anthropic-messages",
                          "apiKey": "test", "models": [
                              {"id": "us.anthropic.claude-sonnet-5-5",
                               "reasoning": True, "input": ["text", "image"],
                               "compat": {"forceAdaptiveThinking": True}}]},
            "openai": {"baseUrl": "http://example/v1", "api": "openai-responses",
                       "apiKey": "test", "models": [{"id": "gpt-old"}]},
            "other": {"models": [{"id": "local"}]},
        }}
        self.path.write_text(json.dumps(self.doc))
        self.catalog = [model("claude-sonnet-5-5", "/v1/messages"),
                        model("gpt-new", "/v1/responses")]

    def run_sync(self, *args):
        output = io.StringIO()
        with patch.object(sync, "MODELS_JSON", self.path), \
             patch.object(sync, "REPO", self.path.parent), \
             patch.object(sync, "fetch", return_value=self.catalog), \
             patch.object(sys, "argv", ["sync", *args]), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            rc = sync.main()
        return rc, output.getvalue()

    def test_syncs_revised_providers_and_preserves_migrated_fields(self):
        rc, _ = self.run_sync()
        self.assertEqual(rc, 0)
        doc = json.loads(self.path.read_text())
        anth = doc["providers"]["anthropic"]["models"]
        self.assertEqual([m["id"] for m in anth], ["claude-sonnet-5-5"])
        self.assertTrue(anth[0]["reasoning"])
        self.assertEqual(anth[0]["input"], ["text", "image"])
        self.assertTrue(anth[0]["compat"]["forceAdaptiveThinking"])
        self.assertEqual(doc["providers"]["openai"]["models"][0]["id"], "gpt-new")
        self.assertEqual(doc["providers"]["other"], self.doc["providers"]["other"])

    def test_check_reports_removal_and_does_not_write(self):
        self.catalog = [model("us.anthropic.claude-sonnet-5-5", "/v1/messages")]
        before = self.path.read_bytes()
        rc, output = self.run_sync("--check")
        self.assertNotEqual(rc, 0)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertIn("openai", output)

    def test_removed_model_is_drift_even_with_other_models_present(self):
        self.assertEqual(self.run_sync()[0], 0)
        doc = json.loads(self.path.read_text())
        doc["providers"]["openai"]["models"].append({"id": "gpt-old"})
        self.path.write_text(json.dumps(doc))
        rc, output = self.run_sync("--check")
        self.assertNotEqual(rc, 0)
        self.assertIn("gpt-old", output)

    def test_zero_matches_refuses_to_write(self):
        self.catalog = [model("gpt-new", "/v1/responses")]
        before = self.path.read_bytes()
        rc, output = self.run_sync()
        self.assertNotEqual(rc, 0)
        self.assertIn("anthropic", output)
        self.assertEqual(self.path.read_bytes(), before)

    def test_versioned_bedrock_alias_preserves_explicit_false(self):
        entry = {"id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
                 "reasoning": False}
        self.assertEqual(sync.previous_entry("claude-haiku-4-5", {entry["id"]: entry}), entry)
        self.assertIs(sync.build_entry(model("claude-haiku-4-5", "/v1/messages"), entry)["reasoning"], False)


if __name__ == "__main__":
    unittest.main()
