"""Validation against the generated JSON Schema contracts (packages/contracts)."""

from __future__ import annotations

import json
from functools import cache
from importlib.resources import files
from typing import Any

from jsonschema import Draft202012Validator, ValidationError


class ContractViolation(ValueError):
    """A message broke its contract. Carries only the contract name and the
    failing path, never the values: claims hold signed URLs and capabilities."""


@cache
def _validator(name: str) -> Draft202012Validator:
    schema = json.loads(files("bowr_worker.contracts").joinpath(f"{name}.schema.json").read_text())
    return Draft202012Validator(schema)


def validate(name: str, value: Any) -> None:
    """Raises ContractViolation when ``value`` breaks the named contract."""
    try:
        _validator(name).validate(value)
    except ValidationError as error:
        raise ContractViolation(f"{name}: {error.json_path} ({error.validator})") from None
