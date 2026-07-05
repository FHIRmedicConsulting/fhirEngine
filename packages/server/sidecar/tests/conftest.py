import os
import sys

import pytest

# Make the sidecar module importable (it lives one dir up).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import delta_sidecar as ds  # noqa: E402


@pytest.fixture(autouse=True)
def _confine_base(tmp_path, monkeypatch):
    """Point the store base at each test's tmp_path so `_confine` (path-traversal guard,
    which requires every table_path to live under _BASE) accepts the test tables — mirroring
    a real deployment where all paths sit under the configured --base."""
    monkeypatch.setattr(ds, "_BASE", str(tmp_path))
