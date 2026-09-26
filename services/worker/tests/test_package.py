import sys

import bowr_worker


def test_runs_on_pinned_python() -> None:
    assert sys.version_info[:2] == (3, 12)
    assert bowr_worker.__version__ == "0.0.0"
