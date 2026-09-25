"""Validation against the generated JSON Schema contracts (packages/contracts)."""

from __future__ import annotations

import json
from functools import cache
from importlib.resources import files
from typing import Any

from jsonschema import Draft202012Validator


@cache
def _validator(name: str) -> Draft202012Validator:
    schema = json.loads(files("bowr_worker.contracts").joinpath(f"{name}.schema.json").read_text())
    return Draft202012Validator(schema)


def validate(name: str, value: Any) -> None:
    """Raises jsonschema.ValidationError when ``value`` breaks the named contract."""
    _validator(name).validate(value)
