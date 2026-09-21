"""Validation and conversion helpers for monetary values.

Money is always represented as :class:`decimal.Decimal` quantized to two
decimal places. Binary floats are rejected as *storage* types because they
cannot represent values such as ``0.10`` exactly; floats are still accepted as
*input* and converted through ``str`` so ``10.5`` becomes ``Decimal("10.50")``.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from .exceptions import InvalidAmountError

CENT = Decimal("0.01")
ZERO = Decimal("0.00")
ONE = Decimal("1")


def parse_decimal(value: Any, name: str = "amount") -> Decimal:
    """Convert ``value`` to a finite :class:`Decimal` or raise.

    Booleans are rejected explicitly because ``bool`` is a subclass of ``int``
    and ``True`` would otherwise silently become ``1``.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise InvalidAmountError(
            f"{name} must be a number, got {type(value).__name__}"
        )
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise InvalidAmountError(f"{name} {value!r} is not a valid number") from None
    if not number.is_finite():
        raise InvalidAmountError(f"{name} must be finite, got {value!r}")
    return number


def to_money(
    value: Any,
    name: str = "amount",
    *,
    allow_zero: bool = False,
    allow_negative: bool = False,
) -> Decimal:
    """Validate ``value`` as a money amount with at most two decimal places."""
    number = parse_decimal(value, name)
    try:
        quantized = number.quantize(CENT)
    except InvalidOperation:
        raise InvalidAmountError(f"{name} {value!r} is too large") from None
    if number != quantized:
        raise InvalidAmountError(
            f"{name} cannot have more than 2 decimal places, got {value!r}"
        )
    if quantized < 0 and not allow_negative:
        raise InvalidAmountError(f"{name} cannot be negative, got {value!r}")
    if quantized == 0 and not allow_zero:
        raise InvalidAmountError(f"{name} must be greater than zero")
    return quantized


def to_rate(value: Any, name: str = "rate") -> Decimal:
    """Validate ``value`` as a fractional rate between 0 and 1 inclusive."""
    rate = parse_decimal(value, name)
    if not (ZERO <= rate <= ONE):
        raise InvalidAmountError(f"{name} must be between 0 and 1, got {value!r}")
    return rate
